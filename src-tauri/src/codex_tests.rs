use crate::{
    codex::{self, Publish},
    core::Core,
    model::*,
    store::Store,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn fixture(path: &Path) -> (Arc<Mutex<Core>>, String) {
    let mut store = Store::open(&path.join("state.db")).unwrap();
    if store.snapshot().unwrap().workspaces.is_empty() {
        store.register_folder("Проект", path, None).unwrap();
    }
    let workspace = store.snapshot().unwrap().workspaces[0].id.clone();
    (
        Arc::new(Mutex::new(Core {
            store,
            processes: Default::default(),
        })),
        workspace,
    )
}

fn start(
    core: &Arc<Mutex<Core>>,
    workspace: &str,
    session: &str,
    path: &Path,
    mode: &str,
    resume: &str,
    publish: Publish,
) -> Context {
    let mut command = Command::new("/bin/sh");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/codex.sh"
        ))
        .env("FAKE_LOG", path.join(format!("{session}.log")))
        .env("FAKE_MODE", mode)
        .env("FAKE_RESUME", resume)
        .env("FAKE_FINISH", path.join("finish"));
    codex::start_command(
        core,
        workspace,
        session,
        vec![json!({"type":"text","text":"сообщение"})],
        None,
        &mut command,
        publish,
    )
    .unwrap()
}

fn until(core: &Mutex<Core>, context: &Context, predicate: impl Fn(&Core) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let guard = core.lock().unwrap();
        if predicate(&guard) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "не дождались состояния: {:?}",
            guard.context_status(context)
        );
        drop(guard);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn finished(core: &Mutex<Core>, context: &Context) -> String {
    until(core, context, |core| {
        !core.processes.codex.contains_key(&context.run_id)
    });
    core.lock().unwrap().context_status(context).unwrap().state
}

fn quiet() -> Publish {
    Arc::new(|_| Ok(()))
}

#[test]
fn native_titles_replace_only_the_default_title_and_survive_reopening() {
    for mode in ["title_metadata", "title_event", ""] {
        for title in ["Новый чат", "Моё название"] {
            let temp = tempfile::tempdir().unwrap();
            let (core, workspace) = fixture(temp.path());
            let session = codex::create_session(&core, &workspace, title).unwrap();
            let context = start(
                &core,
                &workspace,
                &session.id,
                temp.path(),
                mode,
                "",
                quiet(),
            );
            assert_eq!(finished(&core, &context), "completed");
            if title == "Новый чат" && mode.is_empty() {
                until(&core, &context, |core| {
                    core.store.snapshot().unwrap().sessions[0].title != "Новый чат"
                });
            }
            let expected = if title == "Новый чат" {
                if mode.is_empty() {
                    "Краткое название разговора"
                } else {
                    "Название из Codex"
                }
            } else {
                title
            };
            let store = Store::open(&temp.path().join("state.db")).unwrap();
            assert_eq!(store.snapshot().unwrap().sessions[0].title, expected);
            let packets =
                std::fs::read_to_string(temp.path().join(format!("{}.log", session.id))).unwrap();
            assert_eq!(
                packets
                    .lines()
                    .filter(|line| line.contains("\"method\":\"turn/start\""))
                    .count(),
                if title == "Новый чат" && mode.is_empty() {
                    2
                } else {
                    1
                }
            );
        }
    }
}

#[test]
fn conversation_settings_are_sent_on_start_and_resume() {
    use crate::executor_settings::{self, Settings, Target};
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Настройки разговора").unwrap();
    executor_settings::save(
        &core.lock().unwrap().store,
        &Target {
            workspace_id: workspace.clone(),
            session_id: Some(session.id.clone()),
            executor: "codex".into(),
        },
        &Settings {
            model: Some("chosen".into()),
            work_mode: Some("plan".into()),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(true),
            ..Settings::default()
        },
    )
    .unwrap();
    for _ in 0..2 {
        let context = start(&core, &workspace, &session.id, temp.path(), "", "", quiet());
        assert_eq!(finished(&core, &context), "completed");
    }
    let packets: Vec<Value> =
        std::fs::read_to_string(temp.path().join(format!("{}.log", session.id)))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    for method in ["thread/start", "thread/resume"] {
        let params = &packets
            .iter()
            .find(|packet| packet["method"] == method)
            .unwrap()["params"];
        assert_eq!(params["model"], "chosen");
        assert_eq!(params["config"]["model_reasoning_effort"], "high");
        assert_eq!(params["serviceTier"], "priority");
    }
    let turns: Vec<_> = packets
        .iter()
        .filter(|packet| packet["method"] == "turn/start")
        .collect();
    assert_eq!(turns.len(), 2);
    for turn in turns {
        assert_eq!(
            turn["params"]["collaborationMode"],
            json!({"mode":"plan","settings":{"model":"chosen","reasoning_effort":"high","developer_instructions":null}})
        );
    }
}

