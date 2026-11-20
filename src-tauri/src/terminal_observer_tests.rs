use super::*;

fn process(pid: u32, parent: u32, command: &str) -> Process {
    Process {
        pid,
        parent,
        group: 20,
        foreground: 20,
        tty: "ttys123".into(),
        state: "S+".into(),
        command: command.into(),
        args: String::new(),
    }
}

fn running(executor: &str) -> Vec<Process> {
    vec![process(10, 1, "/bin/zsh"), process(20, 10, executor)]
}

fn observe(rows: u16, cols: u16, processes: &[Process]) -> Observer {
    let mut observer = Observer::new(10, rows, cols);
    observer.refresh(Some(processes), &mut None);
    observer
}

fn state(observer: &mut Observer, processes: &[Process], quiet: bool) -> String {
    let mut execution = None;
    observer.refresh(Some(processes), &mut execution);
    if quiet {
        observer.changed_at -= QUIET;
        observer.refresh(Some(processes), &mut execution);
    }
    execution.unwrap().state
}

#[test]
fn titles_wait_for_a_response_and_are_requested_once_per_process() {
    for executor in ["codex", "claude"] {
        let mut processes = running(executor);
        let mut observer = observe(24, 120, &processes);
        let mut execution = None;
        let ready = if executor == "codex" {
            "›"
        } else {
            "❯\r\n? for shortcuts"
        };
        let prompt = if executor == "codex" { "›" } else { "❯" };
        let response = if executor == "codex" { "•" } else { "⏺" };
        observer.feed(ready.as_bytes());
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        assert!(observer
            .take_title_request(execution.as_ref().unwrap())
            .is_none());

        observer.feed(format!("\x1b[H\x1b[2J$ cd /service && {executor}\r\n{prompt} Исправь восстановление вкладок").as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        observer.input("\r");
        observer.refresh(Some(&processes), &mut execution);
        assert!(observer
            .take_title_request(execution.as_ref().unwrap())
            .is_none());
        observer.feed("\r\nWorking (esc to interrupt)".as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "running");
        assert!(observer
            .take_title_request(execution.as_ref().unwrap())
            .is_none());
        observer.feed(format!("\x1b[H\x1b[2J{ready}").as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        assert!(observer
            .take_title_request(execution.as_ref().unwrap())
            .is_none());
        observer.feed(format!("\x1b[H\x1b[2J$ cd /service && {executor}\r\n{prompt} Исправь восстановление вкладок\r\n{response} Восстановление исправлено\r\n{ready}").as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        let request = observer
            .take_title_request(execution.as_ref().unwrap())
            .unwrap();
        assert_eq!(request.input, "Исправь восстановление вкладок");
        assert!(request.answer.contains("Восстановление исправлено"));
        assert!(!request.answer.contains("cd /service"));
        assert!(observer
            .take_title_request(execution.as_ref().unwrap())
            .is_none());
        observer.set_title(
            request.pid,
            &request.executor,
            &mut execution,
            "Восстановление вкладок".into(),
        );
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(
            execution.as_ref().unwrap().title.as_deref(),
            Some("Восстановление вкладок")
        );

        processes.pop();
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(
            execution.as_ref().unwrap().title.as_deref(),
            Some("Восстановление вкладок")
        );
        processes.push(process(30, 10, executor));
        observer.refresh(Some(&processes), &mut execution);
        observer.set_title(
            request.pid,
            &request.executor,
            &mut execution,
            "Запоздалое название".into(),
        );
        assert!(execution.as_ref().unwrap().title.is_none());
        assert!(observer.title_input.is_none());
        assert!(!observer.title_requested);
    }
}

#[test]
fn shell_output_and_executor_startup_do_not_request_titles() {
    for executor in ["codex", "claude"] {
        let mut processes = vec![process(10, 1, "/bin/zsh")];
        let mut observer = observe(24, 120, &processes);
        let mut execution = None;
        let prompt = if executor == "codex" { "›" } else { "❯" };
        observer.feed(format!("{prompt} cd /service && {executor}").as_bytes());
        observer.input("\r");
        observer.refresh(Some(&processes), &mut execution);
        assert!(execution.is_none());
        assert!(observer.title_input.is_none());

        processes.push(process(20, 10, executor));
        observer.refresh(Some(&processes), &mut execution);
        observer.feed("\r\nLoading (esc to interrupt)".as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "running");
        observer.feed(format!("\x1b[2;1H\x1b[J{prompt}\r\n? for shortcuts").as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "ready");
        assert!(observer
            .take_title_request(execution.as_ref().unwrap())
            .is_none());
        assert!(observer.title_input.is_none());
        observer.input("\r");
        assert!(observer.title_input.is_none());
        observer.feed(format!("\x1b[H\x1b[2J{prompt} Черновик запроса").as_bytes());
        observer.input("\u{3}");
        assert!(observer.title_input.is_none());
    }
}

#[test]
fn codex_redraws_replace_dialogs_and_busy_rows_without_reading_scrollback() {
    let processes = running("/opt/homebrew/bin/codex");
    let mut observer = observe(24, 120, &processes);
    observer.feed(b"\x1b[H\x1b[2JWould you like to run the following command?\r\n1. Yes\r\n2. No\r\nEnter to confirm");
    assert_eq!(state(&mut observer, &processes, true), "waiting");
    observer.feed("\x1b[H\x1b[2JOpenAI Codex\r\nmodel: loading\r\ndirectory: loading\r\n› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "unknown");
    // Заголовок перерисовывается по ячейкам, без повторного вывода поля ввода.
    observer.feed(b"\x1b[2;1H\x1b[2Kmodel: example\x1b[3;1H\x1b[2Kdirectory: /tmp");
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.feed(
        "\x1b[4;1H\x1b[2KWorking (5s · esc to interrupt)\r\n› Ask Codex to do anything".as_bytes(),
    );
    assert_eq!(state(&mut observer, &processes, true), "running");
    observer.feed(b"\x1b[4;1H\x1b[2K");
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.feed("\x1b[H\x1b[2JWould you like to run the following command?\r\n1. Yes\r\n2. No\r\n\r\n› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
}

#[test]
fn codex_status_survives_queued_inputs_and_recognizes_pending_questions() {
    let processes = running("codex");
    let mut observer = observe(40, 120, &processes);
    for (footer, expected) in [
        (
            "• Queued follow-up inputs\r\n  Уточнение задачи\r\n  Ещё одно уточнение",
            "running",
        ),
        (
            "• Queued follow-up inputs\r\n? 1 question\r\n  ⇧⇥ to answer",
            "waiting",
        ),
        ("? 2 questions\r\n  ⇧⇥ to answer", "waiting"),
    ] {
        for composer in ["› Ask Codex to do anything", "› Уточнение задачи"] {
            observer.feed(format!("\x1b[H\x1b[2J◦ Working (2m 36s • esc to interrupt)\r\n\r\n{footer}\r\n\r\n{composer}\r\n? for shortcuts").as_bytes());
            assert_eq!(state(&mut observer, &processes, true), expected);
        }
    }
    observer.feed("\x1b[H\x1b[2JWorking (esc to interrupt)\r\n• Готовый ответ\r\nПервая строка\r\nВторая строка\r\n› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.feed("\x1b[H\x1b[2J› Ask Codex to do anything\r\n? for shortcuts".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
}

#[test]
fn codex_program_status_survives_redraws_and_input() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    for (report, expected) in [
        ("working:app=codex", "running"),
        ("blocked:app=codex:kind=question", "waiting"),
        ("done:app=codex", "ready"),
        ("idle:app=codex", "ready"),
        ("error:app=codex", "failed"),
    ] {
        let sequence = format!("\x1b]7501;state={report}\x1b\\");
        for chunk in sequence.as_bytes().chunks(3) {
            observer.feed(chunk);
        }
        observer.feed(b"\x1b[H\x1b[2J");
        assert_eq!(state(&mut observer, &processes, false), expected);
        observer.input("\r");
        observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
        assert_eq!(state(&mut observer, &processes, false), expected);
    }
}

#[test]
fn codex_program_status_is_scoped_to_the_foreground_process() {
    let mut processes = running("codex");
    let mut observer = observe(24, 80, &processes[..1]);
    observer.feed(b"\x1b]7501;state=blocked:app=codex:kind=permission\x1b\\");
    assert_eq!(state(&mut observer, &processes, false), "unknown");

    observer.command();
    observer.feed(b"\x1b]7501;state=working:app=codex\x1b\\");
    processes[1].pid = 21;
    assert_eq!(state(&mut observer, &processes, false), "running");
    processes[0].foreground = 10;
    assert_eq!(state(&mut observer, &processes, false), "unknown");
    processes[0].foreground = 20;
    observer.feed(b"\x1b]7501;state=blocked:app=other\x1b\\");
    assert_eq!(state(&mut observer, &processes, false), "running");

    observer.feed("\x1b]7501;state=clear\x1b\\› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.feed(b"\x1b]7501;state=working:app=codex\x1b\\");
    assert_eq!(state(&mut observer, &processes, false), "running");
    processes[1].pid = 22;
    assert_eq!(state(&mut observer, &processes, false), "unknown");
}

#[test]
fn terminal_notifies_once_per_confirmed_transition() {
    let mut processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    let mut execution = None;
    for (signal, expected) in [
        ("idle", None),
        ("working", None),
        ("blocked", Some(Kind::Input)),
        ("blocked", None),
        ("working", None),
        ("done", Some(Kind::Completion)),
        ("idle", None),
        ("working", None),
    ] {
        observer.feed(format!("\x1b]7501;state={signal}:app=codex\x1b\\").as_bytes());
        assert_eq!(
            observer.refresh(Some(&processes), &mut execution).1,
            expected.map(|kind| (kind, "codex"))
        );
    }
    observer.input("\u{3}");
    assert_eq!(observer.refresh(Some(&processes), &mut execution).1, None);
    observer.feed(b"\x1b]7501;state=idle:app=codex\x1b\\");
    assert_eq!(observer.refresh(Some(&processes), &mut execution).1, None);
    observer.feed(b"\x1b]7501;state=working:app=codex\x1b\\");
    assert_eq!(observer.refresh(Some(&processes), &mut execution).1, None);
    processes.pop();
    assert_eq!(observer.refresh(Some(&processes), &mut execution).1, None);
}

#[test]
fn temporary_output_backpressure_preserves_the_last_confirmed_status() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    let mut execution = None;
    observer.feed(b"\x1b]7501;state=working:app=codex\x1b\\");
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");

    observer.backpressured = true;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");
    observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "unknown");

    observer.backpressured = false;
    observer.feed(b"\x1b]7501;state=done:app=codex\x1b\\");
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
}

#[test]
fn claude_native_titles_and_live_permission_dialogs_set_status() {
    let processes = running("/Users/example/.local/share/claude/versions/2.1.0");
    let mut observer = observe(24, 120, &processes);
    for (title, expected) in [
        ("claude", "unknown"),
        ("⠋ Fix tests", "running"),
        (". Fix tests", "running"),
        ("✳ Fix tests", "ready"),
        ("* Fix tests", "ready"),
    ] {
        let bytes = format!("\x1b]2;{title}\x1b\\");
        // Включая разбиение OSC и UTF-8 между чтениями.
        for byte in bytes.as_bytes() {
            observer.feed(&[*byte]);
        }
        assert_eq!(state(&mut observer, &processes, true), expected, "{title}");
    }
    observer.feed("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEnter to confirm".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "waiting");
    observer.feed("\x1b[H\x1b[2J❯\r\n? for shortcuts".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
}

#[test]
fn silence_and_input_alone_cannot_prove_readiness_or_work() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    observer.feed(b"Connected");
    assert_eq!(state(&mut observer, &processes, true), "unknown");
    observer.feed(b"\x1b[H\x1b[2J1. First result\r\n2. Second result");
    assert_eq!(state(&mut observer, &processes, true), "unknown");
    observer.feed(b"\x1b[H\x1b[2JWhich option?\r\n1. First\r\n2. Second\r\nEnter to select");
    assert_eq!(state(&mut observer, &processes, true), "waiting");
    observer.feed("\x1b[H\x1b[2J› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, false), "unknown");
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.input("\r");
    assert_eq!(state(&mut observer, &processes, true), "unknown");
    observer.feed(b"\x1b]0;\xe2\xa0\x8b task\x07");
    assert_eq!(state(&mut observer, &processes, true), "running");
    observer.backpressured = true;
    assert_eq!(state(&mut observer, &processes, true), "unknown");
}

#[test]
fn actual_executable_and_interpreter_entrypoint_identify_installations() {
    for (command, args, expected) in [
        (
            "/some directory/codex-aarch64-apple-darwin",
            "",
            Some("codex"),
        ),
        ("/some directory/claude", "", Some("claude")),
        (
            "/usr/local/bin/node",
            "node /lib/node_modules/@openai/codex/bin/codex.js --model example",
            Some("codex"),
        ),
        (
            "/usr/local/bin/node",
            "node --no-warnings /lib/node_modules/@anthropic-ai/claude-code/cli.js",
            Some("claude"),
        ),
        ("/bin/echo", "echo codex", None),
        ("node", "claude", Some("claude")),
        ("node", "node /usr/local/bin/codex", Some("codex")),
        (
            "node",
            "node unrelated.js --prompt /lib/node_modules/@anthropic-ai/claude-code/cli.js",
            None,
        ),
        ("/bin/zsh", "zsh -c claude", None),
    ] {
        let mut process = process(20, 10, command);
        process.args = args.into();
        assert_eq!(process.executor(), expected, "{command} {args}");
    }
}

#[test]
fn ownership_foreground_and_process_exit_prevent_stale_status() {
    let mut processes = running("claude");
    let mut observer = observe(24, 80, &processes);
    observer.feed("\x1b]0;✳ Task\x07".as_bytes());
    let mut execution = None;
    observer.refresh(Some(&processes), &mut execution);
    observer.changed_at -= QUIET;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
    observer.refresh(None, &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "unknown");
    processes[0].foreground = 10;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "unknown");
    processes.remove(1);
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "completed");
    observer.refresh(None, &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "completed");
    processes.push(process(30, 10, "claude"));
    processes[0].foreground = 20;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "unknown");
    processes[1].tty = "ttys999".into();
    assert!(state_without_execution(&processes).is_none());
    processes[1].tty = "ttys123".into();
    processes[1].parent = 99;
    assert!(state_without_execution(&processes).is_none());
}

fn state_without_execution(processes: &[Process]) -> Option<Execution> {
    let mut observer = Observer::new(10, 24, 80);
    let mut execution = None;
    observer.refresh(Some(processes), &mut execution);
    execution
}

#[test]
fn alternate_screen_and_resize_do_not_retain_old_dialogs() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    observer.feed(b"Would you like to run this?\r\n1. Yes\r\n2. No");
    observer.feed("\x1b[?1049h\x1b[H› Ask Codex to do anything".as_bytes());
    observer.resize(40, 120);
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.feed(b"\x1b[?1049l");
    assert_eq!(state(&mut observer, &processes, true), "waiting");
}

#[test]
fn startup_output_before_process_discovery_is_not_discarded() {
    for executor in ["codex", "claude"] {
        for integrated in [false, true] {
            let mut processes = vec![process(10, 1, "/bin/zsh")];
            let mut observer = observe(24, 120, &processes);
            let mut execution = None;
            if integrated {
                observer.command();
            } else {
                observer.input(&format!("{executor}\r"));
            }
            let ready = if executor == "codex" {
                "› Ask Codex to do anything"
            } else {
                "\x1b]0;✳ Task\x07"
            };
            observer.feed(ready.as_bytes());
            // Пока кеш процессов ещё содержит только оболочку.
            observer.refresh(Some(&processes), &mut execution);
            assert!(execution.is_none());
            processes.push(process(20, 10, executor));
            observer.refresh(Some(&processes), &mut execution);
            observer.changed_at -= QUIET;
            observer.refresh(Some(&processes), &mut execution);
            assert_eq!(execution.as_ref().unwrap().state, "ready", "{executor}");

            processes.pop();
            observer.refresh(Some(&processes), &mut execution);
            if integrated {
                observer.command();
            } else {
                observer.input(&format!("{executor}\r"));
            }
            processes.push(process(30, 10, executor));
            observer.refresh(Some(&processes), &mut execution);
            observer.changed_at -= QUIET;
            observer.refresh(Some(&processes), &mut execution);
            assert_eq!(execution.as_ref().unwrap().state, "unknown");
        }
    }
}

#[test]
fn new_process_waits_for_fresh_output_and_large_sizes_bound_memory() {
    let mut observer = Observer::new(10, 24, 80);
    let processes = running("claude");
    observer.feed("\x1b]0;✳ Previous\x07".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "unknown");
    observer.feed("\x1b]0;✳ Current\x07".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.resize(u16::MAX, u16::MAX);
    let (rows, cols) = observer.parser.screen().size();
    assert_eq!((rows.get(), cols.get()), (MAX_ROWS, MAX_COLS));
    assert_eq!(state(&mut observer, &processes, true), "unknown");
}

#[test]
fn cached_screen_keeps_quiet_deadline_and_reacts_to_resize() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    observer.feed("\x1b[H\x1b[2J› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, false), "unknown");
    assert_eq!(state(&mut observer, &processes, true), "ready");
    observer.resize(24, 8);
    assert_eq!(state(&mut observer, &processes, true), "unknown");
    observer.resize(24, 80);
    observer.feed("\x1b[H\x1b[2J› Ask Codex to do anything".as_bytes());
    assert_eq!(state(&mut observer, &processes, true), "ready");
}

#[test]
fn confirmed_state_stays_running_until_readiness_is_settled() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    let mut execution = None;
    observer.feed("\x1b]0;⠋ Task\x07".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");
    observer.feed("\x1b]0;Task\x07\x1b[H\x1b[2J› Ask Codex to do anything".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");
    observer.changed_at -= QUIET;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
}

#[test]
fn confirmed_state_stays_ready_while_resizing_the_same_terminal() {
    let processes = running("codex");
    let mut observer = observe(24, 80, &processes);
    let mut execution = None;
    observer.feed("\x1b[H\x1b[2J› Ask Codex to do anything".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    observer.changed_at -= QUIET;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
    observer.resize(40, 120);
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
}

#[test]
fn confirmed_state_survives_redraw_but_expires_if_the_screen_stays_unrecognized() {
    let processes = running("claude");
    let mut observer = observe(24, 80, &processes);
    let mut execution = None;
    observer.feed("\x1b]0;⠋ Task\x07".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    observer.feed(b"\x1b]0;Task\x07\x1b[H\x1b[2J");
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");
    observer.feed("\x1b]0;✳ Task\x07".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");
    observer.changed_at -= QUIET;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
    observer.feed(b"\x1b]0;Task\x07\x1b[H\x1b[2J");
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
    observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "unknown");
}

#[test]
fn confirmed_state_survives_ongoing_redraw_but_expires_without_screen_changes() {
    for executor in ["codex", "claude"] {
        let processes = running(executor);
        let mut observer = observe(24, 80, &processes);
        let mut execution = None;
        observer.feed(b"Working (esc to interrupt)");
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "running");

        observer.feed(b"\x1b[H\x1b[2J");
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "running");
        observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
        observer.feed(b"Result");
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "running");

        let ready = if executor == "codex" {
            "\r\n›"
        } else {
            "\r\n❯\r\n? for shortcuts"
        };
        observer.feed(ready.as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "running");
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "ready");

        observer.feed(b"\x1b[H\x1b[2J");
        observer.refresh(Some(&processes), &mut execution);
        observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
        observer.feed(b"\x1b[H\x1b]0;Task\x07");
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "unknown");
    }
}

#[test]
fn confirmed_state_survives_input_until_fresh_output_or_the_next_process_poll() {
    let processes = running("claude");
    let mut observer = observe(24, 80, &processes);
    let mut execution = None;
    observer.feed("\x1b]0;✳ Task\x07".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    observer.changed_at -= QUIET;
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
    observer.input("\r");
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "ready");
    observer.feed("\x1b]0;⠋ Task\x07".as_bytes());
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "running");
    observer.input("\r");
    observer.refresh(Some(&processes), &mut execution);
    observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
    observer.refresh(Some(&processes), &mut execution);
    assert_eq!(execution.as_ref().unwrap().state, "unknown");
}

