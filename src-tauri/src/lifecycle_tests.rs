use crate::model::{Context, Run, Session, Tab, View};
use crate::{codex, core::Core, lifecycle, store::Store, terminal};
use serde_json::json;
use std::{
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn fixture(path: &std::path::Path) -> (Arc<Mutex<Core>>, String) {
    let mut store = Store::open(&path.join("state.db")).unwrap();
    store.register_folder("Проект", path, None).unwrap();
    let workspace = store.snapshot().unwrap().workspaces[0].id.clone();
    (
        Arc::new(Mutex::new(Core {
            store,
            processes: Default::default(),
        })),
        workspace,
    )
}

#[test]
fn cancelling_exit_keeps_work_and_confirming_stops_only_owned_processes() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Активная работа").unwrap();
    let mut command = Command::new("/bin/sh");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/codex.sh"
        ))
        .env("FAKE_LOG", temp.path().join("codex.log"))
        .env("FAKE_MODE", "hold");
    codex::start_command(
        &core,
        &workspace,
        &session.id,
        vec![json!({"type":"text","text":"проверка"})],
        None,
        &mut command,
        Arc::new(|_| Ok(())),
    )
    .unwrap();
    let mut command = portable_pty::CommandBuilder::new("/bin/sh");
    command.arg("-i");
    let terminal =
        terminal::start_command(&core, &workspace, command, terminal::size(80, 24).unwrap())
            .unwrap();
    terminal::write(&core, &workspace, &terminal.id, "sleep 300\n").unwrap();
    let mut view = core.lock().unwrap().store.snapshot().unwrap().view;
    let terminal_tab = Tab {
        id: format!("terminal:{}", terminal.id),
        workspace_id: workspace.clone(),
        session_id: None,
    };
    let session_tab = Tab {
        id: format!("session:{}", session.id),
        workspace_id: workspace.clone(),
        session_id: Some(session.id),
    };
    view.tabs = vec![session_tab.clone(), terminal_tab.clone()];
    view.active_tabs.insert(workspace.clone(), terminal_tab.id);
    {
        let mut core = core.lock().unwrap();
        core.save_view(&view).unwrap();
        let Core { store, processes } = &mut *core;
        processes
            .spawn_preparation(
                store,
                &workspace,
                Command::new("/bin/sh")
                    .args(["-c", "sleep 300 & echo $! > preparation-child; wait"]),
            )
            .unwrap();
    }
    let mut unrelated = Command::new("/bin/sleep").arg("300").spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !temp.path().join("preparation-child").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(lifecycle::has_active_work(&core.lock().unwrap()).unwrap());
    assert!(lifecycle::shutdown(&core, false).is_err());
    assert_eq!(core.lock().unwrap().processes.count(), 3);
    assert!(!core.lock().unwrap().processes.closing);
    let snapshot = crate::workspaces::snapshot(&core).unwrap();
    assert_eq!(snapshot.view, view);
    assert_eq!(snapshot.terminals[0].id, terminal.id);
    lifecycle::shutdown(&core, true).unwrap();
    let unrelated_running = unrelated.try_wait().unwrap().is_none();
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    assert!(unrelated_running);
    assert!(terminal::list(&core, &workspace).unwrap().is_empty());
    let mut guard = core.lock().unwrap();
    assert_eq!(guard.processes.count(), 0);
    let reopened = Store::open(&temp.path().join("state.db")).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.sessions[0].state, "interrupted");
    assert_eq!(snapshot.view.active_tabs[&workspace], session_tab.id);
    assert_eq!(snapshot.view.tabs, vec![session_tab]);
    assert!(!lifecycle::has_active_work(&guard).unwrap());
    assert!(guard.save_view(&view).is_err());
}

#[test]
fn startup_discards_terminal_tabs_saved_by_previous_launches() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let mut guard = core.lock().unwrap();
    let mut view = guard.store.snapshot().unwrap().view;
    let id = "terminal:previous".to_string();
    view.tabs.push(Tab {
        id: id.clone(),
        workspace_id: workspace.clone(),
        session_id: None,
    });
    view.active_tabs.insert(workspace, id);
    guard.store.save_view(&view).unwrap();

    lifecycle::reconcile(&mut guard).unwrap();
    assert_eq!(guard.store.snapshot().unwrap().view, view);
    lifecycle::recover(&mut guard).unwrap();
    let view = guard.store.snapshot().unwrap().view;
    assert!(view.tabs.is_empty());
    assert!(view.active_tabs.is_empty());
}

