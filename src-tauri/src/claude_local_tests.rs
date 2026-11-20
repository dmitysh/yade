use crate::{claude, core::Core, model::Context, store::Store};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn open(path: &std::path::Path) -> Arc<Mutex<Core>> {
    let mut store = Store::open(&path.join("state.db")).unwrap();
    if store.snapshot().unwrap().workspaces.is_empty() {
        store
            .register_folder("Проверка подписки", path, None)
            .unwrap();
    }
    Arc::new(Mutex::new(Core {
        store,
        processes: Default::default(),
    }))
}

fn completed(core: &Mutex<Core>, context: &Context) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        {
            let guard = core.lock().unwrap();
            if !guard.processes.claude.contains_key(&context.run_id) {
                assert_eq!(
                    guard.context_status(context).unwrap().state,
                    "completed",
                    "{:?}",
                    guard.store.events(&context.session_id, 0).unwrap().last()
                );
                return;
            }
        }
        if Instant::now() >= deadline {
            let _ = claude::stop(core, context);
            panic!("Claude Code не завершил подписочную проверку за 120 секунд");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "отправляет сообщения установленному Claude Code со штатной подпиской"]
fn local_claude_conversation_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let core = open(temp.path());
    let workspace = core.lock().unwrap().store.snapshot().unwrap().workspaces[0]
        .id
        .clone();
    let session = claude::create_session(&core, &workspace, "Проверка продолжения").unwrap();
    let marker = format!("CHECK_{}", uuid::Uuid::new_v4().simple());
    let context = claude::start(&core, &workspace, &session.id, vec![json!({"type":"text","text":format!("Запомни строку {marker}. Ответь только ей. Не используй инструменты.")})], None, |_| Ok(true), Arc::new(|_| Ok(()))).unwrap();
    completed(&core, &context);
    let native_id = core.lock().unwrap().store.snapshot().unwrap().sessions[0]
        .external_id
        .clone();
    assert!(native_id.is_some());
    drop(core);
    let core = open(temp.path());
    assert_eq!(core.lock().unwrap().processes.count(), 0);
    let context = claude::start(&core, &workspace, &session.id, vec![json!({"type":"text","text":"Какую строку я просил запомнить? Ответь только ей. Не используй инструменты."})], None, |_| Ok(true), Arc::new(|_| Ok(()))).unwrap();
    completed(&core, &context);
    let guard = core.lock().unwrap();
    assert_eq!(
        guard.store.snapshot().unwrap().sessions[0].external_id,
        native_id
    );
    assert!(guard
        .store
        .messages(&session.id, 0)
        .unwrap()
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .unwrap()
        .body
        .contains(&marker));
    assert_eq!(guard.processes.count(), 0);
}