#[cfg(unix)]
#[test]
fn process_sampling_tracks_only_registered_terminals_and_invalidates_on_close() {
    struct Pty {
        master: Box<dyn portable_pty::MasterPty + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    }
    impl Pty {
        fn new() -> Self {
            let pair = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize::default())
                .unwrap();
            let child = pair
                .slave
                .spawn_command(portable_pty::CommandBuilder::new("/bin/cat"))
                .unwrap();
            Self {
                master: pair.master,
                child,
            }
        }
        fn pid(&self) -> u32 {
            self.child.process_id().unwrap()
        }
        fn register(&self) -> ProcessScope {
            ProcessScope::register(self.pid(), self.master.tty_name().as_deref()).unwrap()
        }
    }
    impl Drop for Pty {
        fn drop(&mut self) {
            self.child.kill().unwrap();
            self.child.wait().unwrap();
        }
    }
    let first = Pty::new();
    let second = Pty::new();
    let foreign = Pty::new();
    let first_scope = first.register();
    let rows = sample().unwrap();
    assert!(rows.iter().any(|p| p.pid == first.pid()));
    assert!(!rows
        .iter()
        .any(|p| p.pid == second.pid() || p.pid == foreign.pid()));
    let _second_scope = second.register();
    let rows = sample().unwrap();
    assert!(rows.iter().any(|p| p.pid == first.pid()));
    assert!(rows.iter().any(|p| p.pid == second.pid()));
    assert!(!rows.iter().any(|p| p.pid == foreign.pid()));
    drop(first_scope);
    let rows = sample().unwrap();
    assert!(!rows.iter().any(|p| p.pid == first.pid()));
    assert!(rows.iter().any(|p| p.pid == second.pid()));
}