#[test]
fn shutdown_failure_is_reported_and_can_be_retried() {
    let temp = tempfile::tempdir().unwrap();
    let (core, _) = fixture(temp.path());
    core.lock()
        .unwrap()
        .store
        .connection
        .pragma_update(None, "query_only", true)
        .unwrap();
    assert!(lifecycle::shutdown(&core, true).is_err());
    assert!(!core.lock().unwrap().processes.closing);
    core.lock()
        .unwrap()
        .store
        .connection
        .pragma_update(None, "query_only", false)
        .unwrap();
    lifecycle::shutdown(&core, false).unwrap();
}

#[test]
fn crash_restores_saved_context_and_blocks_duplication_of_a_surviving_process() {
    const CRASH_DIRECTORY: &str = "YADE_TEST_CRASH_DIRECTORY";
    if let Some(directory) = std::env::var_os(CRASH_DIRECTORY) {
        let directory = std::path::PathBuf::from(directory);
        let (core, workspace) = fixture(&directory);
        let mut core = core.lock().unwrap();
        core.store
            .insert_session(&Session {
                id: "session".into(),
                workspace_id: workspace.clone(),
                executor: "codex".into(),
                external_id: Some("native-thread".into()),
                title: "Разговор".into(),
                state: "running".into(),
                last_activity_at: 0,
            })
            .unwrap();
        core.store
            .insert_run(&Run {
                id: "run".into(),
                session_id: "session".into(),
                state: "running".into(),
            })
            .unwrap();
        let context = Context {
            workspace_id: workspace.clone(),
            session_id: "session".into(),
            run_id: "run".into(),
        };
        core.store
            .append_message(&context, "user", "исходное сообщение")
            .unwrap();
        core.store
            .append_message(&context, "assistant", "частичный ответ")
            .unwrap();
        core.store.record_event(&context, "request", json!({"requestId":"old-request","method":"item/commandExecution/requestApproval","params":{}})).unwrap();
        crate::conversations::save_draft(
            &core.store,
            "session",
            r#"{"text":"неотправленное сообщение","paths":["/tmp/file.txt"]}"#,
        )
        .unwrap();
        std::fs::write(directory.join("file.txt"), "исходник").unwrap();
        crate::editor::save_draft(
            &core.store,
            &workspace,
            "file.txt",
            "ручные правки",
            "исходник",
        )
        .unwrap();
        let view = View {
            project_id: core.store.snapshot().unwrap().workspaces[0]
                .project_id
                .clone(),
            workspace_id: Some(workspace.clone()),
            tabs: vec![
                Tab {
                    id: "session:session".into(),
                    workspace_id: workspace.clone(),
                    session_id: Some("session".into()),
                },
                Tab {
                    id: format!("file:{workspace}:file.txt"),
                    workspace_id: workspace.clone(),
                    session_id: None,
                },
            ],
            active_tabs: [(workspace.clone(), "session:session".into())].into(),
            sidebar_width: 320,
        };
        core.store.save_view(&view).unwrap();
        let Core { store, processes } = &mut *core;
        let id = processes
            .spawn(store, &context, Command::new("/bin/sleep").arg("300"))
            .unwrap();
        let pid: u32 = store
            .connection
            .query_row("SELECT pid FROM processes WHERE id=?1", [&id], |r| r.get(0))
            .unwrap();
        std::fs::write(directory.join("ready"), pid.to_string()).unwrap();
        loop {
            std::thread::park();
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let mut app = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "lifecycle_tests::crash_restores_saved_context_and_blocks_duplication_of_a_surviving_process"])
        .env(CRASH_DIRECTORY, temp.path()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let pid: u32 = loop {
        if let Some(pid) = std::fs::read_to_string(temp.path().join("ready"))
            .ok()
            .and_then(|s| s.parse().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    let identity = lifecycle::process_identity(pid).unwrap().unwrap();
    app.kill().unwrap();
    app.wait().unwrap();
    struct Cleanup(u32, String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if lifecycle::process_identity(self.0).ok().flatten().as_ref() == Some(&self.1) {
                unsafe {
                    libc::kill(self.0 as i32, libc::SIGKILL);
                }
            }
        }
    }
    let cleanup = Cleanup(pid, identity);
    let core = Arc::new(Mutex::new(Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    }));
    let workspace = {
        let mut core = core.lock().unwrap();
        let recovered = lifecycle::recover(&mut core).unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(recovered[0].verified);
        let conversation = crate::conversations::read(&core, "session", None, None).unwrap();
        assert_eq!(conversation.session.state, "needs_reconciliation");
        assert_eq!(
            conversation.session.external_id.as_deref(),
            Some("native-thread")
        );
        assert_eq!(
            conversation
                .messages
                .iter()
                .map(|m| m.body.as_str())
                .collect::<Vec<_>>(),
            ["исходное сообщение", "частичный ответ"]
        );
        assert!(conversation.draft.contains("неотправленное сообщение"));
        assert!(conversation.draft.contains("/tmp/file.txt"));
        assert!(conversation.requests.is_empty());
        let view = core.store.snapshot().unwrap().view;
        assert_eq!(view.sidebar_width, 320);
        assert_eq!(view.tabs.len(), 2);
        assert_eq!(
            view.active_tabs[&conversation.session.workspace_id],
            "session:session"
        );
        assert_eq!(core.processes.count(), 0);
        let target = crate::executor_settings::Target {
            workspace_id: conversation.session.workspace_id.clone(),
            session_id: Some("session".into()),
            executor: "codex".into(),
        };
        assert!(target.validate(&core.store, true).is_err());
        conversation.session.workspace_id
    };
    let document = crate::editor::open(&core, &workspace, "file.txt").unwrap();
    assert_eq!(document.body, "ручные правки");
    assert_eq!(document.base, "исходник");
    assert_eq!(document.disk.as_deref(), Some("исходник"));
    assert!(codex::start_command(
        &core,
        &workspace,
        "session",
        vec![json!({"type":"text","text":"продолжение"})],
        None,
        Command::new("/bin/sh").args(["-c", "touch duplicated"]),
        Arc::new(|_| Ok(())),
    )
    .is_err());
    assert!(!temp.path().join("duplicated").exists());
    assert_eq!(core.lock().unwrap().store.runs("session").unwrap().len(), 1);
    assert!(lifecycle::process_identity(pid).unwrap().is_some());
    drop(cleanup);
    let deadline = Instant::now() + Duration::from_secs(10);
    while lifecycle::process_identity(pid).unwrap().is_some() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut core = core.lock().unwrap();
    assert!(lifecycle::reconcile(&mut core).unwrap().is_empty());
    assert_eq!(
        core.store.snapshot().unwrap().sessions[0].state,
        "interrupted"
    );
    assert_eq!(core.store.runs("session").unwrap().len(), 1);
}

#[test]
fn reused_pid_is_not_adopted_or_killed_and_does_not_restart_work() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Прежняя работа").unwrap();
    let mut unrelated = Command::new("/bin/sleep").arg("300").spawn().unwrap();
    {
        let mut core = core.lock().unwrap();
        core.store
            .insert_run(&Run {
                id: "old-run".into(),
                session_id: session.id.clone(),
                state: "running".into(),
            })
            .unwrap();
        core.store.connection.execute("INSERT INTO processes(id,workspace_id,run_id,pid,process_group,state,identity) VALUES('old',?1,'old-run',?2,?2,'running','different-start-time')", rusqlite::params![workspace, unrelated.id()]).unwrap();
        assert!(lifecycle::reconcile(&mut core).unwrap().is_empty());
        assert_eq!(
            core.store.snapshot().unwrap().sessions[0].state,
            "interrupted"
        );
        assert_eq!(core.store.runs(&session.id).unwrap().len(), 1);
        assert_eq!(core.processes.count(), 0);
    }
    lifecycle::shutdown(&core, true).unwrap();
    let running = unrelated.try_wait().unwrap().is_none();
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    assert!(running);
}

