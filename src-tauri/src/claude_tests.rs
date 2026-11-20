use crate::{claude, codex::Publish, core::Core, model::*, store::Store};
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
    publish: Publish,
) -> Context {
    let mut command = Command::new(crate::executors::executable("node").unwrap());
    command
        .arg("--experimental-strip-types")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/claude.mjs"
        ))
        .env("FAKE_LOG", path.join(format!("{session}.log")))
        .env("FAKE_MODE", mode)
        .env("FAKE_FINISH", path.join(format!("{session}.finish")));
    claude::start_command(
        core,
        workspace,
        session,
        vec![json!({"type":"text","text":"Новое сообщение"})],
        None,
        None,
        Path::new("/installed/claude"),
        &mut command,
        publish,
    )
    .unwrap()
}

fn quiet() -> Publish {
    Arc::new(|_| Ok(()))
}

#[test]
fn native_titles_replace_only_the_default_title_and_survive_reopening() {
    for mode in [
        "title",
        "title_summary",
        "title_empty",
        "title_error",
        "success",
    ] {
        for title in ["Новый чат", "Моё название"] {
            let temp = tempfile::tempdir().unwrap();
            let (core, workspace) = fixture(temp.path());
            let session = claude::create_session(&core, &workspace, title).unwrap();
            let context = start(&core, &workspace, &session.id, temp.path(), mode, quiet());
            assert_eq!(finished(&core, &context), "completed");
            if title == "Новый чат" && !["title", "title_summary"].contains(&mode) {
                until(&core, &context, |core| {
                    core.store.snapshot().unwrap().sessions[0].title != "Новый чат"
                });
            }
            let expected = match (title, mode) {
                ("Новый чат", "title") => "Название из Claude",
                ("Новый чат", "title_summary") => "Сводка из Claude",
                ("Новый чат", _) => "Краткое название разговора",
                _ => title,
            };
            let store = Store::open(&temp.path().join("state.db")).unwrap();
            assert_eq!(store.snapshot().unwrap().sessions[0].title, expected);
        }
    }
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
            "не дождались состояния: {:?}; процессов: {}; последнее событие: {:?}",
            guard.context_status(context),
            guard.processes.count(),
            guard.store.events(&context.session_id, 0).unwrap().last()
        );
        drop(guard);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn finished(core: &Mutex<Core>, context: &Context) -> String {
    until(core, context, |core| {
        !core.processes.claude.contains_key(&context.run_id)
    });
    core.lock().unwrap().context_status(context).unwrap().state
}

fn request(core: &Mutex<Core>, context: &Context) -> Value {
    until(core, context, |core| {
        core.store
            .events(&context.session_id, 0)
            .unwrap()
            .iter()
            .any(|e| e.context == *context && e.kind == "request")
    });
    core.lock()
        .unwrap()
        .store
        .events(&context.session_id, 0)
        .unwrap()
        .into_iter()
        .find(|e| e.context == *context && e.kind == "request")
        .unwrap()
        .payload["requestId"]
        .clone()
}

#[test]
fn claude_native_id_survives_restart_and_missing_resume_never_starts_another_conversation() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Разговор").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        quiet(),
    );
    assert_eq!(finished(&core, &context), "completed");
    assert_eq!(
        core.lock().unwrap().store.snapshot().unwrap().sessions[0]
            .external_id
            .as_deref(),
        Some("native-claude")
    );
    drop(core);
    let (core, workspace) = fixture(temp.path());
    assert_eq!(core.lock().unwrap().processes.count(), 0);
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        quiet(),
    );
    assert_eq!(finished(&core, &context), "completed");
    let log: Vec<Value> = std::fs::read_to_string(temp.path().join(format!("{}.log", session.id)))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let launches: Vec<_> = log.iter().filter(|l| l.get("options").is_some()).collect();
    assert!(launches[0]["options"]["resume"].is_null());
    assert_eq!(launches[1]["options"]["resume"], "native-claude");
    assert_eq!(
        launches[1]["input"]["message"]["content"],
        json!([{"type":"text","text":"Новое сообщение"}])
    );
    for mode in ["missing", "mismatch"] {
        let context = start(&core, &workspace, &session.id, temp.path(), mode, quiet());
        assert_eq!(finished(&core, &context), "error");
    }
    let guard = core.lock().unwrap();
    assert_eq!(
        guard.store.snapshot().unwrap().sessions[0]
            .external_id
            .as_deref(),
        Some("native-claude")
    );
    assert_eq!(guard.store.messages(&session.id, 0).unwrap().len(), 4);
    assert_eq!(guard.processes.count(), 0);
}