#[test]
fn reopening_a_view_reads_running_conversation_and_terminal_without_restarting() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Возврат к работе").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "hold",
        "",
        quiet(),
    );
    until(&core, &context, |core| {
        core.context_status(&context).unwrap().state == "running"
    });
    let mut command = portable_pty::CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "while [ ! -f terminal-finish ]; do sleep 0.05; done; printf terminal-done",
    ]);
    let terminal = crate::terminal::start_command(
        &core,
        &workspace,
        command,
        crate::terminal::size(80, 24).unwrap(),
    )
    .unwrap();
    std::fs::write(temp.path().join("terminal-finish"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    loop {
        let frame = crate::terminal::read(&core, &workspace, &terminal.id).unwrap();
        output.extend(frame.data);
        if frame.info.state == "completed" && frame.output_done {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(String::from_utf8_lossy(&output).contains("terminal-done"));
    let guard = core.lock().unwrap();
    let conversation = crate::conversations::read(&guard, &session.id, None, None).unwrap();
    assert_eq!(conversation.context, Some(context.clone()));
    assert_eq!(conversation.session.state, "running");
    assert!(!conversation.messages.is_empty());
    assert_eq!(guard.store.runs(&session.id).unwrap().len(), 1);
    let log = std::fs::read_to_string(temp.path().join(format!("{}.log", session.id))).unwrap();
    assert_eq!(log.matches("\"method\":\"turn/start\"").count(), 1);
    drop(guard);
    codex::stop(&core, &context).unwrap();
}

#[test]
fn native_id_survives_restart_and_resume_never_falls_back_to_start() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Разговор").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        "",
        quiet(),
    );
    assert_eq!(finished(&core, &context), "completed");
    assert_eq!(
        core.lock().unwrap().store.snapshot().unwrap().sessions[0]
            .external_id
            .as_deref(),
        Some("native-thread")
    );
    drop(core);
    let (core, workspace) = fixture(temp.path());
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        "",
        quiet(),
    );
    assert_eq!(finished(&core, &context), "completed");
    let log = std::fs::read_to_string(temp.path().join(format!("{}.log", session.id))).unwrap();
    assert_eq!(log.matches("\"method\":\"thread/start\"").count(), 1);
    assert_eq!(log.matches("\"method\":\"thread/resume\"").count(), 1);
    let turn: Value = log
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rfind(|p| p["method"] == "turn/start")
        .unwrap();
    assert_eq!(
        turn["params"]["input"],
        json!([{"type":"text","text":"сообщение"}])
    );
    for reason in ["missing", "mismatch"] {
        let context = start(
            &core,
            &workspace,
            &session.id,
            temp.path(),
            "success",
            reason,
            quiet(),
        );
        assert_eq!(finished(&core, &context), "error");
    }
    let guard = core.lock().unwrap();
    assert_eq!(
        guard.store.snapshot().unwrap().sessions[0]
            .external_id
            .as_deref(),
        Some("native-thread")
    );
    assert_eq!(guard.store.messages(&session.id, 0).unwrap().len(), 4);
    assert_eq!(guard.processes.count(), 0);
}

