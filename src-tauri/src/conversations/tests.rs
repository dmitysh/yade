use super::*;

fn fixture(path: &Path) -> (Core, Context, Context) {
    let mut store = Store::open(&path.join("state.db")).unwrap();
    store.register_folder("Проект", path, None).unwrap();
    let workspace_id = store.snapshot().unwrap().workspaces[0].id.clone();
    for (id, executor) in [("a", "codex"), ("b", "claude")] {
        store
            .insert_session(&Session {
                id: id.into(),
                workspace_id: workspace_id.clone(),
                executor: executor.into(),
                external_id: Some(format!("native-{id}")),
                title: id.into(),
                state: "ready".into(),
                last_activity_at: 0,
            })
            .unwrap();
        store
            .insert_run(&Run {
                id: id.into(),
                session_id: id.into(),
                state: "completed".into(),
            })
            .unwrap();
    }
    let context = |id: &str| Context {
        workspace_id: workspace_id.clone(),
        session_id: id.into(),
        run_id: id.into(),
    };
    (
        Core {
            store,
            processes: Default::default(),
        },
        context("a"),
        context("b"),
    )
}

#[test]
fn message_event_positions_survive_reopening_and_include_the_next_page_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    let mut positions = BTreeMap::new();
    for i in 0..102 {
        let message = core
            .store
            .append_message(&a, "assistant", &format!("ответ {i}"))
            .unwrap();
        let event = core
            .store
            .record_event(
                &a,
                "message_delta",
                json!({"sequence":message,"text":"ответ"}),
            )
            .unwrap();
        positions.insert(message, event.sequence);
        core.store
            .record_event(
                &a,
                "action_started",
                json!({"id":format!("command-{i}"),"type":"commandExecution"}),
            )
            .unwrap();
        core.store
            .record_event(
                &a,
                "message_completed",
                json!({"sequence":message,"text":format!("ответ {i}")}),
            )
            .unwrap();
        core.store
            .record_event(
                &b,
                "message_delta",
                json!({"sequence":message,"text":"другой разговор"}),
            )
            .unwrap();
    }
    drop(core);
    let core = Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    };
    let page = read(&core, "a", None, None).unwrap();
    assert_eq!(page.messages.len(), 100);
    assert_eq!(page.message_events.len(), 100);
    for message in &page.messages {
        assert_eq!(
            page.message_events[&message.sequence],
            positions[&message.sequence]
        );
    }
    let boundary = page.messages[0].sequence;
    let previous = read(&core, "a", Some(boundary), None).unwrap();
    assert_eq!(previous.messages.len(), 2);
    assert_eq!(previous.message_events.len(), 3);
    assert_eq!(previous.message_events[&boundary], positions[&boundary]);
    assert!(previous
        .messages
        .iter()
        .all(|m| previous.message_events[&m.sequence] < previous.message_events[&boundary]));
}

#[test]
fn sent_draft_is_cleared_with_the_user_message_and_newer_drafts_are_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    let sent = json!({"text":"отправлено","paths":["/project/file.txt"]}).to_string();
    let next = json!({"text":"новый черновик","paths":[]}).to_string();
    let input = [json!({"type":"text","text":"отправлено\n\n@/project/file.txt"})];
    for context in [&a, &b] {
        for (saved, expected) in [(&sent, ""), (&next, next.as_str())] {
            save_draft(&core.store, &context.session_id, saved).unwrap();
            let tx = core.store.connection.transaction().unwrap();
            let event = record_user_message(&tx, context, &input, Some(&sent)).unwrap();
            tx.commit().unwrap();
            let page = read(&core, &context.session_id, None, None).unwrap();
            assert_eq!(page.draft, expected);
            assert_eq!(page.messages.last().unwrap().body, input[0]["text"]);
            assert_eq!(page.messages.last().unwrap().sequence, event["sequence"]);
        }
    }
}