#[test]
fn claude_stream_is_saved_before_publication_and_final_message_does_not_duplicate_deltas() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Поток").unwrap();
    let shared = Arc::downgrade(&core);
    let published = Arc::new(Mutex::new(Vec::new()));
    let saved = published.clone();
    let publish: Publish = Arc::new(move |event| {
        let core = shared.upgrade().unwrap();
        let guard = core.lock().unwrap();
        assert!(guard
            .store
            .events(&event.context.session_id, 0)
            .unwrap()
            .iter()
            .any(|e| e.sequence == event.sequence));
        if event.kind == "message_delta" {
            assert_ne!(
                guard.context_status(&event.context).unwrap().state,
                "completed"
            );
        }
        saved.lock().unwrap().push(event.kind.clone());
        Ok(())
    });
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "blocks",
        publish,
    );
    assert_eq!(finished(&core, &context), "completed");
    let guard = core.lock().unwrap();
    let messages = guard.store.messages(&session.id, 0).unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].body, "Частичный ответ Продолжение");
    let events = guard.store.events(&session.id, 0).unwrap();
    assert!(events.windows(2).all(|e| e[0].sequence < e[1].sequence));
    assert!(events.iter().any(|e| e.kind == "action_started"));
    assert!(events.iter().any(|e| e.kind == "action_completed"));
    drop(guard);
    let kinds = published.lock().unwrap();
    assert!(
        kinds.iter().position(|s| s == "message_delta").unwrap()
            < kinds.iter().position(|s| s == "message_completed").unwrap()
    );
}

#[test]
fn claude_authentication_failure_and_broken_stream_preserve_partial_history_without_success() {
    for mode in ["auth", "throw", "disconnect", "malformed", "truncated"] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace) = fixture(temp.path());
        let session = claude::create_session(&core, &workspace, "Ошибка").unwrap();
        let context = start(&core, &workspace, &session.id, temp.path(), mode, quiet());
        assert_eq!(
            finished(&core, &context),
            if mode == "auth" { "failed" } else { "error" }
        );
        let guard = core.lock().unwrap();
        if ["auth", "throw", "disconnect"].contains(&mode) {
            assert_eq!(
                guard
                    .store
                    .messages(&session.id, 0)
                    .unwrap()
                    .last()
                    .unwrap()
                    .body,
                "Частичный ответ"
            );
        }
        if mode == "auth" {
            let events = guard.store.events(&session.id, 0).unwrap();
            assert_eq!(
                events.last().unwrap().payload["detail"]["api_error_status"],
                401
            );
            assert_eq!(
                events.last().unwrap().payload["detail"]["result"],
                "OAuth access token is invalid"
            );
        }
        assert_eq!(guard.processes.count(), 0);
    }
}

#[test]
fn claude_permissions_reject_foreign_context_invalid_and_stale_replies() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let first = claude::create_session(&core, &workspace, "Первый").unwrap();
    let second = claude::create_session(&core, &workspace, "Второй").unwrap();
    let a = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "permission",
        quiet(),
    );
    let b = start(
        &core,
        &workspace,
        &second.id,
        temp.path(),
        "permission",
        quiet(),
    );
    let ra = request(&core, &a);
    let rb = request(&core, &b);
    assert!(claude::reply(&core, &a, rb.clone(), json!({"behavior":"allow"})).is_err());
    assert!(claude::reply(
        &core,
        &Context {
            session_id: second.id.clone(),
            ..a.clone()
        },
        ra.clone(),
        json!({"behavior":"allow"})
    )
    .is_err());
    assert!(claude::reply(
        &core,
        &a,
        ra.clone(),
        json!({"behavior":"allow","updatedInput":{"command":"other"}})
    )
    .is_err());
    assert_eq!(
        core.lock().unwrap().context_status(&a).unwrap().state,
        "waiting"
    );
    claude::reply(&core, &a, ra.clone(), json!({"behavior":"deny"})).unwrap();
    assert_eq!(finished(&core, &a), "completed");
    assert_eq!(
        core.lock().unwrap().context_status(&b).unwrap().state,
        "waiting"
    );
    claude::reply(&core, &b, rb, json!({"behavior":"allow"})).unwrap();
    assert_eq!(finished(&core, &b), "completed");
    let next = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "permission",
        quiet(),
    );
    let rn = request(&core, &next);
    assert!(claude::reply(&core, &a, ra.clone(), json!({"behavior":"allow"})).is_err());
    assert!(claude::reply(&core, &next, ra, json!({"behavior":"allow"})).is_err());
    claude::reply(&core, &next, rn, json!({"behavior":"deny"})).unwrap();
    assert_eq!(finished(&core, &next), "completed");
    let next = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "permission",
        quiet(),
    );
    let pending = request(&core, &next);
    claude::stop(&core, &next).unwrap();
    assert_eq!(finished(&core, &next), "interrupted");
    assert!(claude::reply(&core, &next, pending.clone(), json!({"behavior":"allow"})).is_err());
    assert!(core
        .lock()
        .unwrap()
        .store
        .events(&first.id, 0)
        .unwrap()
        .iter()
        .any(|e| e.context == next
            && e.kind == "request_resolved"
            && e.payload["requestId"] == pending
            && e.payload["cancelled"] == true));
}

