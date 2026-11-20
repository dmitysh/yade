use super::*;
use std::{path::Path, sync::Arc};

fn fixture(path: &Path, executor: &str) -> (Arc<Mutex<Core>>, String, String) {
    let mut store = Store::open(&path.join("state.db")).unwrap();
    store.register_folder("Проект", path, None).unwrap();
    let workspace = store.snapshot().unwrap().workspaces[0].id.clone();
    let core = Arc::new(Mutex::new(Core {
        store,
        processes: Default::default(),
    }));
    let session = if executor == "codex" {
        crate::codex::create_session(&core, &workspace, "Новый чат")
    } else {
        crate::claude::create_session(&core, &workspace, "Новый чат")
    }
    .unwrap();
    (core, workspace, session.id)
}

fn start(
    core: &Arc<Mutex<Core>>,
    workspace: &str,
    session: &str,
    path: &Path,
    executor: &str,
    mode: &str,
) -> Context {
    let mut command = if executor == "codex" {
        let mut command = Command::new("/bin/sh");
        command.arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/codex.sh"
        ));
        command
    } else {
        let mut command = Command::new(crate::executors::executable("node").unwrap());
        command.args([
            "--experimental-strip-types",
            concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/claude.mjs"),
        ]);
        command
    };
    command
        .env("FAKE_MODE", mode)
        .env("FAKE_LOG", path.join("packets.log"))
        .env("FAKE_FINISH", path.join("finish"));
    let input = vec![json!({"type":"text","text":"Исправь восстановление вкладок"})];
    let publish: Publish = Arc::new(|_| Ok(()));
    if executor == "codex" {
        crate::codex::start_command(core, workspace, session, input, None, &mut command, publish)
    } else {
        crate::claude::start_command(
            core,
            workspace,
            session,
            input,
            None,
            None,
            Path::new("/installed/claude"),
            &mut command,
            publish,
        )
    }
    .unwrap()
}

fn until(core: &Mutex<Core>, predicate: impl Fn(&Core) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if predicate(&core.lock().unwrap()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "не дождались результата названия"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn packets(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path.join("packets.log"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn title_requests(path: &Path, executor: &str) -> Vec<Value> {
    packets(path)
        .into_iter()
        .filter(|p| {
            if executor == "codex" {
                p["method"] == "thread/start" && p["params"]["ephemeral"] == true
            } else {
                p["title"] == true
            }
        })
        .collect()
}

#[test]
fn terminal_background_titles_share_generation_without_creating_history() {
    for executor in ["codex", "claude"] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace, _) = fixture(temp.path(), executor);
        let mut command = if executor == "codex" {
            let mut command = Command::new("/bin/sh");
            command.arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/test-fixtures/codex.sh"
            ));
            command
        } else {
            let mut command = Command::new(crate::executors::executable("node").unwrap());
            command.args([
                "--experimental-strip-types",
                concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/claude.mjs"),
            ]);
            command
        };
        command.env("FAKE_LOG", temp.path().join("packets.log"));
        let (process, input, output) = {
            let mut guard = core.lock().unwrap();
            let Core { store, processes } = &mut *guard;
            processes
                .spawn_background_stdio(store, &workspace, &mut command)
                .unwrap()
        };
        let context = Context {
            workspace_id: workspace.clone(),
            session_id: "terminal".into(),
            run_id: "20".into(),
        };
        let params = if executor == "codex" {
            json!({"cwd":temp.path()})
        } else {
            json!({"context":context,"cwd":temp.path(),"path":"/installed/claude","settings":{}})
        };
        let title = generate(
            &mut Rpc::new(input, output),
            executor,
            params,
            &title_prompt(
                "Исправь восстановление вкладок",
                "Восстановление исправлено",
            ),
            &context,
        )
        .unwrap();
        assert_eq!(title, "Краткое название разговора");
        let mut guard = core.lock().unwrap();
        let Core { store, processes } = &mut *guard;
        assert!(processes
            .stop_background(store, "другое пространство", &process)
            .is_err());
        processes
            .stop_background(store, &workspace, &process)
            .unwrap();
        assert_eq!(processes.count(), 0);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert!(store.runs(&snapshot.sessions[0].id).unwrap().is_empty());
        assert_eq!(snapshot.sessions[0].title, "Новый чат");
        assert_eq!(title_requests(temp.path(), executor).len(), 1);
        if executor == "codex" {
            let params = &title_requests(temp.path(), executor)[0]["params"];
            assert_eq!(params["sandbox"], "read-only");
            assert_eq!(params["config"]["features.shell_tool"], false);
        } else {
            let options = &title_requests(temp.path(), executor)[0]["options"];
            assert_eq!(options["tools"], json!([]));
            assert_eq!(options["persistSession"], false);
        }
    }
}

#[test]
fn terminal_background_processes_are_stopped_with_the_application() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace, _) = fixture(temp.path(), "codex");
    let mut guard = core.lock().unwrap();
    let Core { store, processes } = &mut *guard;
    let (id, _input, _output) = processes
        .spawn_background_stdio(store, &workspace, Command::new("/bin/sleep").arg("60"))
        .unwrap();
    assert!(processes.has_workspace(&workspace));
    processes.stop_all(store).unwrap();
    assert!(!processes.contains(&id));
    assert_eq!(processes.count(), 0);
}