#[test]
fn failed_draft_cleanup_rolls_back_the_user_message_and_keeps_the_draft() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, _) = fixture(temp.path());
    save_draft(&core.store, "a", "отправлено").unwrap();
    core.store.connection.execute_batch("CREATE TRIGGER fail_draft_clear BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT,'диск недоступен'); END;").unwrap();
    {
        let tx = core.store.connection.transaction().unwrap();
        assert!(record_user_message(&tx, &a, &[json!({"type":"text","text":"отправлено"})], Some("отправлено")).is_err());
    }
    let page = read(&core, "a", None, None).unwrap();
    assert_eq!(page.draft, "отправлено");
    assert!(page.messages.is_empty());
}

#[test]
fn conversation_pages_preserve_partial_messages_and_are_readable_after_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    for i in 0..215 {
        core.store
            .append_message(&a, "assistant", &format!("часть {i}"))
            .unwrap();
        core.store
            .record_event(&a, "action_output", json!({"text":i}))
            .unwrap();
    }
    core.store
        .append_message(&b, "user", "другой разговор")
        .unwrap();
    save_draft(&core.store, "a", "черновик").unwrap();
    let page = read(&core, "a", None, None).unwrap();
    assert_eq!(page.messages.len(), 100);
    assert_eq!(page.events.len(), 100);
    assert_eq!(page.messages[0].body, "часть 115");
    assert!(page.older_messages && page.older_events);
    let older = read(
        &core,
        "a",
        Some(page.messages[0].sequence),
        Some(page.events[0].sequence),
    )
    .unwrap();
    assert_eq!(older.messages[0].body, "часть 15");
    assert!(older.messages.last().unwrap().sequence < page.messages[0].sequence);
    let oldest = read(
        &core,
        "a",
        Some(older.messages[0].sequence),
        Some(older.events[0].sequence),
    )
    .unwrap();
    assert_eq!(oldest.messages.len(), 15);
    assert!(!oldest.older_messages && !oldest.older_events);
    core.store
        .finish_workspace_deletion(&a.workspace_id)
        .unwrap();
    drop(core);
    let core = Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    };
    let store = &core.store;
    let page = read(&core, "a", None, None).unwrap();
    assert_eq!(page.messages.last().unwrap().body, "часть 214");
    assert_eq!(page.draft, "черновик");
    assert_eq!(page.session.external_id.as_deref(), Some("native-a"));
    assert!(!page.can_stop);
    assert!(input(&store, "a", "нельзя запускать", &[]).is_err());
    assert!(read(&core, "missing", None, None).is_err());
}

#[test]
fn question_metadata_is_paged_with_events_and_isolated_between_conversations() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    let message = core
        .store
        .append_message(&a, "assistant", "Что дальше?")
        .unwrap();
    let question = core
        .store
        .record_event(
            &a,
            "message_completed",
            json!({
                "sequence":message,"questions":[{"title":"Что дальше?","options":null}],
            }),
        )
        .unwrap();
    core.store
        .record_event(
            &a,
            "message_completed",
            json!({"sequence":message,"questions":null}),
        )
        .unwrap();
    for i in 0..101 {
        core.store
            .record_event(&a, "action_output", json!({"text":i}))
            .unwrap();
    }
    let latest = read(&core, &a.session_id, None, None).unwrap();
    assert!(latest.older_events);
    assert!(!latest
        .events
        .iter()
        .any(|event| event.sequence == question.sequence));
    let older = read(&core, &a.session_id, None, Some(latest.events[0].sequence)).unwrap();
    let messages: Vec<_> = older
        .events
        .iter()
        .filter(|event| event.kind == "message_completed")
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].sequence, question.sequence);
    assert!(read(&core, &b.session_id, None, None)
        .unwrap()
        .events
        .is_empty());
}