#[test]
fn claude_questions_mcp_and_sdk_cancellation_keep_the_original_request() {
    for mode in ["question", "elicitation", "cancel"] {
        let temp = tempfile::tempdir().unwrap();
        let (core, workspace) = fixture(temp.path());
        let session = claude::create_session(&core, &workspace, "Ввод").unwrap();
        let context = start(&core, &workspace, &session.id, temp.path(), mode, quiet());
        let id = request(&core, &context);
        if mode == "cancel" {
            assert_eq!(finished(&core, &context), "completed");
            assert!(claude::reply(&core, &context, id, json!({"behavior":"allow"})).is_err());
            assert!(core
                .lock()
                .unwrap()
                .store
                .events(&session.id, 0)
                .unwrap()
                .iter()
                .any(|e| e.kind == "request_resolved" && e.payload["cancelled"] == true));
        } else {
            assert!(claude::reply(
                &core,
                &context,
                id.clone(),
                json!({"behavior":"allow","answers":{"Чужой вопрос":"ответ"}})
            )
            .is_err());
            let result = if mode == "question" {
                json!({"behavior":"allow","answers":{"Как продолжить?":"Продолжить"}})
            } else {
                json!({"action":"decline"})
            };
            claude::reply(&core, &context, id, result).unwrap();
            assert_eq!(finished(&core, &context), "completed");
        }
    }
}

#[test]
fn claude_interrupt_waits_for_sdk_result_and_does_not_stop_the_other_session() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let first = claude::create_session(&core, &workspace, "Прерывание").unwrap();
    let second = claude::create_session(&core, &workspace, "Независимый").unwrap();
    let a = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "interrupt",
        quiet(),
    );
    let b = start(&core, &workspace, &second.id, temp.path(), "wait", quiet());
    for context in [&a, &b] {
        until(&core, context, |c| {
            c.store.messages(&context.session_id, 0).unwrap().len() == 2
        });
    }
    claude::interrupt(&core, &a).unwrap();
    assert_eq!(
        core.lock().unwrap().context_status(&a).unwrap().state,
        "stopping"
    );
    assert_eq!(
        core.lock().unwrap().context_status(&b).unwrap().state,
        "running"
    );
    assert!(claude::interrupt(&core, &a).is_err());
    std::fs::write(temp.path().join(format!("{}.finish", first.id)), "").unwrap();
    assert_eq!(finished(&core, &a), "interrupted");
    assert_eq!(core.lock().unwrap().processes.count(), 1);
    std::fs::write(temp.path().join(format!("{}.finish", second.id)), "").unwrap();
    assert_eq!(finished(&core, &b), "completed");
}