#[test]
fn streaming_events_are_ordered_saved_before_publication_and_do_not_duplicate_text() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Поток").unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let saved = published.clone();
    let shared = Arc::downgrade(&core);
    let publish: Publish = Arc::new(move |event| {
        let shared = shared.upgrade().unwrap();
        let guard = shared.lock().unwrap();
        let stored: String = guard
            .store
            .connection
            .query_row(
                "SELECT kind FROM events WHERE sequence=?1",
                [event.sequence],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, event.kind);
        if event.kind == "message_delta" {
            let messages = guard.store.messages(&event.context.session_id, 0).unwrap();
            assert_eq!(messages.last().unwrap().role, "assistant");
            assert!(!messages.last().unwrap().body.is_empty());
        }
        saved.lock().unwrap().push(event.clone());
        Ok(())
    });
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        "",
        publish,
    );
    assert_eq!(finished(&core, &context), "completed");
    until(&core, &context, |_| {
        published
            .lock()
            .unwrap()
            .last()
            .is_some_and(|e| e.kind == "state" && e.payload["state"] == "completed")
    });
    let guard = core.lock().unwrap();
    let messages = guard.store.messages(&session.id, 0).unwrap();
    assert_eq!(
        messages.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        ["сообщение", "привет"]
    );
    let events = guard.store.events(&session.id, 0).unwrap();
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    let kinds: Vec<_> = events.iter().map(|e| e.kind.as_str()).collect();
    let action = kinds.iter().position(|&k| k == "action_started").unwrap();
    let deltas: Vec<_> = kinds
        .iter()
        .enumerate()
        .filter_map(|(i, &k)| (k == "message_delta").then_some(i))
        .collect();
    assert_eq!(deltas.len(), 2);
    assert!(deltas[0] < action && action < deltas[1]);
    assert!(kinds.contains(&"action_output"));
    assert!(kinds.contains(&"action_completed"));
    assert_eq!(published.lock().unwrap().len(), events.len());
    assert_eq!(
        guard
            .store
            .events(&session.id, events[2].sequence)
            .unwrap()
            .len(),
        events.len() - 3
    );
    assert!(guard.store.events("missing", 0).unwrap().is_empty());
}

#[test]
fn failures_and_disconnects_keep_partial_messages_without_false_success() {
    for mode in ["failure", "completed_with_error", "disconnect", "malformed"] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace) = fixture(temp.path());
        let session = codex::create_session(&core, &workspace, "Ошибка").unwrap();
        let context = start(
            &core,
            &workspace,
            &session.id,
            temp.path(),
            mode,
            "",
            quiet(),
        );
        assert_eq!(
            finished(&core, &context),
            if ["failure", "completed_with_error"].contains(&mode) {
                "failed"
            } else {
                "error"
            }
        );
        let guard = core.lock().unwrap();
        let messages = guard.store.messages(&session.id, 0).unwrap();
        assert_eq!(
            messages[1].body,
            if ["disconnect", "malformed"].contains(&mode) {
                "при"
            } else {
                "привет"
            }
        );
        assert_eq!(guard.processes.count(), 0);
        let events = guard.store.events(&session.id, 0).unwrap();
        assert_ne!(events.last().unwrap().payload["state"], "completed");
    }
}

#[test]
fn failed_history_write_is_reported_without_publishing_saved_messages() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Ошибка сохранения").unwrap();
    core.lock().unwrap().store.connection.execute_batch("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL,'запись запрещена'); END;").unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let saved = published.clone();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        "",
        Arc::new(move |event| {
            saved.lock().unwrap().push(event.clone());
            Ok(())
        }),
    );
    assert_eq!(finished(&core, &context), "error");
    assert!(core
        .lock()
        .unwrap()
        .store
        .messages(&session.id, 0)
        .unwrap()
        .is_empty());
    assert!(!published
        .lock()
        .unwrap()
        .iter()
        .any(|e| e.kind == "message"));
    assert!(
        published.lock().unwrap().last().unwrap().payload["detail"]["message"]
            .as_str()
            .unwrap()
            .contains("запись запрещена")
    );
}