#[test]
fn pending_requests_belong_to_the_latest_run_and_keep_their_original_context() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    core.store
        .connection
        .execute("UPDATE sessions SET state='waiting'", [])
        .unwrap();
    for context in [&a, &b] {
        core.store
            .record_event(
                context,
                "request",
                json!({"requestId":"same","method":"permission","params":{}}),
            )
            .unwrap();
    }
    for i in 0..150 {
        core.store
            .record_event(&a, "action_output", json!({"text":i}))
            .unwrap();
    }
    let page = read(&core, "a", None, None).unwrap();
    assert_eq!(page.requests.len(), 1);
    assert_eq!(page.requests[0].context, a);
    core.store
        .record_event(&a, "request_resolved", json!({"requestId":"same"}))
        .unwrap();
    assert!(read(&core, "a", None, None)
        .unwrap()
        .requests
        .is_empty());
    assert_eq!(
        read(&core, "b", None, None).unwrap().requests.len(),
        1
    );
    core.store
        .connection
        .execute("UPDATE sessions SET state='stopping' WHERE id='b'", [])
        .unwrap();
    assert!(read(&core, "b", None, None)
        .unwrap()
        .requests
        .is_empty());
    core.store
        .insert_run(&Run {
            id: "new".into(),
            session_id: "b".into(),
            state: "running".into(),
        })
        .unwrap();
    core.store
        .connection
        .execute("UPDATE sessions SET state='running' WHERE id='b'", [])
        .unwrap();
    assert!(read(&core, "b", None, None)
        .unwrap()
        .requests
        .is_empty());
}

#[test]
fn renaming_preserves_running_conversation_data_and_survives_reopening() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    core.store.connection.execute_batch("UPDATE sessions SET state='running' WHERE id='a'; UPDATE runs SET state='running' WHERE id='a';").unwrap();
    core.store.append_message(&a, "user", "Сообщение").unwrap();
    save_draft(&core.store, "a", "Черновик").unwrap();
    rename(&mut core.store, "a", "  Моё название  ").unwrap();
    let page = read(&core, "a", None, None).unwrap();
    assert_eq!(page.session.title, "Моё название");
    assert_eq!(page.session.external_id.as_deref(), Some("native-a"));
    assert_eq!(core.context_status(&a).unwrap().state, "running");
    assert_eq!(page.messages[0].body, "Сообщение");
    assert_eq!(page.draft, "Черновик");
    assert_eq!(
        read(&core, &b.session_id, None, None)
            .unwrap()
            .session
            .title,
        "b"
    );
    let store = Store::open(&temp.path().join("state.db")).unwrap();
    assert_eq!(session(&store, "a").unwrap().title, "Моё название");
}

#[test]
fn manually_chosen_default_title_is_not_replaced_by_native_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, _, _) = fixture(temp.path());
    rename(&mut core.store, "a", "Новый чат").unwrap();
    update_native_title(&core.store.connection, "a", &json!("Штатное название")).unwrap();
    assert_eq!(session(&core.store, "a").unwrap().title, "Новый чат");
}

#[test]
fn invalid_or_failed_rename_keeps_the_previous_title_and_native_naming() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, _, _) = fixture(temp.path());
    for title in ["", "  \n  "] {
        assert!(rename(&mut core.store, "a", title).is_err());
    }
    assert!(rename(&mut core.store, "missing", "Название").is_err());
    core.store.connection.execute_batch("CREATE TRIGGER fail_title BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT,'диск недоступен'); END;").unwrap();
    assert!(rename(&mut core.store, "a", "Другое название").is_err());
    assert_eq!(session(&core.store, "a").unwrap().title, "a");
    let markers: i64 = core
        .store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key LIKE 'manual-session-title:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(markers, 0);
}