#[test]
fn navigation_and_mouse_wheel_do_not_invalidate_confirmed_status() {
    let processes = running("codex");
    for input in [
        "\x1b[A",
        "\x1b[B",
        "\x1b[5~",
        "\x1b[6~",
        "\x1b[<64;10;10M",
        "\x1b[<65;10;10M",
    ] {
        let mut observer = observe(24, 120, &processes);
        let mut execution = None;
        observer.feed("\x1b[H\x1b[2J› Ask Codex to do anything\r\n? for shortcuts".as_bytes());
        observer.refresh(Some(&processes), &mut execution);
        observer.changed_at -= QUIET;
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "ready");
        observer.input(input);
        observer.refresh(Some(&processes), &mut execution);
        observer.unknown_since = Some(Instant::now() - PROCESS_INTERVAL);
        observer.refresh(Some(&processes), &mut execution);
        assert_eq!(execution.as_ref().unwrap().state, "ready", "{input:?}");
    }
}

#[test]
fn codex_drafts_and_suggestions_are_recognized_next_to_the_footer() {
    for prompt in [
        "› Explain this codebase",
        "› Find and fix a bug in @filename",
        "› Уточнение задачи",
    ] {
        let body = format!("• Готовый ответ\r\n{prompt}\r\n? for shortcuts");
        assert_eq!(screen_status("codex", &body, ""), "ready", "{prompt}");
    }
    assert_eq!(
        screen_status(
            "codex",
            "› Прежний запрос\r\nПечатается ответ без поля ввода",
            ""
        ),
        "unknown"
    );
}