#[test]
fn permissions_in_parallel_sessions_and_stale_replies_remain_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let first = codex::create_session(&core, &workspace, "Первый").unwrap();
    let second = codex::create_session(&core, &workspace, "Второй").unwrap();
    let a = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "wait",
        "",
        quiet(),
    );
    let b = start(
        &core,
        &workspace,
        &second.id,
        temp.path(),
        "wait",
        "",
        quiet(),
    );
    for context in [&a, &b] {
        until(&core, context, |core| {
            core.context_status(context).unwrap().state == "waiting"
        });
    }
    let foreign = Context {
        run_id: b.run_id.clone(),
        ..a.clone()
    };
    assert!(codex::reply(
        &core,
        &foreign,
        json!("approval"),
        json!({"decision":"accept"})
    )
    .is_err());
    assert!(codex::reply(&core, &a, json!("approval"), json!({"decision":"invalid"})).is_err());
    assert_eq!(
        core.lock().unwrap().context_status(&a).unwrap().state,
        "waiting"
    );
    codex::reply(&core, &a, json!("approval"), json!({"decision":"decline"})).unwrap();
    assert_eq!(finished(&core, &a), "completed");
    assert_eq!(
        core.lock().unwrap().context_status(&b).unwrap().state,
        "waiting"
    );
    assert!(codex::reply(&core, &a, json!("approval"), json!({"decision":"accept"})).is_err());
    let next = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "wait",
        "",
        quiet(),
    );
    until(&core, &next, |core| {
        core.context_status(&next).unwrap().state == "waiting"
    });
    assert!(codex::reply(&core, &a, json!("approval"), json!({"decision":"accept"})).is_err());
    assert_eq!(
        core.lock().unwrap().context_status(&next).unwrap().state,
        "waiting"
    );
    codex::reply(&core, &b, json!("approval"), json!({"decision":"accept"})).unwrap();
    assert_eq!(finished(&core, &b), "completed");
    codex::stop(&core, &next).unwrap();
    assert_eq!(finished(&core, &next), "interrupted");
    assert!(core
        .lock()
        .unwrap()
        .store
        .events(&a.session_id, 0)
        .unwrap()
        .iter()
        .any(|e| e.kind == "request_answer" && e.payload["result"]["decision"] == "decline"));
}

#[test]
fn resolved_server_request_cannot_be_answered() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Снятый запрос").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "resolved",
        "",
        quiet(),
    );
    until(&core, &context, |core| {
        core.store
            .events(&session.id, 0)
            .unwrap()
            .iter()
            .any(|e| e.kind == "request_resolved")
    });
    assert_eq!(
        core.lock().unwrap().context_status(&context).unwrap().state,
        "running"
    );
    assert!(codex::reply(
        &core,
        &context,
        json!("approval"),
        json!({"decision":"accept"})
    )
    .is_err());
    codex::stop(&core, &context).unwrap();
    assert_eq!(finished(&core, &context), "interrupted");
}

#[test]
fn async_input_questions_remain_available_after_completion_and_reopening() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Вопросы").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "async_input",
        "",
        quiet(),
    );
    assert_eq!(finished(&core, &context), "completed");
    drop(core);
    let core = Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    };
    let data = crate::conversations::read(&core, &session.id, None, None).unwrap();
    let question = data
        .events
        .iter()
        .find(|event| event.kind == "message_completed" && event.payload["itemId"] == "question-1")
        .expect("вопрос должен остаться в истории");
    assert_eq!(
        question.payload["questions"],
        json!([
            {"title":"Что хочешь сделать дальше?","options":null},
            {"title":"Как проверить?","options":["Тесты","Вручную"]},
        ])
    );
    assert!(data.messages.iter().any(|message| {
        json!(message.sequence) == question.payload["sequence"]
            && message.body == "Что хочешь сделать дальше?"
    }));
    assert!(data.requests.is_empty());
}

#[test]
fn native_permission_and_input_requests_receive_their_own_response_shape() {
    for (mode, response) in [
        ("input", json!({"answers":{"q":{"answers":["ответ"]}}})),
        (
            "permissions",
            json!({"permissions":{"fileSystem":{"write":["/tmp/allowed"]}},"scope":"turn"}),
        ),
        ("elicitation", json!({"action":"decline","content":null})),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace) = fixture(temp.path());
        let session = codex::create_session(&core, &workspace, "Ввод").unwrap();
        let context = start(
            &core,
            &workspace,
            &session.id,
            temp.path(),
            mode,
            "",
            quiet(),
        );
        until(&core, &context, |core| {
            core.store
                .events(&session.id, 0)
                .unwrap()
                .iter()
                .any(|e| e.kind == "request")
        });
        assert_eq!(
            core.lock().unwrap().context_status(&context).unwrap().state,
            if mode == "input" {
                "running"
            } else {
                "waiting"
            }
        );
        codex::reply(&core, &context, json!("approval"), response.clone()).unwrap();
        assert_eq!(finished(&core, &context), "completed");
        let log = std::fs::read_to_string(temp.path().join(format!("{}.log", session.id))).unwrap();
        assert!(log.lines().any(|line| serde_json::from_str::<Value>(line)
            .is_ok_and(|p| p["id"] == "approval" && p["result"] == response)));
    }
}