#[test]
fn deleting_one_history_is_confirmed_transactional_and_preserves_other_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let (mut core, a, b) = fixture(temp.path());
    for context in [&a, &b] {
        rename(
            &mut core.store,
            &context.session_id,
            &format!("Название {}", context.session_id),
        )
        .unwrap();
        core.store
            .append_message(context, "user", &context.session_id)
            .unwrap();
        core.store
            .record_event(context, "state", json!({"state":"completed"}))
            .unwrap();
        save_draft(&core.store, &context.session_id, "черновик").unwrap();
    }
    assert!(delete(&mut core, "a", false).is_err());
    core.store
        .connection
        .execute("UPDATE runs SET state='running' WHERE id='a'", [])
        .unwrap();
    assert!(delete(&mut core, "a", true).is_err());
    core.store
        .connection
        .execute("UPDATE runs SET state='completed' WHERE id='a'", [])
        .unwrap();
    core.store.connection.execute_batch("CREATE TRIGGER fail_history BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'диск недоступен'); END;").unwrap();
    assert!(delete(&mut core, "a", true).is_err());
    assert_eq!(
        read(&core, "a", None, None).unwrap().messages.len(),
        1
    );
    core.store
        .connection
        .execute_batch("DROP TRIGGER fail_history;")
        .unwrap();
    core.store
        .connection
        .execute("UPDATE sessions SET state='running' WHERE id='b'", [])
        .unwrap();
    delete(&mut core, "a", true).unwrap();
    assert!(read(&core, "a", None, None).is_err());
    let markers: Vec<String> = core
        .store
        .connection
        .prepare("SELECT key FROM settings WHERE key LIKE 'manual-session-title:%' ORDER BY key")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(markers, ["manual-session-title:b"]);
    let page = read(&core, "b", None, None).unwrap();
    assert_eq!(page.messages[0].body, "b");
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.draft, "черновик");
    assert!(temp.path().join("state.db").exists());
}

#[test]
fn commands_file_references_and_images_use_each_executors_native_input() {
    let temp = tempfile::tempdir().unwrap();
    let (core, _, _) = fixture(temp.path());
    let image = temp.path().join("image.png");
    std::fs::write(&image, include_bytes!("../../icons/icon.png")).unwrap();
    let file = temp.path().join("my file.txt");
    std::fs::write(&file, "содержимое").unwrap();
    let image = image.canonicalize().unwrap();
    let file = file.canonicalize().unwrap();
    let paths = [
        file.to_str().unwrap().into(),
        image.to_str().unwrap().into(),
    ];
    for (id, command) in [("a", "$compatibility-probe"), ("b", "/compatibility-probe")] {
        let blocks = input(&core.store, id, command, &paths).unwrap();
        assert_eq!(blocks.len(), 2);
        let text = blocks[1]["text"].as_str().unwrap();
        assert!(text.starts_with(command));
        assert!(text.contains(&format!("@\"{}\"", file.display())));
        if id == "a" {
            assert_eq!(blocks[0], json!({"type":"localImage","path":image}));
        } else {
            assert_eq!(blocks[0]["source"]["media_type"], "image/png");
            assert_eq!(
                STANDARD
                    .decode(blocks[0]["source"]["data"].as_str().unwrap())
                    .unwrap(),
                std::fs::read(&image).unwrap()
            );
        }
    }
    assert!(input(&core.store, "a", "", &[]).is_err());
    assert!(input(&core.store, "a", "текст", &["relative.txt".into()]).is_err());
    assert!(input(
        &core.store,
        "a",
        "текст",
        &[temp.path().join("missing").to_str().unwrap().into()]
    )
    .is_err());
    std::fs::write(&image, "ошибка").unwrap();
    assert!(input(&core.store, "b", "текст", &[image.to_str().unwrap().into()]).is_err());
    let mut large_image = include_bytes!("../../icons/icon.png").to_vec();
    large_image.resize(3 * 1024 * 1024 + 1, 0);
    std::fs::write(&image, large_image).unwrap();
    assert!(input(&core.store, "a", "текст", &[image.to_str().unwrap().into()]).is_ok());
    assert!(input(&core.store, "b", "текст", &[image.to_str().unwrap().into()]).is_err());
    assert!(input(&core.store, "a", &"x".repeat(4 * 1024 * 1024 + 1), &[]).is_err());
}