#[test]
fn live_group_without_its_leader_and_legacy_records_require_reconciliation() {
    use std::os::unix::process::CommandExt;
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let mut leader = Command::new("/bin/sh")
        .args(["-c", "sleep 300 & echo $! > survivor; exit"])
        .current_dir(temp.path())
        .process_group(0)
        .spawn()
        .unwrap();
    let group = leader.id();
    leader.wait().unwrap();
    let survivor: i32 = std::fs::read_to_string(temp.path().join("survivor"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let mut legacy = Command::new("/bin/sleep").arg("300").spawn().unwrap();
    {
        let mut core = core.lock().unwrap();
        core.store.connection.execute("INSERT INTO processes(id,workspace_id,pid,process_group,state,identity) VALUES('group',?1,?2,?2,'running','old-identity')", rusqlite::params![workspace, group]).unwrap();
        core.store.connection.execute("INSERT INTO processes(id,workspace_id,pid,process_group,state) VALUES('legacy',?1,?2,?2,'running')", rusqlite::params![workspace, legacy.id()]).unwrap();
        let recovered = lifecycle::recover(&mut core).unwrap();
        assert_eq!(recovered.len(), 2);
        assert!(recovered.iter().all(|p| !p.verified));
        assert!(core.ensure_workspace_idle(&workspace).is_err());
    }
    lifecycle::shutdown(&core, true).unwrap();
    let running = legacy.try_wait().unwrap().is_none();
    legacy.kill().unwrap();
    legacy.wait().unwrap();
    unsafe {
        libc::kill(survivor, libc::SIGKILL);
    }
    assert!(running);
}

#[test]
fn manual_reconciliation_does_not_interrupt_current_workspace_operations() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let mut core = core.lock().unwrap();
    core.store.connection.execute("UPDATE workspaces SET operation_state='creating',preparation_state='pending' WHERE id=?1", [&workspace]).unwrap();
    lifecycle::reconcile(&mut core).unwrap();
    let current = core.store.workspace(&workspace).unwrap();
    assert_eq!(current.operation_state, "creating");
    assert_eq!(current.preparation_state, "pending");
    lifecycle::recover(&mut core).unwrap();
    let previous = core.store.workspace(&workspace).unwrap();
    assert_eq!(previous.operation_state, "error");
    assert_eq!(previous.preparation_state, "failed");
}

#[test]
fn failed_process_probe_preserves_history_and_requires_reconciliation() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let mut core = core.lock().unwrap();
    core.store.connection.execute("INSERT INTO processes(id,workspace_id,pid,process_group,state) VALUES('invalid',?1,0,0,'running')", [&workspace]).unwrap();
    let recovered = lifecycle::recover(&mut core).unwrap();
    assert_eq!(recovered.len(), 1);
    assert!(recovered[0].error.is_some());
    assert!(!recovered[0].verified);
    assert_eq!(core.store.snapshot().unwrap().workspaces[0].id, workspace);
    assert!(core.ensure_workspace_idle(&workspace).is_err());
}