#[test]
fn mcp_initialization_requests_do_not_require_a_turn_and_remain_run_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Инициализация MCP").unwrap();
    let mut previous = None;
    for _ in 0..2 {
        let context = start(
            &core,
            &workspace,
            &session.id,
            temp.path(),
            "elicitation_before_turn",
            "",
            quiet(),
        );
        until(&core, &context, |core| {
            core.store.events(&session.id, 0).unwrap().iter().any(|e| {
                e.context == context && e.kind == "request" && e.payload["requestId"] == "approval"
            })
        });
        let events = core.lock().unwrap().store.events(&session.id, 0).unwrap();
        let events: Vec<_> = events.iter().filter(|e| e.context == context).collect();
        assert_eq!(events.iter().filter(|e| e.kind == "request").count(), 1);
        assert!(!events.iter().any(|e| e.payload.get("turnId").is_some()));
        assert_eq!(
            core.lock().unwrap().context_status(&context).unwrap().state,
            "waiting"
        );
        let response = json!({"action":"accept","content":{}});
        if let Some(previous) = &previous {
            assert!(codex::reply(&core, previous, json!("approval"), response.clone()).is_err());
        }
        codex::reply(&core, &context, json!("approval"), response.clone()).unwrap();
        assert_eq!(finished(&core, &context), "completed");
        let log = std::fs::read_to_string(temp.path().join(format!("{}.log", session.id))).unwrap();
        let packets: Vec<Value> = log
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for id in ["foreign-thread", "foreign-turn", "missing-turn"] {
            assert!(packets
                .iter()
                .any(|p| p["id"] == id && p["error"]["code"] == -32601));
        }
        assert!(packets
            .iter()
            .any(|p| p["id"] == "approval" && p["result"] == response));
        previous = Some(context);
    }
}

#[test]
fn a_foreign_native_request_is_refused_without_asking_for_permission() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Чужой запрос").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "foreign",
        "",
        quiet(),
    );
    assert_eq!(finished(&core, &context), "completed");
    assert!(!core
        .lock()
        .unwrap()
        .store
        .events(&session.id, 0)
        .unwrap()
        .iter()
        .any(|e| e.kind == "request"));
    let log = std::fs::read_to_string(temp.path().join(format!("{}.log", session.id))).unwrap();
    assert!(log.lines().any(|line| serde_json::from_str::<Value>(line)
        .is_ok_and(|p| p["id"] == "foreign" && p["error"]["code"] == -32601)));
}

#[test]
fn interruption_waits_for_confirmation_and_stops_only_the_selected_run() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let a = codex::create_session(&core, &workspace, "Остановить").unwrap();
    let b = codex::create_session(&core, &workspace, "Продолжить").unwrap();
    let a = start(&core, &workspace, &a.id, temp.path(), "hold", "", quiet());
    let b = start(&core, &workspace, &b.id, temp.path(), "hold", "", quiet());
    for context in [&a, &b] {
        until(&core, context, |core| {
            core.store
                .events(&context.session_id, 0)
                .unwrap()
                .iter()
                .any(|e| e.kind == "action_started")
        });
    }
    assert!(core
        .lock()
        .unwrap()
        .ensure_workspace_idle(&workspace)
        .is_err());
    codex::interrupt(&core, &a).unwrap();
    assert_eq!(
        core.lock().unwrap().context_status(&a).unwrap().state,
        "stopping"
    );
    assert_eq!(
        core.lock().unwrap().context_status(&b).unwrap().state,
        "running"
    );
    assert_eq!(core.lock().unwrap().processes.count(), 2);
    std::fs::write(temp.path().join("finish"), "").unwrap();
    assert_eq!(finished(&core, &a), "interrupted");
    assert_eq!(
        core.lock().unwrap().context_status(&b).unwrap().state,
        "running"
    );
    assert_eq!(core.lock().unwrap().processes.count(), 1);
    codex::stop(&core, &b).unwrap();
    assert_eq!(finished(&core, &b), "interrupted");
    core.lock()
        .unwrap()
        .ensure_workspace_idle(&workspace)
        .unwrap();
}