#[cfg(unix)]
#[test]
fn two_executor_processes_share_files_but_keep_streams_and_decisions_separate() {
    use crate::{claude, codex, executors};
    use std::{
        process::Command,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let (core, a, _) = fixture(temp.path());
    core.store
        .connection
        .execute("UPDATE sessions SET external_id=NULL", [])
        .unwrap();
    let file = temp.path().join("fixture.txt");
    std::fs::write(&file, "общий файл").unwrap();
    let image = temp.path().join("image.png");
    std::fs::write(&image, include_bytes!("../../icons/icon.png")).unwrap();
    let paths = [
        file.to_str().unwrap().into(),
        image.to_str().unwrap().into(),
    ];
    let codex_input = input(&core.store, "a", "$compatibility-probe", &paths).unwrap();
    let claude_input = input(&core.store, "b", "/compatibility-probe", &paths).unwrap();
    let core = Arc::new(Mutex::new(core));
    let mut codex_command = Command::new("/bin/sh");
    codex_command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/codex.sh"
        ))
        .env("FAKE_MODE", "wait")
        .env("FAKE_LOG", temp.path().join("codex.log"));
    let first = codex::start_command(
        &core,
        &a.workspace_id,
        "a",
        codex_input,
        None,
        &mut codex_command,
        Arc::new(|_| Ok(())),
    )
    .unwrap();
    let mut claude_command = Command::new(executors::executable("node").unwrap());
    claude_command
        .arg("--experimental-strip-types")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/claude.mjs"
        ))
        .env("FAKE_MODE", "permission")
        .env("FAKE_LOG", temp.path().join("claude.log"));
    let second = claude::start_command(
        &core,
        &a.workspace_id,
        "b",
        claude_input,
        None,
        None,
        Path::new("/installed/claude"),
        &mut claude_command,
        Arc::new(|_| Ok(())),
    )
    .unwrap();
    let wait = |predicate: &dyn Fn(&Core) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if predicate(&core.lock().unwrap()) {
                break;
            }
            assert!(Instant::now() < deadline, "не дождались исполнителей");
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    wait(&|core| {
        read(&core, "a", None, None).unwrap().requests.len() == 1
            && read(&core, "b", None, None).unwrap().requests.len() == 1
    });
    let request_id = {
        let core = core.lock().unwrap();
        let first_page = read(&core, "a", None, None).unwrap();
        let second_page = read(&core, "b", None, None).unwrap();
        assert!(first_page.can_stop && second_page.can_stop);
        assert!(first_page.messages.iter().any(|m| m.body == "при"));
        assert!(second_page
            .messages
            .iter()
            .any(|m| m.body == "Частичный ответ"));
        assert_eq!(first_page.context.as_ref(), Some(&first));
        assert_eq!(second_page.context.as_ref(), Some(&second));
        // Закрытие представлений сохраняет оба выполняющихся процесса.
        core.store
            .save_view(&View {
                sidebar_width: 260,
                ..View::default()
            })
            .unwrap();
        assert_eq!(core.processes.count(), 2);
        second_page.requests[0].payload["requestId"].clone()
    };
    codex::reply(
        &core,
        &first,
        json!("approval"),
        json!({"decision":"accept"}),
    )
    .unwrap();
    wait(&|core| !core.processes.codex.contains_key(&first.run_id));
    {
        let core = core.lock().unwrap();
        assert_eq!(
            read(&core, "a", None, None).unwrap().session.state,
            "completed"
        );
        assert_eq!(
            read(&core, "b", None, None).unwrap().session.state,
            "waiting"
        );
        assert_eq!(
            read(&core, "b", None, None).unwrap().requests.len(),
            1
        );
    }
    claude::reply(&core, &second, request_id, json!({"behavior":"deny"})).unwrap();
    wait(&|core| !core.processes.claude.contains_key(&second.run_id));
    let log = std::fs::read_to_string(temp.path().join("claude.log")).unwrap();
    let packet: Value = log
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|p| p.get("input").is_some())
        .unwrap();
    assert_eq!(
        packet["options"]["cwd"],
        temp.path().canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(packet["input"]["message"]["content"][0]["type"], "image");
    assert!(packet["input"]["message"]["content"][1]["text"]
        .as_str()
        .unwrap()
        .starts_with("/compatibility-probe"));
    assert!(log.contains("\"behavior\":\"deny\""));
    assert!(codex::reply(
        &core,
        &first,
        json!("approval"),
        json!({"decision":"accept"})
    )
    .is_err());
    drop(core);
    let core = Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    };
    assert_eq!(
        read(&core, "b", None, None).unwrap().session.state,
        "completed"
    );
    assert!(read(&core, "a", None, None).unwrap().messages.len() >= 2);
}