#[test]
fn git_commit_requires_confirmation_and_finishes_before_exit() {
    use crate::{git, workspaces};
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    workspaces::git(temp.path(), &["init"]).unwrap();
    workspaces::git(temp.path(), &["config", "user.name", "Test"]).unwrap();
    workspaces::git(temp.path(), &["config", "user.email", "test@example.com"]).unwrap();
    workspaces::git(temp.path(), &["config", "commit.gpgSign", "false"]).unwrap();
    workspaces::git(temp.path(), &["config", "core.hooksPath", ".git/hooks"]).unwrap();
    std::fs::write(temp.path().join("file.txt"), "изменение").unwrap();
    workspaces::git(temp.path(), &["add", "file.txt"]).unwrap();
    let hook = temp.path().join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\ntouch hook-started\nwhile [ ! -f release-hook ]; do sleep 0.01; done\n",
    )
    .unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (core, workspace) = fixture(temp.path());
    let target = git::Target {
        workspace_id: workspace,
        repository: String::new(),
    };
    let worker_core = core.clone();
    let worker_target = target.clone();
    let commit = std::thread::spawn(move || {
        git::with_target(&worker_core, &worker_target, true, |repository| {
            git::commit(repository, "изменение")
        })
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !temp.path().join("hook-started").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(lifecycle::has_active_work(&core.lock().unwrap()).unwrap());
    assert!(lifecycle::shutdown(&core, false).is_err());
    assert!(!core.lock().unwrap().processes.closing);
    assert!(!commit.is_finished());
    let exit_core = core.clone();
    let exit = std::thread::spawn(move || lifecycle::shutdown(&exit_core, true));
    while !core.lock().unwrap().processes.closing {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!exit.is_finished());
    assert!(git::with_target(&core, &target, false, git::status).is_err());
    std::fs::write(temp.path().join("release-hook"), "").unwrap();
    commit.join().unwrap().unwrap();
    exit.join().unwrap().unwrap();
    assert_eq!(
        workspaces::git(temp.path(), &["log", "-1", "--format=%s"])
            .unwrap()
            .trim(),
        "изменение"
    );
    assert!(!lifecycle::has_active_work(&core.lock().unwrap()).unwrap());
}

#[test]
fn failed_git_operation_releases_exit_tracking() {
    use crate::{git, workspaces};
    let temp = tempfile::tempdir().unwrap();
    workspaces::git(temp.path(), &["init"]).unwrap();
    let (core, workspace) = fixture(temp.path());
    let target = git::Target {
        workspace_id: workspace,
        repository: String::new(),
    };
    assert!(git::with_target::<()>(&core, &target, true, |_| {
        assert!(lifecycle::has_active_work(&core.lock().unwrap()).unwrap());
        Err("ошибка операции".into())
    })
    .is_err());
    assert!(!lifecycle::has_active_work(&core.lock().unwrap()).unwrap());
    lifecycle::shutdown(&core, false).unwrap();
}