#[test]
fn stopped_process_and_final_state_can_be_saved_again_after_a_write_failure() {
    for trigger in [
        "CREATE TRIGGER fail_save BEFORE UPDATE ON processes WHEN NEW.state='stopped' BEGIN SELECT RAISE(FAIL,'запись процесса запрещена'); END;",
        "CREATE TRIGGER fail_save BEFORE UPDATE ON runs WHEN NEW.state='completed' BEGIN SELECT RAISE(FAIL,'запись результата запрещена'); END;",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace) = fixture(temp.path());
        let session = codex::create_session(&core,&workspace,"Повтор сохранения").unwrap();
        core.lock().unwrap().store.connection.execute_batch(trigger).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let published = events.clone();
        let context = start(&core,&workspace,&session.id,temp.path(),"success","",Arc::new(move |event|{published.lock().unwrap().push(event.clone());Ok(())}));
        until(&core,&context,|core|core.context_status(&context).unwrap().state=="error" || events.lock().unwrap().iter().any(|e|e.kind=="save_error"));
        assert_ne!(core.lock().unwrap().context_status(&context).unwrap().state,"completed");
        assert!(
            crate::conversations::read(&core.lock().unwrap(), &session.id, None, None)
                .unwrap()
                .can_stop
        );
        core.lock().unwrap().store.connection.execute_batch("DROP TRIGGER fail_save").unwrap();
        codex::stop(&core,&context).unwrap();
        assert_eq!(finished(&core,&context),"completed");
        assert_eq!(core.lock().unwrap().processes.count(),0);
        assert!(
            !crate::conversations::read(&core.lock().unwrap(), &session.id, None, None)
                .unwrap()
                .can_stop
        );
    }
}

#[test]
#[ignore = "запускает и прерывает команду установленного Codex со штатной подпиской"]
fn local_codex_interrupt_is_confirmed_and_other_session_remains_available() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let first = codex::create_session(&core, &workspace, "Проверка прерывания").unwrap();
    let second = codex::create_session(&core, &workspace, "Независимый разговор").unwrap();
    let settings = crate::executor_settings::Settings {
        sandbox: Some("read-only".into()),
        ..Default::default()
    };
    for session in [&first, &second] {
        crate::executor_settings::save(
            &core.lock().unwrap().store,
            &crate::executor_settings::Target {
                workspace_id: workspace.clone(),
                session_id: Some(session.id.clone()),
                executor: "codex".into(),
            },
            &settings,
        )
        .unwrap();
    }
    let a = codex::start(&core,&workspace,&first.id,vec![json!({"type":"text","text":"Выполни команду /bin/sleep 120 через инструмент команд. Дождись завершения. Не запускай фоновые процессы."})],None,quiet()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let guard = core.lock().unwrap();
        let events = guard.store.events(&first.id, 0).unwrap();
        if events
            .iter()
            .any(|e| e.kind == "action_started" && e.payload["type"] == "commandExecution")
        {
            break;
        }
        assert!(Instant::now() < deadline, "не дождались команды Codex");
        assert!(
            guard.processes.codex.contains_key(&a.run_id),
            "Codex завершился до команды: {:?}",
            events.last()
        );
        drop(guard);
        std::thread::sleep(Duration::from_millis(50));
    }
    let b = codex::start(
        &core,
        &workspace,
        &second.id,
        vec![
            json!({"type":"text","text":"Ответь ровно INDEPENDENT_OK. Не используй инструменты."}),
        ],
        None,
        quiet(),
    )
    .unwrap();
    codex::interrupt(&core, &a).unwrap();
    wait_real(&core, &a);
    assert_eq!(finished(&core, &a), "interrupted");
    wait_real(&core, &b);
    assert_eq!(finished(&core, &b), "completed");
    let guard = core.lock().unwrap();
    let events = guard.store.events(&first.id, 0).unwrap();
    assert!(events
        .iter()
        .any(|e| e.kind == "state" && e.payload["state"] == "stopping"));
    assert_eq!(events.last().unwrap().payload["state"], "interrupted");
    assert!(guard
        .store
        .messages(&second.id, 0)
        .unwrap()
        .iter()
        .any(|m| m.role == "assistant" && m.body.contains("INDEPENDENT_OK")));
    assert_eq!(guard.processes.count(), 0);
    println!("Codex: turn/interrupt подтверждён как interrupted, независимый разговор завершён как completed, процессы остановлены");
}