#[cfg(unix)]
#[test]
#[ignore = "отправляет команду, файл и изображение установленному Codex со штатной подпиской"]
fn local_conversation_input_commands_and_attachments() {
    use crate::{
        codex,
        executor_settings::{self, Settings},
    };
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let (core, a, _) = fixture(temp.path());
    core.store
        .connection
        .execute("UPDATE sessions SET external_id=NULL", [])
        .unwrap();
    let skill = temp.path().join(".agents/skills/compatibility-probe");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: compatibility-probe\ndescription: Проверка передачи команды.\n---\nДобавь в ответ SKILL_INPUT_OK.\n").unwrap();
    let marker = format!("FILE_{}", uuid::Uuid::new_v4().simple());
    let file = temp.path().join("fixture with spaces.txt");
    std::fs::write(&file, &marker).unwrap();
    let image = temp.path().join("red.png");
    std::fs::write(&image, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAASElEQVR4nO3PwQkAMBCEwO2/6aSIe4ggTAG6t6nxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QVHHzLD+GoHbk06AAAAAElFTkSuQmCC").unwrap()).unwrap();
    executor_settings::save(
        &core.store,
        &Target {
            workspace_id: a.workspace_id.clone(),
            session_id: Some("a".into()),
            executor: "codex".into(),
        },
        &Settings {
            approval_policy: Some("never".into()),
            sandbox: Some("read-only".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let blocks = input(&core.store, "a", "$compatibility-probe Прочитай приложенный файл. Ответь строкой из файла, цветом изображения на английском и маркером навыка. Не изменяй файлы и не вызывай MCP.", &[file.to_str().unwrap().into(),image.to_str().unwrap().into()]).unwrap();
    let core = Arc::new(Mutex::new(core));
    let context = codex::start(&core, &a.workspace_id, "a", blocks, None, Arc::new(|_| Ok(()))).unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    while core
        .lock()
        .unwrap()
        .processes
        .codex
        .contains_key(&context.run_id)
    {
        if Instant::now() >= deadline {
            codex::stop(&core, &context).unwrap();
            panic!("Codex не завершил проверку вложений");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let page = read(&core.lock().unwrap(), "a", None, None).unwrap();
    assert_eq!(page.session.state, "completed", "{:?}", page.events);
    let answer = page
        .messages
        .iter()
        .filter(|m| m.role == "assistant")
        .map(|m| m.body.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(answer.contains(&marker), "файл не прочитан: {answer}");
    assert!(
        answer.contains("SKILL_INPUT_OK"),
        "навык не применён: {answer}"
    );
    assert!(
        answer.to_ascii_lowercase().contains("red"),
        "изображение не распознано: {answer}"
    );
    println!("Codex: команда навыка, файл с пробелами в пути и изображение переданы через сборку сообщения чата");
}