#[test]
fn both_executors_generate_once_without_adding_messages_or_changing_native_identity() {
    for executor in ["codex", "claude"] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace, session) = fixture(temp.path(), executor);
        let context = start(
            &core,
            &workspace,
            &session,
            temp.path(),
            executor,
            "success",
        );
        until(&core, |core| {
            core.store.snapshot().unwrap().sessions[0].title == "Краткое название разговора"
        });
        {
            let guard = core.lock().unwrap();
            let data = crate::conversations::read(&guard, &session, None, None).unwrap();
            assert_eq!(data.messages.len(), 2);
            assert_eq!(
                data.session.external_id.as_deref(),
                Some(if executor == "codex" {
                    "native-thread"
                } else {
                    "native-claude"
                })
            );
            assert!(!data.can_stop);
            assert_eq!(data.session.state, "completed");
            assert!(guard
                .store
                .events(&session, 0)
                .unwrap()
                .iter()
                .any(|event| event.kind == "session_title" && event.context == context));
        }
        let requests = title_requests(temp.path(), executor);
        assert_eq!(requests.len(), 1);
        if executor == "codex" {
            let params = &requests[0]["params"];
            assert_eq!(params["approvalPolicy"], "never");
            assert_eq!(params["sandbox"], "read-only");
            assert_eq!(params["config"]["features.shell_tool"], false);
            let input = packets(temp.path())
                .into_iter()
                .find(|p| p["method"] == "turn/start" && p["params"]["threadId"] == "title-thread")
                .unwrap();
            let prompt = input["params"]["input"][0]["text"].as_str().unwrap();
            assert!(prompt.contains("Исправь восстановление вкладок") && prompt.contains("привет"));
        } else {
            let prompt = requests[0]["prompt"].as_str().unwrap();
            assert!(
                prompt.contains("Исправь восстановление вкладок")
                    && prompt.contains("Частичный ответ")
            );
        }
        start(
            &core,
            &workspace,
            &session,
            temp.path(),
            executor,
            "success",
        );
        until(&core, |core| {
            core.store.runs(&session).unwrap().len() == 2
                && core.store.snapshot().unwrap().sessions[0].state == "completed"
                && core.processes.count() == 0
        });
        assert_eq!(title_requests(temp.path(), executor).len(), 1);
        let store = Store::open(&temp.path().join("state.db")).unwrap();
        assert_eq!(
            store.snapshot().unwrap().sessions[0].title,
            "Краткое название разговора"
        );
    }
}

#[test]
fn title_failure_or_invalid_result_keeps_the_completed_response_and_is_not_retried() {
    for (executor, mode) in [
        ("codex", "title_failure"),
        ("claude", "title_failure"),
        ("claude", "title_invalid"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace, session) = fixture(temp.path(), executor);
        start(&core, &workspace, &session, temp.path(), executor, mode);
        until(&core, |core| {
            !title_requests(temp.path(), executor).is_empty() && core.processes.count() == 0
        });
        assert_eq!(
            core.lock().unwrap().store.snapshot().unwrap().sessions[0].title,
            "Новый чат"
        );
        start(
            &core,
            &workspace,
            &session,
            temp.path(),
            executor,
            "success",
        );
        until(&core, |core| {
            core.store.runs(&session).unwrap().len() == 2
                && core.store.snapshot().unwrap().sessions[0].state == "completed"
                && core.processes.count() == 0
        });
        let guard = core.lock().unwrap();
        assert_eq!(
            crate::conversations::read(&guard, &session, None, None)
                .unwrap()
                .messages
                .len(),
            4
        );
        assert_eq!(title_requests(temp.path(), executor).len(), 1);
        assert_eq!(
            guard.store.snapshot().unwrap().sessions[0].title,
            "Новый чат"
        );
    }
}

#[test]
fn pending_title_does_not_block_the_next_message_or_replace_a_manual_title() {
    for executor in ["codex", "claude"] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace, session) = fixture(temp.path(), executor);
        start(
            &core,
            &workspace,
            &session,
            temp.path(),
            executor,
            "title_wait",
        );
        until(&core, |core| {
            !title_requests(temp.path(), executor).is_empty()
                && !crate::conversations::read(core, &session, None, None)
                    .unwrap()
                    .can_stop
        });
        crate::conversations::rename(&mut core.lock().unwrap().store, &session, "Новый чат")
            .unwrap();
        start(
            &core,
            &workspace,
            &session,
            temp.path(),
            executor,
            "success",
        );
        until(&core, |core| {
            core.store.runs(&session).unwrap().len() == 2
                && core.store.snapshot().unwrap().sessions[0].state == "completed"
        });
        std::fs::write(temp.path().join("finish"), "").unwrap();
        until(&core, |core| core.processes.count() == 0);
        let guard = core.lock().unwrap();
        assert_eq!(
            guard.store.snapshot().unwrap().sessions[0].title,
            "Новый чат"
        );
        assert_eq!(title_requests(temp.path(), executor).len(), 1);
    }
}