#[test]
#[ignore = "отправляет сообщения установленному Codex со штатной подпиской"]
fn local_codex_conversation_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Проверка продолжения").unwrap();
    let target = crate::executor_settings::Target {
        workspace_id: workspace.clone(),
        session_id: Some(session.id.clone()),
        executor: "codex".into(),
    };
    crate::executor_settings::save(
        &core.lock().unwrap().store,
        &target,
        &crate::executor_settings::Settings {
            sandbox: Some("read-only".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let marker = format!("CHECK_{}", uuid::Uuid::new_v4().simple());
    let context = codex::start(&core,&workspace,&session.id,vec![json!({"type":"text","text":format!("Запомни строку {marker}. Ответь только этой строкой. Не используй инструменты.")})],None,quiet()).unwrap();
    wait_real(&core, &context);
    assert_eq!(finished(&core, &context), "completed");
    let native = core.lock().unwrap().store.snapshot().unwrap().sessions[0]
        .external_id
        .clone()
        .unwrap();
    drop(core);
    let (core, workspace) = fixture(temp.path());
    let context = codex::start(&core,&workspace,&session.id,vec![json!({"type":"text","text":"Какую строку я просил запомнить? Ответь только ей. Не используй инструменты."})],None,quiet()).unwrap();
    wait_real(&core, &context);
    assert_eq!(finished(&core, &context), "completed");
    let guard = core.lock().unwrap();
    assert_eq!(
        guard.store.snapshot().unwrap().sessions[0]
            .external_id
            .as_deref(),
        Some(native.as_str())
    );
    let messages = guard.store.messages(&session.id, 0).unwrap();
    assert!(messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .unwrap()
        .body
        .contains(&marker));
    println!("Codex: исходный разговор продолжен новым процессом, строка восстановлена без отправки истории");
}

fn wait_real(core: &Mutex<Core>, context: &Context) {
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        let guard = core.lock().unwrap();
        if !guard.processes.codex.contains_key(&context.run_id) {
            return;
        }
        assert!(Instant::now() < deadline, "Codex не завершил проверку");
        drop(guard);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn stop_remains_available_while_large_turn_input_is_not_read() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = codex::create_session(&core, &workspace, "Зависшая запись").unwrap();
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(
        r#"while IFS= read -r request; do
    case "$request" in
        *'"method":"initialize"'*) echo '{"id":1,"result":{}}';;
        *'"method":"account/read"'*) echo '{"id":2,"result":{"account":{"type":"chatgpt"}}}';;
        *'"method":"config/read"'*) echo '{"id":3,"result":{"config":{"model_provider":"openai"}}}';;
        *'"method":"thread/start"'*)
            echo '{"id":4,"result":{"thread":{"id":"blocked-thread"}}}'
            exec /bin/sleep 120;;
    esac
done"#,
    );
    let context = codex::start_command(
        &core,
        &workspace,
        &session.id,
        vec![json!({"type":"text","text":"x".repeat(2 * 1024 * 1024)})],
        None,
        &mut command,
        quiet(),
    )
    .unwrap();
    until(&core, &context, |core| {
        !core.store.messages(&session.id, 0).unwrap().is_empty()
    });
    let started = Instant::now();
    codex::stop(&core, &context).unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(finished(&core, &context), "interrupted");
    let guard = core.lock().unwrap();
    assert_eq!(guard.processes.count(), 0);
    let state: String = guard
        .store
        .connection
        .query_row(
            "SELECT state FROM processes WHERE run_id=?1",
            [&context.run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "stopped");
}