#[test]
fn claude_late_request_during_interrupt_waits_for_sdk_result() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Запоздавший запрос").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "late-request",
        quiet(),
    );
    until(&core, &context, |core| {
        core.context_status(&context).unwrap().state == "running"
    });
    claude::interrupt(&core, &context).unwrap();
    until(&core, &context, |core| {
        core.store
            .events(&session.id, 0)
            .unwrap()
            .iter()
            .any(|e| e.kind == "action_output" && e.payload["type"] == "rate_limit_event")
    });
    {
        let guard = core.lock().unwrap();
        assert_eq!(guard.context_status(&context).unwrap().state, "stopping");
        assert_eq!(guard.processes.count(), 1);
        assert!(!guard
            .store
            .events(&session.id, 0)
            .unwrap()
            .iter()
            .any(|e| e.kind == "request"));
    }
    assert!(claude::reply(
        &core,
        &context,
        json!("late-request"),
        json!({"behavior":"allow"}),
    )
    .is_err());
    std::fs::write(temp.path().join(format!("{}.finish", session.id)), "").unwrap();
    assert_eq!(finished(&core, &context), "interrupted");
}

#[test]
fn claude_forced_stop_removes_its_descendants_and_keeps_other_processes() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let first = claude::create_session(&core, &workspace, "Остановка").unwrap();
    let second = claude::create_session(&core, &workspace, "Другой").unwrap();
    let a = start(
        &core,
        &workspace,
        &first.id,
        temp.path(),
        "process",
        quiet(),
    );
    let b = start(&core, &workspace, &second.id, temp.path(), "wait", quiet());
    let log = temp.path().join(format!("{}.log", first.id));
    until(&core, &a, |_| {
        std::fs::read_to_string(&log).is_ok_and(|s| s.contains("\"child\""))
    });
    let child = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find_map(|p| p["child"].as_i64())
        .unwrap();
    assert!(core
        .lock()
        .unwrap()
        .ensure_workspace_idle(&workspace)
        .is_err());
    claude::stop(&core, &a).unwrap();
    assert_eq!(finished(&core, &a), "interrupted");
    let output = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &child.to_string()])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&output.stdout).trim().is_empty()
            || String::from_utf8_lossy(&output.stdout)
                .trim()
                .starts_with('Z')
    );
    assert_eq!(core.lock().unwrap().processes.count(), 1);
    claude::stop(&core, &b).unwrap();
    assert_eq!(finished(&core, &b), "interrupted");
}

#[test]
fn claude_blocked_stdin_does_not_prevent_process_stop() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Заблокированный ввод").unwrap();
    let log = temp.path().join(format!("{}.log", session.id));
    let mut command = Command::new(crate::executors::executable("node").unwrap());
    command
        .arg("--experimental-strip-types")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/claude.mjs"
        ))
        .env("FAKE_LOG", &log)
        .env("FAKE_MODE", "blocked");
    let context = claude::start_command(
        &core,
        &workspace,
        &session.id,
        vec![json!({"type":"text","text":"x".repeat(1024 * 1024)})],
        None,
        None,
        Path::new("/installed/claude"),
        &mut command,
        quiet(),
    )
    .unwrap();
    until(&core, &context, |_| log.exists());
    claude::stop(&core, &context).unwrap();
    assert_eq!(finished(&core, &context), "interrupted");
}

#[test]
fn claude_reply_rejection_returns_to_its_caller_and_keeps_the_conversation_running() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Подтверждения ответов").unwrap();
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "reply-rejected",
        quiet(),
    );
    until(&core, &context, |c| {
        c.store
            .events(&session.id, 0)
            .unwrap()
            .iter()
            .filter(|e| e.kind == "request")
            .count()
            == 2
    });
    let pending_core = core.clone();
    let pending_context = context.clone();
    let rejected = std::thread::spawn(move || {
        claude::reply(
            &pending_core,
            &pending_context,
            json!("cancelled-reply"),
            json!({"behavior":"allow"}),
        )
    });
    let log = temp.path().join(format!("{}.log", session.id));
    until(&core, &context, |_| {
        std::fs::read_to_string(&log).is_ok_and(|s| s.contains("cancelled-reply"))
    });
    claude::reply(
        &core,
        &context,
        json!("accepted-reply"),
        json!({"behavior":"deny"}),
    )
    .unwrap();
    assert!(rejected
        .join()
        .unwrap()
        .unwrap_err()
        .contains("Запрос больше не актуален"));
    until(&core, &context, |c| {
        c.store
            .events(&session.id, 0)
            .unwrap()
            .iter()
            .any(|e| e.kind == "request" && e.payload["requestId"] == "final-reply")
    });
    assert_eq!(
        core.lock().unwrap().context_status(&context).unwrap().state,
        "waiting"
    );
    assert!(claude::interrupt(&core, &context)
        .unwrap_err()
        .contains("Прерывание отклонено"));
    assert_eq!(
        core.lock().unwrap().context_status(&context).unwrap().state,
        "waiting"
    );
    claude::reply(
        &core,
        &context,
        json!("final-reply"),
        json!({"behavior":"allow"}),
    )
    .unwrap();
    assert_eq!(finished(&core, &context), "completed");
}

