use crate::{core::Core, store::Store, terminal};
use portable_pty::CommandBuilder;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn fixture() -> (tempfile::TempDir, Arc<Mutex<Core>>, String) {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.register_folder("Проект", temp.path(), None).unwrap();
    let workspace = store.snapshot().unwrap().workspaces[0].id.clone();
    (
        temp,
        Arc::new(Mutex::new(Core {
            store,
            processes: Default::default(),
        })),
        workspace,
    )
}

fn shell(core: &Arc<Mutex<Core>>, workspace: &str) -> terminal::TerminalInfo {
    let mut command = CommandBuilder::new("/bin/sh");
    command.arg("-i");
    terminal::start_command(core, workspace, command, terminal::size(80, 24).unwrap()).unwrap()
}

#[test]
fn deleting_terminal_removes_only_its_process_and_preserves_the_other_split_panel() {
    let (temp, core, workspace) = fixture();
    let first = shell(&core, &workspace);
    let second = shell(&core, &workspace);
    let mut view = core.lock().unwrap().store.snapshot().unwrap().view;
    let tab_id = format!("terminal:{}", first.id);
    view.tabs.push(crate::model::Tab {
        id: tab_id.clone(),
        workspace_id: workspace.clone(),
        session_id: None,
    });
    view.active_tabs.insert(workspace.clone(), tab_id);
    core.lock().unwrap().save_view(&view).unwrap();
    assert!(terminal::delete(&core, &workspace, &first.id, None, false).is_err());

    terminal::write(&core, &workspace, &first.id, "exit 0\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frame = terminal::read(&core, &workspace, &first.id).unwrap();
        if frame.output_done && frame.info.state == "completed" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "оболочка не завершилась: {:?}",
            frame.info.state
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let updated = terminal::delete(&core, &workspace, &first.id, Some(&second.id), false).unwrap();
    assert_eq!(updated.tabs[0].id, format!("terminal:{}", second.id));
    assert_eq!(updated.active_tabs[&workspace], updated.tabs[0].id);
    assert!(terminal::read(&core, &workspace, &first.id).is_err());
    assert_eq!(terminal::list(&core, &workspace).unwrap()[0].id, second.id);
    assert!(core.lock().unwrap().processes.contains(&second.id));

    let updated = terminal::delete(&core, &workspace, &second.id, None, true).unwrap();
    assert!(updated.tabs.is_empty());
    assert!(updated.active_tabs.is_empty());
    assert!(terminal::list(&core, &workspace).unwrap().is_empty());
    assert!(!core.lock().unwrap().processes.contains(&second.id));
    let store = Store::open(&temp.path().join("state.db")).unwrap();
    assert_eq!(store.snapshot().unwrap().view, updated);
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM processes", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn terminal_stream_checks_workspace_without_reading_application_view() {
    let (_temp, core, workspace) = fixture();
    let info = shell(&core, &workspace);
    let other = tempfile::tempdir().unwrap();
    let other_workspace = {
        let mut core = core.lock().unwrap();
        core.store
            .register_folder("Другой проект", other.path(), None)
            .unwrap();
        let other_workspace = core
            .store
            .snapshot()
            .unwrap()
            .workspaces
            .into_iter()
            .find(|w| w.id != workspace)
            .unwrap()
            .id;
        core.store.connection.execute(
            "INSERT INTO view_state(id,value) VALUES(1,'[]') ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            [],
        ).unwrap();
        other_workspace
    };
    assert!(terminal::read(&core, &workspace, &info.id).is_ok());
    terminal::write(&core, &workspace, &info.id, "printf stream-ok\n").unwrap();
    until(&core, &workspace, &info.id, "stream-ok");
    for id in [&other_workspace, &"missing".to_string()] {
        assert!(terminal::read(&core, id, &info.id).is_err());
        assert!(terminal::write(&core, id, &info.id, "ignored").is_err());
        assert!(terminal::wait(&core, id, &info.id).is_err());
    }
    core.lock()
        .unwrap()
        .store
        .connection
        .execute("UPDATE workspaces SET deleted=1 WHERE id=?1", [&workspace])
        .unwrap();
    assert!(terminal::read(&core, &workspace, &info.id).is_err());
    assert!(terminal::write(&core, &workspace, &info.id, "ignored").is_err());
    assert!(terminal::wait(&core, &workspace, &info.id).is_err());
    {
        let core = core.lock().unwrap();
        core.store
            .connection
            .execute("UPDATE workspaces SET deleted=0 WHERE id=?1", [&workspace])
            .unwrap();
        core.store
            .connection
            .execute("DELETE FROM view_state", [])
            .unwrap();
    }
    terminal::stop(&core, &workspace, &info.id).unwrap();
}

#[test]
fn output_wait_wakes_without_consuming_bytes_or_blocking_other_commands() {
    for stop in [false, true] {
        let (_temp, core, workspace) = fixture();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "stty raw -echo; printf ready; while IFS= read -r value; do [ \"$value\" = exit ] && exit 0; printf '%s' \"$value\"; done"]);
        let info =
            terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
                .unwrap();
        until(&core, &workspace, &info.id, "ready");
        assert!(terminal::wait(&core, "missing", &info.id).is_err());

        let wait = || {
            let core = core.clone();
            let workspace = workspace.clone();
            let id = info.id.clone();
            let (send, receive) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                send.send(terminal::wait(&core, &workspace, &id)).unwrap()
            });
            (reader, receive)
        };
        let (reader, receive) = wait();
        assert!(receive.recv_timeout(Duration::from_millis(30)).is_err());
        let started = Instant::now();
        terminal::resize(&core, &workspace, &info.id, 100, 30).unwrap();
        terminal::write(&core, &workspace, &info.id, "вывод🙂\n").unwrap();
        receive
            .recv_timeout(Duration::from_millis(300))
            .unwrap()
            .unwrap();
        reader.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(300));
        assert_eq!(until(&core, &workspace, &info.id, "вывод🙂"), "вывод🙂");

        terminal::write(&core, &workspace, &info.id, "заранее\n").unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        terminal::wait(&core, &workspace, &info.id).unwrap();
        assert!(started.elapsed() < Duration::from_millis(300));
        assert_eq!(until(&core, &workspace, &info.id, "заранее"), "заранее");

        let (reader, receive) = wait();
        assert!(receive.recv_timeout(Duration::from_millis(30)).is_err());
        if stop {
            terminal::stop(&core, &workspace, &info.id).unwrap();
        } else {
            terminal::write(&core, &workspace, &info.id, "exit\n").unwrap();
        }
        receive
            .recv_timeout(Duration::from_millis(300))
            .unwrap()
            .unwrap();
        reader.join().unwrap();
        assert_eq!(
            finished(&core, &workspace, &info.id).info.state,
            if stop { "stopped" } else { "completed" }
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_editor_preserves_configuration_history_multiline_and_command_status() {
    let (temp, core, workspace) = fixture();
    std::fs::write(
        temp.path().join(".zshenv"),
        "export YADE_FIXTURE_ENV=loaded\n",
    )
    .unwrap();
    std::fs::write(temp.path().join(".zshrc"), "HISTFILE=$HOME/history\nHISTSIZE=1000\nSAVEHIST=1000\nbindkey -e\nalias fixture_alias='printf alias-ok'\n").unwrap();
    std::fs::write(
        temp.path().join("history"),
        "printf '%s-%s' from-existing history\n",
    )
    .unwrap();
    let mut command = CommandBuilder::new("/bin/zsh");
    command.args(["-l", "-i"]);
    command.env("HOME", temp.path());
    command.env("ZDOTDIR", temp.path());
    command.env("TERM_PROGRAM", "Yade");
    let info = terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
        .unwrap();
    let token = info.shell_token.as_ref().unwrap();
    until(&core, &workspace, &info.id, &format!("{token};B"));
    let context = terminal::shell_context(&core, &workspace, &info.id).unwrap();
    assert_eq!(
        context.cwd,
        temp.path().canonicalize().unwrap().to_string_lossy()
    );
    terminal::write(&core, &workspace, &info.id, "\x12from-existing").unwrap();
    let search = until(&core, &workspace, &info.id, "bck-i-search");
    assert!(!search.contains(&format!("{token};C;")));
    terminal::write(&core, &workspace, &info.id, "\r").unwrap();
    let output = until(&core, &workspace, &info.id, &format!("{token};B"));
    assert!(output.contains("from-existing-history"));
    terminal::submit(
        &core,
        &workspace,
        &info.id,
        "printf '%s\\n' \"$YADE_FIXTURE_ENV\"\nfixture_alias\nfalse",
    )
    .unwrap();
    let output = until(&core, &workspace, &info.id, &format!("{token};B"));
    assert!(output.contains("loaded"));
    assert!(output.contains("alias-ok"));
    assert_eq!(output.matches(&format!("{token};C;")).count(), 1);
    let context = terminal::shell_context(&core, &workspace, &info.id).unwrap();
    assert!(context.command.contains("fixture_alias"));
    terminal::write(&core, &workspace, &info.id, "\x12fixture_alias\r").unwrap();
    let output = until(&core, &workspace, &info.id, &format!("{token};B"));
    assert!(output.contains("alias-ok"));
    assert!(output.contains(&format!("{token};P;1")));
    assert!(terminal::shell_context(&core, "missing", &info.id).is_err());
    assert!(terminal::submit(&core, &workspace, &info.id, "echo \x1b[99~").is_err());
    terminal::submit(&core, &workspace, &info.id, "echo &&&").unwrap();
    let failed = until(&core, &workspace, &info.id, &format!("{token};P;1"));
    assert!(failed.contains(&format!("{token};S;")));
    assert!(failed.contains("parse error"));
    std::fs::create_dir(temp.path().join("with spaces")).unwrap();
    terminal::submit(&core, &workspace, &info.id, "cd 'with spaces'").unwrap();
    until(&core, &workspace, &info.id, &format!("{token};P;0"));
    assert!(terminal::shell_context(&core, &workspace, &info.id)
        .unwrap()
        .cwd
        .ends_with("with spaces"));
    terminal::submit(
        &core,
        &workspace,
        &info.id,
        "read 'answer?Answer: '; printf 'answer:%s' \"$answer\"",
    )
    .unwrap();
    until(&core, &workspace, &info.id, "Answer:");
    assert!(terminal::submit(&core, &workspace, &info.id, "echo should-not-run").is_err());
    terminal::write(&core, &workspace, &info.id, "yes\n").unwrap();
    assert!(until(&core, &workspace, &info.id, &format!("{token};P;0")).contains("answer:yes"));
    terminal::submit(&core, &workspace, &info.id, "sleep 30").unwrap();
    until(&core, &workspace, &info.id, &format!("{token};C"));
    terminal::interrupt(&core, &workspace, &info.id).unwrap();
    until(&core, &workspace, &info.id, &format!("{token};P;130"));
    terminal::submit(&core, &workspace, &info.id, "exit 0").unwrap();
    assert_eq!(
        finished(&core, &workspace, &info.id).info.state,
        "completed"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_editor_suggests_commands_from_the_default_user_history() {
    let (temp, core, workspace) = fixture();
    let config = temp.path().join("zsh config");
    std::fs::create_dir(&config).unwrap();
    std::fs::write(config.join(".zsh_history"), "a service fixture\n").unwrap();
    std::fs::write(
        config.join(".zshrc"),
        r#"zmodload zsh/parameter
fixture_fetch() {
  local match=${history[(r)${BUFFER}*]}
  POSTDISPLAY=${match#$BUFFER}
}
zle -N autosuggest-fetch fixture_fetch
"#,
    )
    .unwrap();
    let mut command = CommandBuilder::new("/bin/zsh");
    command.args(["-l", "-i"]);
    command.env("HOME", temp.path());
    command.env("ZDOTDIR", &config);
    let info = terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
        .unwrap();
    let token = info.shell_token.as_ref().unwrap();
    until(&core, &workspace, &info.id, &format!("{token};B"));
    let edited = terminal::edit(&core, &workspace, &info.id, "a ser", 5, 1, "change").unwrap();
    assert_eq!(edited.suggestion, "vice fixture");
    terminal::submit(&core, &workspace, &info.id, "exit 0").unwrap();
    finished(&core, &workspace, &info.id);
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_native_editor_preserves_user_completion_history_and_multiline_paste() {
    let (temp, core, workspace) = fixture();
    std::fs::write(temp.path().join(".zshrc"), "HISTFILE=$HOME/history\nHISTSIZE=1000\nSAVEHIST=1000\nbindkey -e\nbindkey '^[[A' up-line-or-history\nfixture_complete() { LBUFFER+='from-zsh-widget'; }\nzle -N fixture_complete\nbindkey '^I' fixture_complete\n").unwrap();
    let mut command = CommandBuilder::new("/bin/zsh");
    command.args(["-l", "-i"]);
    command.env("HOME", temp.path());
    command.env("ZDOTDIR", temp.path());
    let info = terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
        .unwrap();
    let token = info.shell_token.as_ref().unwrap();
    until(&core, &workspace, &info.id, &format!("{token};B"));
    let draft = "printf 'выделение 🐈'";
    let edited = terminal::edit(&core, &workspace, &info.id, draft, 8, 1, "change").unwrap();
    assert_eq!(edited.command, draft);
    assert_eq!(edited.cursor, 8);
    assert!(edited.command_known);
    terminal::submit(
        &core,
        &workspace,
        &info.id,
        "alias fixture_alias='printf alias-ok'; fixture_function() { printf function-ok; }",
    )
    .unwrap();
    until(&core, &workspace, &info.id, &format!("{token};B"));
    for (index, (command, known)) in [
        ("fixture_alias", true),
        ("fixture_function", true),
        ("codfdsfasf", false),
        ("\"unfinished", false),
        ("$(printf should-not-run)", false),
        ("", false),
    ]
    .iter()
    .enumerate()
    {
        let edited = terminal::edit(
            &core,
            &workspace,
            &info.id,
            command,
            command.chars().count(),
            100 + index as u64,
            "change",
        )
        .unwrap();
        assert_eq!(edited.command_known, *known, "{command}");
    }
    let edited = terminal::edit(
        &core,
        &workspace,
        &info.id,
        "printf tab-",
        11,
        2,
        "complete",
    )
    .unwrap();
    assert_eq!(edited.command, "printf tab-from-zsh-widget");
    assert!(terminal::edit(&core, &workspace, &info.id, "echo \x1b[99~", 0, 3, "change").is_err());
    assert!(terminal::edit(&core, &workspace, &info.id, "echo", 99, 3, "change").is_err());
    assert!(terminal::edit(&core, &workspace, &info.id, "echo", 0, 3, "execute").is_err());
    assert!(terminal::shell_context(&core, &workspace, &info.id)
        .unwrap()
        .command
        .contains("fixture_function"));
    terminal::restore(&core, &workspace, &info.id, "printf tab-").unwrap();
    until(&core, &workspace, &info.id, "tab-");
    terminal::write(&core, &workspace, &info.id, "\t").unwrap();
    let editing = until(&core, &workspace, &info.id, "from-zsh-widget");
    assert!(!editing.contains(&format!("{token};S;")));
    assert!(!editing.contains(&format!("{token};C;")));
    terminal::write(&core, &workspace, &info.id, "\r").unwrap();
    let output = until(&core, &workspace, &info.id, &format!("{token};P;0"));
    assert!(output.contains("tab-from-zsh-widget"));
    assert_eq!(
        terminal::shell_context(&core, &workspace, &info.id)
            .unwrap()
            .command,
        "printf tab-from-zsh-widget"
    );

    let pasted = "printf paste-first\nprintf paste-second";
    terminal::write(
        &core,
        &workspace,
        &info.id,
        &format!("\x1b[200~{pasted}\x1b[201~"),
    )
    .unwrap();
    let editing = until(&core, &workspace, &info.id, "paste-second");
    assert!(!editing.contains(&format!("{token};S;")));
    assert!(!editing.contains(&format!("{token};C;")));
    terminal::write(&core, &workspace, &info.id, "\r").unwrap();
    let output = until(&core, &workspace, &info.id, &format!("{token};P;0"));
    assert_eq!(output.matches(&format!("{token};C;")).count(), 1);
    assert!(output.contains("paste-firstpaste-second"));
    assert_eq!(
        terminal::shell_context(&core, &workspace, &info.id)
            .unwrap()
            .command,
        pasted
    );

    terminal::restore(&core, &workspace, &info.id, "printf shift-first").unwrap();
    until(&core, &workspace, &info.id, "shift-first");
    terminal::write(&core, &workspace, &info.id, "\x1b[13;2uprintf shift-second").unwrap();
    let editing = until(&core, &workspace, &info.id, "shift-second");
    assert!(!editing.contains(&format!("{token};C;")));
    terminal::write(&core, &workspace, &info.id, "\r").unwrap();
    let output = until(&core, &workspace, &info.id, &format!("{token};P;0"));
    assert_eq!(output.matches(&format!("{token};C;")).count(), 1);
    assert!(output.contains("shift-firstshift-second"));
    terminal::write(&core, &workspace, &info.id, "\x1b[A").unwrap();
    until(&core, &workspace, &info.id, "shift-second");
    terminal::write(&core, &workspace, &info.id, "\r").unwrap();
    assert!(until(&core, &workspace, &info.id, &format!("{token};P;0"))
        .contains("shift-firstshift-second"));
    terminal::submit(&core, &workspace, &info.id, "exit 0").unwrap();
    finished(&core, &workspace, &info.id);
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_primary_prompt_does_not_leak_after_the_editor_ready_marker() {
    let (temp, core, workspace) = fixture();
    std::fs::write(temp.path().join(".zshrc"), "PROMPT='native-left-prompt> '\nRPROMPT='native-right-prompt'\nfixture_theme() {\n  PROMPT='native-left-prompt %~> '\n  printf 'loading-theme\\n'\n  while [[ ! -e $HOME/theme-ready ]]; do sleep .02; done\n}\nprecmd_functions+=(fixture_theme)\n").unwrap();
    let mut command = CommandBuilder::new("/bin/zsh");
    command.args(["-l", "-i"]);
    command.env("HOME", temp.path());
    command.env("ZDOTDIR", temp.path());
    command.env("TERM_PROGRAM", "Yade");
    let info = terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
        .unwrap();
    let marker = format!("{};B\x07", info.shell_token.as_ref().unwrap());
    until(&core, &workspace, &info.id, "loading-theme");
    assert!(!terminal::read(&core, &workspace, &info.id).unwrap().shell_started);
    std::fs::write(temp.path().join("theme-ready"), "").unwrap();
    let initial = until(&core, &workspace, &info.id, &marker);
    let mut output = initial.split_once(&marker).unwrap().1.as_bytes().to_vec();
    terminal::resize(&core, &workspace, &info.id, 120, 30).unwrap();
    let deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < deadline {
        let frame = terminal::read(&core, &workspace, &info.id).unwrap();
        output.extend(frame.data);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(terminal::read(&core, &workspace, &info.id).unwrap().shell_started);
    terminal::write(&core, &workspace, &info.id, "exit 0\n").unwrap();
    finished(&core, &workspace, &info.id);
    let text = String::from_utf8_lossy(&output);
    assert!(
        !text.contains("native-left-prompt"),
        "приглашение осталось после готовности редактора: {text:?}"
    );
    assert!(
        !text.contains("native-right-prompt"),
        "правое приглашение осталось после готовности редактора: {text:?}"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_disabled_startup_files_preserve_the_users_configuration_directory() {
    assert_zsh_ready_without_editor(".zshenv", "unsetopt rcs\n");
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_disabled_line_editor_still_reports_readiness() {
    assert_zsh_ready_without_editor(".zshrc", "unsetopt zle\n");
}

#[cfg(target_os = "macos")]
fn assert_zsh_ready_without_editor(file: &str, contents: &str) {
    let (temp, core, workspace) = fixture();
    std::fs::write(temp.path().join(file), contents).unwrap();
    let mut command = CommandBuilder::new("/bin/zsh");
    command.args(["-l", "-i"]);
    command.env("HOME", temp.path());
    command.env("ZDOTDIR", temp.path());
    command.env("TERM_PROGRAM", "Yade");
    let info = terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
        .unwrap();
    let marker = format!("{};B\x07", info.shell_token.as_ref().unwrap());
    until(&core, &workspace, &info.id, &marker);
    terminal::write(
        &core,
        &workspace,
        &info.id,
        "printf 'directory:%s\\n' \"$ZDOTDIR\"\n",
    )
    .unwrap();
    until(
        &core,
        &workspace,
        &info.id,
        &format!("directory:{}", temp.path().display()),
    );
    terminal::write(&core, &workspace, &info.id, "exit 0\n").unwrap();
    assert_eq!(
        finished(&core, &workspace, &info.id).info.state,
        "completed"
    );
}

#[cfg(unix)]
#[test]
fn terminal_observation_follows_arbitrary_aliases_without_consuming_output() {
    let (temp, core, workspace) = fixture();
    let info = shell(&core, &workspace);
    for executor in ["codex", "claude"] {
        // Настоящий процесс с нужным именем, без авторизации и сетевых запросов.
        let executable = temp.path().join(executor);
        let compiled = std::process::Command::new("cc")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("test-fixtures/terminal-screen.c"),
            )
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        terminal::write(
            &core,
            &workspace,
            &info.id,
            &format!(
                "alias arbitrary_user_name='{}'; printf 'alias:%s\\n' ready\n",
                executable.display(),
            ),
        )
        .unwrap();
        until(&core, &workspace, &info.id, "alias:ready");
        terminal::write(
            &core,
            &workspace,
            &info.id,
            "stty -echo; arbitrary_user_name\n",
        )
        .unwrap();
        wait_execution(&core, "unknown");
        let (ready, marker) = if executor == "codex" {
            (
                "\x1b[H\x1b[2JOpenAI Codex\r\n› Ask Codex to do anything\n",
                "› Ask Codex to do anything",
            )
        } else {
            ("\x1b[H\x1b[2J\x1b]0;✳ Example\x07\n", "✳ Example")
        };
        terminal::write(&core, &workspace, &info.id, ready).unwrap();
        until(&core, &workspace, &info.id, marker);
        wait_execution(&core, "ready");
        terminal::write(&core, &workspace, &info.id, "\n").unwrap();
        assert_eq!(
            crate::workspaces::snapshot(&core).unwrap().terminals[0]
                .execution
                .as_ref()
                .unwrap()
                .state,
            "ready"
        );
        terminal::write(&core, &workspace, &info.id, "\x1b]2;⠋ Example\x1b\\\n").unwrap();
        until(&core, &workspace, &info.id, "⠋ Example");
        wait_execution(&core, "running");
        terminal::write(&core, &workspace, &info.id,
            "\x1b[H\x1b[2JDo you want to proceed?\r\n1. Yes\r\n2. No\r\nEnter to confirm\r\npreserved-output\n").unwrap();
        wait_execution(&core, "waiting");
        // Снимки обзора не забирают байты из очереди отображения.
        until(&core, &workspace, &info.id, "preserved-output");
        if executor == "codex" {
            terminal::write(
                &core,
                &workspace,
                &info.id,
                "\x1b[H\x1b[2J\x1b]7501;state=done:app=codex\x1b\\\n",
            )
            .unwrap();
            wait_execution(&core, "ready");
        }
        terminal::interrupt(&core, &workspace, &info.id).unwrap();
        wait_execution(&core, "completed");
    }
    terminal::write(&core, &workspace, &info.id, "exit 0\n").unwrap();
    assert_eq!(
        finished(&core, &workspace, &info.id).info.state,
        "completed"
    );
}

#[cfg(unix)]
#[test]
fn terminal_observation_recognizes_node_entrypoint_through_shell_function() {
    let (temp, core, workspace) = fixture();
    let script = temp
        .path()
        .join("node_modules/@anthropic-ai/claude-code/cli.js");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, "process.stdin.pipe(process.stdout);").unwrap();
    let info = shell(&core, &workspace);
    terminal::write(
        &core,
        &workspace,
        &info.id,
        &format!(
            "user_function() {{ node '{}'; }}; printf 'setup:%s\\n' ready\n",
            script.display(),
        ),
    )
    .unwrap();
    until(&core, &workspace, &info.id, "setup:ready");
    terminal::write(&core, &workspace, &info.id, "stty -echo; user_function\n").unwrap();
    wait_execution(&core, "unknown");
    terminal::write(&core, &workspace, &info.id, "\x1b]0;⠋ Example\x07\n").unwrap();
    wait_execution(&core, "running");
    let snapshot = crate::workspaces::snapshot(&core).unwrap();
    assert_eq!(
        snapshot.terminals[0].execution.as_ref().unwrap().executor,
        "claude"
    );
    terminal::interrupt(&core, &workspace, &info.id).unwrap();
    wait_execution(&core, "completed");
    terminal::write(&core, &workspace, &info.id, "exit 0\n").unwrap();
    assert_eq!(
        finished(&core, &workspace, &info.id).info.state,
        "completed"
    );
}

#[cfg(unix)]
#[test]
fn terminal_observation_detects_changed_node_arguments_without_a_new_pid() {
    let (_temp, core, workspace) = fixture();
    let mut command = CommandBuilder::new("node");
    command.args(["-e", "process.stdin.on('data', () => { if (process.title !== 'claude') process.title = 'claude'; else process.stdout.write('\\x1b]0;⠋ Example\\x07'); }); process.stdout.write('ready\\n');"]);
    let info = terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
        .unwrap();
    until(&core, &workspace, &info.id, "ready");
    assert!(crate::workspaces::snapshot(&core).unwrap().terminals[0]
        .execution
        .is_none());
    terminal::write(&core, &workspace, &info.id, "identify\n").unwrap();
    wait_execution(&core, "unknown");
    terminal::write(&core, &workspace, &info.id, "work\n").unwrap();
    wait_execution(&core, "running");
    terminal::stop(&core, &workspace, &info.id).unwrap();
    assert_eq!(finished(&core, &workspace, &info.id).info.state, "stopped");
}

fn wait_execution(core: &Mutex<Core>, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = crate::workspaces::snapshot(core).unwrap();
        let execution = snapshot.terminals[0].execution.as_ref();
        if execution.is_some_and(|execution| execution.state == expected) {
            break;
        }
        if Instant::now() >= deadline {
            let mut output = Vec::new();
            for _ in 0..100 {
                let frame = terminal::read(
                    core,
                    &snapshot.terminals[0].workspace_id,
                    &snapshot.terminals[0].id,
                )
                .unwrap();
                output.extend(frame.data);
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!(
                "не дождались {expected}: {execution:?}; вывод: {:?}",
                String::from_utf8_lossy(&output)
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn until(core: &Mutex<Core>, workspace: &str, id: &str, expected: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    loop {
        let frame = terminal::read(core, workspace, id).unwrap();
        assert!(frame.info.error.is_none(), "{:?}", frame.info.error);
        output.extend(frame.data);
        let text = String::from_utf8_lossy(&output);
        if text.contains(expected) {
            return text.into();
        }
        assert!(
            Instant::now() < deadline,
            "не дождались {expected:?}: {text}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn finished(core: &Mutex<Core>, workspace: &str, id: &str) -> terminal::TerminalFrame {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let frame = terminal::read(core, workspace, id).unwrap();
        if frame.info.state != "running" && frame.output_done {
            return frame;
        }
        assert!(Instant::now() < deadline, "оболочка не завершилась");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn shells_use_workspace_folder_and_keep_input_and_processes_separate() {
    let (temp, core, workspace) = fixture();
    let first = shell(&core, &workspace);
    let second = shell(&core, &workspace);
    terminal::write(
        &core,
        &workspace,
        &first.id,
        "printf 'cwd:%s\\n' \"$PWD\"; value=first; printf 'first:%s\\n' \"$value\"\n",
    )
    .unwrap();
    let output = until(&core, &workspace, &first.id, "first:first");
    assert!(
        output.contains(&format!(
            "cwd:{}",
            temp.path().canonicalize().unwrap().display()
        )),
        "{output}"
    );
    terminal::write(
        &core,
        &workspace,
        &second.id,
        "printf 'second:%s\\n' \"${value:-independent}\"\n",
    )
    .unwrap();
    assert!(!until(&core, &workspace, &second.id, "second:independent").contains("first:first"));
    assert!(core
        .lock()
        .unwrap()
        .ensure_workspace_idle(&workspace)
        .is_err());
    assert!(terminal::write(&core, "missing", &first.id, "exit\n").is_err());
    {
        let mut guard = core.lock().unwrap();
        let other = temp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        guard.store.register_folder("Другой", &other, None).unwrap();
    }
    let foreign = core.lock().unwrap().store.snapshot().unwrap().workspaces[1]
        .id
        .clone();
    assert!(terminal::stop(&core, &foreign, &first.id).is_err());
    assert!(terminal::write(&core, &foreign, &first.id, "exit\n").is_err());
    assert!(terminal::resize(&core, &foreign, &first.id, 40, 10).is_err());
    assert!(terminal::read(&core, &foreign, &first.id).is_err());
    terminal::stop(&core, &workspace, &first.id).unwrap();
    assert_eq!(finished(&core, &workspace, &first.id).info.state, "stopped");
    terminal::write(&core, &workspace, &second.id, "printf 'alive:%s\\n' yes\n").unwrap();
    until(&core, &workspace, &second.id, "alive:yes");
    terminal::stop(&core, &workspace, &second.id).unwrap();
    assert_eq!(core.lock().unwrap().processes.count(), 0);
    core.lock()
        .unwrap()
        .ensure_workspace_idle(&workspace)
        .unwrap();
}

#[test]
fn overview_keeps_terminal_processes_and_output_and_tracks_selection_and_input() {
    let (_temp, core, workspace) = fixture();
    let first = shell(&core, &workspace);
    let second = shell(&core, &workspace);
    assert!(first.last_activity_at > 0);
    let mut view = core.lock().unwrap().store.snapshot().unwrap().view;
    view.project_id = core
        .lock()
        .unwrap()
        .store
        .workspace(&workspace)
        .unwrap()
        .project_id;
    view.workspace_id = Some(workspace.clone());
    view.tabs = vec![
        crate::model::Tab {
            id: format!("terminal:{}", first.id),
            workspace_id: workspace.clone(),
            session_id: None,
        },
        crate::model::Tab {
            id: format!("terminal:{}", second.id),
            workspace_id: workspace.clone(),
            session_id: None,
        },
    ];
    view.active_tabs
        .insert(workspace.clone(), format!("terminal:{}", first.id));
    {
        let mut guard = core.lock().unwrap();
        guard
            .processes
            .terminals
            .get_mut(&first.id)
            .unwrap()
            .info
            .last_activity_at = 1000;
        guard
            .processes
            .terminals
            .get_mut(&second.id)
            .unwrap()
            .info
            .last_activity_at = 2000;
        guard
            .store
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert!(guard.save_view(&view).is_err());
        assert_eq!(
            guard.processes.terminals[&first.id].info.last_activity_at,
            1000
        );
        guard
            .store
            .connection
            .pragma_update(None, "query_only", false)
            .unwrap();
        guard.save_view(&view).unwrap();
    }
    let snapshot = crate::workspaces::snapshot(&core).unwrap();
    let selected = snapshot
        .terminals
        .iter()
        .find(|terminal| terminal.id == first.id)
        .unwrap();
    assert!(selected.last_activity_at > 1000);
    assert_eq!(
        snapshot
            .terminals
            .iter()
            .find(|terminal| terminal.id == second.id)
            .unwrap()
            .last_activity_at,
        2000
    );
    terminal::list(&core, &workspace).unwrap();
    terminal::read(&core, &workspace, &first.id).unwrap();
    assert_eq!(
        core.lock().unwrap().processes.terminals[&first.id]
            .info
            .last_activity_at,
        selected.last_activity_at
    );
    view.tabs
        .retain(|tab| tab.id != format!("terminal:{}", first.id));
    view.active_tabs
        .insert(workspace.clone(), format!("terminal:{}", second.id));
    core.lock().unwrap().save_view(&view).unwrap();
    assert_eq!(
        crate::workspaces::snapshot(&core).unwrap().terminals.len(),
        2
    );
    core.lock()
        .unwrap()
        .processes
        .terminals
        .get_mut(&first.id)
        .unwrap()
        .info
        .last_activity_at = 1000;
    terminal::write(
        &core,
        &workspace,
        &first.id,
        "printf 'overview:%s\\n' kept\n",
    )
    .unwrap();
    let snapshot = crate::workspaces::snapshot(&core).unwrap();
    assert!(
        snapshot
            .terminals
            .iter()
            .find(|terminal| terminal.id == first.id)
            .unwrap()
            .last_activity_at
            > 1000
    );
    until(&core, &workspace, &first.id, "overview:kept");
    assert_eq!(core.lock().unwrap().processes.count(), 2);
    terminal::stop(&core, &workspace, &first.id).unwrap();
    terminal::stop(&core, &workspace, &second.id).unwrap();
    assert!(crate::workspaces::snapshot(&core)
        .unwrap()
        .terminals
        .iter()
        .all(|terminal| terminal.state == "stopped"));
}

#[test]
fn resize_and_ctrl_c_reach_only_the_selected_pty() {
    let (_temp, core, workspace) = fixture();
    let first = shell(&core, &workspace);
    let second = shell(&core, &workspace);
    terminal::resize(&core, &workspace, &first.id, 101, 37).unwrap();
    assert!(terminal::resize(&core, &workspace, &first.id, 0, 37).is_err());
    terminal::write(&core, &workspace, &first.id, "stty size\n").unwrap();
    until(&core, &workspace, &first.id, "37 101");
    terminal::write(
        &core,
        &workspace,
        &first.id,
        "printf 'ready:%s\\n' first; sleep 300; printf 'after:%s\\n' first\n",
    )
    .unwrap();
    until(&core, &workspace, &first.id, "ready:first");
    terminal::write(
        &core,
        &workspace,
        &second.id,
        "printf 'ready:%s\\n' second; sleep 300; printf 'after:%s\\n' second\n",
    )
    .unwrap();
    until(&core, &workspace, &second.id, "ready:second");
    terminal::write(&core, &workspace, &first.id, "\u{3}").unwrap();
    until(&core, &workspace, &first.id, "after:first");
    let deadline = Instant::now() + Duration::from_millis(150);
    while Instant::now() < deadline {
        let frame = terminal::read(&core, &workspace, &second.id).unwrap();
        assert!(!String::from_utf8_lossy(&frame.data).contains("after:second"));
        std::thread::sleep(Duration::from_millis(10));
    }
    terminal::stop(&core, &workspace, &first.id).unwrap();
    // Активная команда находится в отдельной группе управления заданиями оболочки.
    terminal::stop(&core, &workspace, &second.id).unwrap();
    assert_eq!(
        finished(&core, &workspace, &second.id).info.state,
        "stopped"
    );
}

#[test]
fn shell_exit_keeps_background_group_tracked_until_stopped_or_completed() {
    for stop in [true, false] {
        let (temp, core, workspace) = fixture();
        let independent_workspace = {
            let path = temp.path().join("independent");
            std::fs::create_dir(&path).unwrap();
            let mut guard = core.lock().unwrap();
            guard
                .store
                .register_folder("Независимый", &path, None)
                .unwrap();
            guard.store.snapshot().unwrap().workspaces[1].id.clone()
        };
        let independent = shell(&core, &independent_workspace);
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "set +m; trap '' HUP; sleep 300 & printf '%s' $! > child.pid; exit",
        ]);
        let terminal =
            terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
                .unwrap();
        let root: u32 = core
            .lock()
            .unwrap()
            .store
            .connection
            .query_row(
                "SELECT pid FROM processes WHERE id=?1",
                [&terminal.id],
                |r| r.get(0),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let child: i32 = loop {
            if let Some(pid) = std::fs::read_to_string(temp.path().join("child.pid"))
                .ok()
                .and_then(|value| value.parse().ok())
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "дочерний процесс не запустился");
            std::thread::sleep(Duration::from_millis(10));
        };
        loop {
            let output = std::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &root.to_string()])
                .output()
                .unwrap();
            assert!(output.status.success() || output.status.code() == Some(1));
            let state = String::from_utf8_lossy(&output.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                break;
            }
            assert!(Instant::now() < deadline, "оболочка не завершилась");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(100));
        let tracked = core.lock().unwrap().processes.has_workspace(&workspace);
        let blocked = core
            .lock()
            .unwrap()
            .ensure_workspace_idle(&workspace)
            .is_err();
        let state = terminal::read(&core, &workspace, &terminal.id)
            .unwrap()
            .info
            .state;
        assert_eq!(unsafe { libc::getpgid(child) }, root as i32);
        if stop {
            terminal::stop(&core, &workspace, &terminal.id).unwrap();
        } else {
            assert_eq!(unsafe { libc::kill(child, libc::SIGTERM) }, 0);
        }
        let frame = finished(&core, &workspace, &terminal.id);
        let output = std::process::Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &child.to_string()])
            .output()
            .unwrap();
        assert!(output.status.success() || output.status.code() == Some(1));
        let child_state = String::from_utf8_lossy(&output.stdout);
        let child_stopped = child_state.trim().is_empty() || child_state.trim().starts_with('Z');
        if !child_stopped {
            assert_eq!(unsafe { libc::kill(child, libc::SIGKILL) }, 0);
        }
        terminal::write(
            &core,
            &independent_workspace,
            &independent.id,
            "printf 'alive:%s\\n' yes\n",
        )
        .unwrap();
        until(&core, &independent_workspace, &independent.id, "alive:yes");
        terminal::stop(&core, &independent_workspace, &independent.id).unwrap();
        assert!(tracked);
        assert!(blocked);
        assert_eq!(state, "running");
        assert!(child_stopped);
        assert_eq!(frame.info.state, if stop { "stopped" } else { "completed" });
        core.lock()
            .unwrap()
            .ensure_workspace_idle(&workspace)
            .unwrap();
    }
}

#[test]
fn startup_and_exit_errors_are_not_reported_as_success() {
    let (_temp, core, workspace) = fixture();
    assert!(terminal::start_command(
        &core,
        &workspace,
        CommandBuilder::new("/missing/yade-shell"),
        terminal::size(80, 24).unwrap()
    )
    .unwrap_err()
    .contains("не удалось запустить оболочку"));
    assert_eq!(core.lock().unwrap().processes.count(), 0);
    {
        let guard = core.lock().unwrap();
        guard
            .store
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
    }
    let mut command = CommandBuilder::new("/bin/sh");
    command.arg("-i");
    assert!(
        terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
            .unwrap_err()
            .contains("процесс остановлен")
    );
    {
        let guard = core.lock().unwrap();
        assert_eq!(guard.processes.count(), 0);
        guard
            .store
            .connection
            .pragma_update(None, "query_only", false)
            .unwrap();
    }
    for code in [0, 7] {
        let terminal = shell(&core, &workspace);
        terminal::write(&core, &workspace, &terminal.id, &format!("exit {code}\n")).unwrap();
        let frame = finished(&core, &workspace, &terminal.id);
        assert_eq!(frame.info.exit_code, Some(code));
        assert_eq!(
            frame.info.state,
            if code == 0 { "completed" } else { "failed" }
        );
        assert!(terminal::write(&core, &workspace, &terminal.id, "pwd\n").is_err());
    }
    core.lock()
        .unwrap()
        .ensure_workspace_idle(&workspace)
        .unwrap();
}

#[test]
fn terminal_completion_retries_persistence_after_a_write_failure() {
    for exit_code in [None, Some(0), Some(7)] {
        let (_temp, core, workspace) = fixture();
        let terminal = shell(&core, &workspace);
        core.lock()
            .unwrap()
            .store
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        if let Some(code) = exit_code {
            terminal::write(&core, &workspace, &terminal.id, &format!("exit {code}\n")).unwrap();
        } else {
            assert!(terminal::stop(&core, &workspace, &terminal.id)
                .unwrap_err()
                .contains("состояние не сохранено"));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let frame = terminal::read(&core, &workspace, &terminal.id).unwrap();
            if frame.info.state != "running" && (exit_code.is_none() || frame.info.error.is_some())
            {
                break;
            }
            assert!(Instant::now() < deadline, "не дождались ошибки сохранения");
            std::thread::sleep(Duration::from_millis(10));
        }
        {
            let guard = core.lock().unwrap();
            assert_eq!(guard.processes.count(), 0);
            let state: String = guard
                .store
                .connection
                .query_row(
                    "SELECT state FROM processes WHERE id=?1",
                    [&terminal.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(state, "running");
            assert!(guard.ensure_workspace_idle(&workspace).is_err());
            guard
                .store
                .connection
                .pragma_update(None, "query_only", false)
                .unwrap();
        }
        if exit_code.is_none() {
            terminal::stop(&core, &workspace, &terminal.id).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let state: String = core
                .lock()
                .unwrap()
                .store
                .connection
                .query_row(
                    "SELECT state FROM processes WHERE id=?1",
                    [&terminal.id],
                    |r| r.get(0),
                )
                .unwrap();
            if state != "running" {
                assert_eq!(
                    state,
                    if exit_code.is_none() {
                        "stopped"
                    } else {
                        "exited"
                    }
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "состояние процесса не сохранено повторно"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let info = terminal::read(&core, &workspace, &terminal.id)
            .unwrap()
            .info;
        assert_eq!(info.exit_code, exit_code);
        assert_eq!(
            info.state,
            match exit_code {
                None => "stopped",
                Some(0) => "completed",
                Some(_) => "failed",
            }
        );
        core.lock()
            .unwrap()
            .ensure_workspace_idle(&workspace)
            .unwrap();
    }
}