#[test]
fn shutdown_continues_when_claude_finishes_while_codex_is_stopping() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Естественное завершение").unwrap();
    let context = start(&core, &workspace, &session.id, temp.path(), "wait", quiet());
    until(&core, &context, |c| {
        c.store.messages(&session.id, 0).unwrap().len() == 2
    });
    let codex_session = crate::codex::create_session(&core, &workspace, "Остановка").unwrap();
    let shared = Arc::downgrade(&core);
    let completed = context.clone();
    let finish = temp.path().join(format!("{}.finish", session.id));
    let publish: Publish = Arc::new(move |event| {
        if event.kind == "state" && event.payload["state"] == "stopping" {
            std::fs::write(&finish, "").unwrap();
            assert_eq!(finished(&shared.upgrade().unwrap(), &completed), "completed");
        }
        Ok(())
    });
    let mut command = Command::new("/bin/sh");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/codex.sh"
        ))
        .env("FAKE_LOG", temp.path().join("codex.log"))
        .env("FAKE_MODE", "hold");
    crate::codex::start_command(
        &core,
        &workspace,
        &codex_session.id,
        vec![json!({"type":"text","text":"Проверка"})],
        None,
        &mut command,
        publish,
    )
    .unwrap();
    {
        let mut guard = core.lock().unwrap();
        let Core { store, processes } = &mut *guard;
        processes
            .spawn_preparation(store, &workspace, Command::new("/bin/sleep").arg("300"))
            .unwrap();
    }
    crate::lifecycle::shutdown(&core, true).unwrap();
    assert_eq!(core.lock().unwrap().processes.count(), 0);
    assert_eq!(finished(&core, &context), "completed");
    claude::stop(&core, &context).unwrap();
    assert!(claude::interrupt(&core, &context).is_err());
    assert!(claude::reply(
        &core,
        &context,
        json!("old"),
        json!({"behavior":"allow"})
    )
    .is_err());
    assert!(claude::stop(
        &core,
        &Context {
            session_id: codex_session.id,
            ..context.clone()
        }
    )
    .is_err());
    core.lock()
        .unwrap()
        .store
        .connection
        .execute(
            "UPDATE runs SET state='running' WHERE id=?1",
            [&context.run_id],
        )
        .unwrap();
    assert!(claude::stop(&core, &context).is_err());
}

#[test]
fn claude_final_state_can_be_retried_after_a_storage_failure() {
    let temp = tempfile::tempdir().unwrap();
    let (core, workspace) = fixture(temp.path());
    let session = claude::create_session(&core, &workspace, "Сохранение").unwrap();
    core.lock().unwrap().store.connection.execute_batch("CREATE TRIGGER fail_final BEFORE UPDATE ON runs WHEN NEW.state='completed' BEGIN SELECT RAISE(FAIL,'disk failure'); END;").unwrap();
    let failures = Arc::new(Mutex::new(Vec::new()));
    let saved = failures.clone();
    let publish: Publish = Arc::new(move |event| {
        if event.kind == "save_error" {
            saved.lock().unwrap().push(event.clone());
        }
        Ok(())
    });
    let context = start(
        &core,
        &workspace,
        &session.id,
        temp.path(),
        "success",
        publish,
    );
    until(&core, &context, |_| !failures.lock().unwrap().is_empty());
    {
        let guard = core.lock().unwrap();
        assert_eq!(guard.processes.count(), 0);
        assert_ne!(guard.context_status(&context).unwrap().state, "completed");
        assert!(crate::conversations::read(&guard, &session.id, None, None)
            .unwrap()
            .can_stop);
        guard
            .store
            .connection
            .execute_batch("DROP TRIGGER fail_final;")
            .unwrap();
    }
    claude::stop(&core, &context).unwrap();
    assert_eq!(finished(&core, &context), "completed");
    assert!(
        !crate::conversations::read(&core.lock().unwrap(), &session.id, None, None)
            .unwrap()
            .can_stop
    );
}
