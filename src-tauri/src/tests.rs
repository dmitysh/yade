use crate::{
    core::Core,
    model::*,
    processes::Processes,
    store::{migrate, Store},
};
use rusqlite::Connection;
use serde_json::json;

fn fixture(path: &std::path::Path, folder: &std::path::Path) -> Core {
    let mut store = Store::open(path).unwrap();
    store.create_group("Группа", None).unwrap();
    let group = store.snapshot().unwrap().groups[0].id.clone();
    store
        .register_folder("Первый", folder, Some(&group))
        .unwrap();
    let second = folder.join("second");
    std::fs::create_dir_all(&second).unwrap();
    store.register_folder("Второй", &second, None).unwrap();
    let snapshot = store.snapshot().unwrap();
    for (i, workspace) in snapshot.workspaces.iter().enumerate() {
        store
            .insert_session(&Session {
                id: format!("s{i}"),
                workspace_id: workspace.id.clone(),
                executor: "codex".into(),
                external_id: Some(format!("external{i}")),
                title: format!("Разговор {i}"),
                state: "running".into(),
                last_activity_at: 0,
            })
            .unwrap();
        store
            .insert_run(&Run {
                id: format!("r{i}"),
                session_id: format!("s{i}"),
                state: "running".into(),
            })
            .unwrap();
    }
    Core {
        store,
        processes: Processes::default(),
    }
}

fn context(core: &Core, i: usize) -> Context {
    Context {
        workspace_id: core.store.snapshot().unwrap().workspaces[i].id.clone(),
        session_id: format!("s{i}"),
        run_id: format!("r{i}"),
    }
}

#[test]
fn project_activity_tracks_work_in_yade_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let mut core = fixture(&path, temp.path());
    let first = context(&core, 0);
    let second = context(&core, 1);
    let snapshot = core.store.snapshot().unwrap();
    assert!(snapshot.projects.iter().all(|project| project.last_activity_at > 0));
    let mut view = View {
        project_id: snapshot.workspaces[0].project_id.clone(),
        workspace_id: Some(first.workspace_id.clone()),
        sidebar_width: 260,
        ..View::default()
    };
    let mut draft = Draft {
        id: "file".into(),
        workspace_id: first.workspace_id.clone(),
        session_id: None,
        path: Some("main.rs".into()),
        body: "first".into(),
        base_version: Some("base".into()),
    };
    for operation in ["open", "tab", "message", "event", "draft", "edit", "unchanged"] {
        core.store
            .connection
            .execute("UPDATE projects SET last_activity_at=0", [])
            .unwrap();
        match operation {
            "open" => core.store.save_view(&view).unwrap(),
            "tab" => {
                view.tabs.push(Tab {
                    id: "overview".into(),
                    workspace_id: first.workspace_id.clone(),
                    session_id: None,
                });
                view.active_tabs
                    .insert(first.workspace_id.clone(), "overview".into());
                core.store.save_view(&view).unwrap();
            }
            "message" => {
                core.store.append_message(&first, "user", "Задача").unwrap();
            }
            "event" => {
                core.store.record_event(&first, "progress", json!({})).unwrap();
            }
            "draft" => core.store.save_draft(&draft).unwrap(),
            "edit" => {
                draft.body = "changed".into();
                core.store.save_draft(&draft).unwrap();
            }
            "unchanged" => core.store.save_draft(&draft).unwrap(),
            _ => unreachable!(),
        }
        let projects = core.store.snapshot().unwrap().projects;
        assert_eq!(
            projects[0].last_activity_at > 0,
            operation != "unchanged",
            "{operation}"
        );
        assert_eq!(projects[1].last_activity_at, 0, "{operation}");
    }
    core.store
        .record_event(&second, "progress", json!({}))
        .unwrap();
    let projects = core.store.snapshot().unwrap().projects;
    let saved = projects[1].last_activity_at;
    assert!(saved > 0);
    drop(core);
    let restored = Store::open(&path).unwrap().snapshot().unwrap();
    assert_eq!(restored.projects[1].last_activity_at, saved);
    assert_eq!(restored.projects[0].last_activity_at, 0);
}

#[test]
fn session_activity_tracks_only_the_used_chat_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let mut core = fixture(&path, temp.path());
    let first = context(&core, 0);
    let second = context(&core, 1);
    let snapshot = core.store.snapshot().unwrap();
    assert!(snapshot
        .sessions
        .iter()
        .all(|session| session.last_activity_at > 0));
    let mut view = View {
        project_id: snapshot.workspaces[0].project_id.clone(),
        workspace_id: Some(first.workspace_id.clone()),
        sidebar_width: 260,
        tabs: vec![
            Tab {
                id: "session:s0".into(),
                workspace_id: first.workspace_id.clone(),
                session_id: Some(first.session_id.clone()),
            },
            Tab {
                id: "session:s1".into(),
                workspace_id: second.workspace_id.clone(),
                session_id: Some(second.session_id.clone()),
            },
        ],
        active_tabs: [
            (first.workspace_id.clone(), "session:s0".into()),
            (second.workspace_id.clone(), "session:s1".into()),
        ]
        .into(),
    };
    let mut draft = Draft {
        id: "chat-draft".into(),
        workspace_id: first.workspace_id.clone(),
        session_id: Some(first.session_id.clone()),
        path: None,
        body: "first".into(),
        base_version: None,
    };
    for (operation, target) in [
        ("open", Some(0)),
        ("switch", Some(1)),
        ("editor", None),
        ("message", Some(0)),
        ("event", Some(1)),
        ("draft", Some(0)),
        ("edit", Some(0)),
        ("unchanged", None),
        ("file", None),
    ] {
        core.store
            .connection
            .execute("UPDATE sessions SET last_activity_at=0", [])
            .unwrap();
        match operation {
            "open" => core.store.save_view(&view).unwrap(),
            "switch" => {
                view.project_id = snapshot.workspaces[1].project_id.clone();
                view.workspace_id = Some(second.workspace_id.clone());
                core.store.save_view(&view).unwrap();
            }
            "editor" => {
                view.tabs.push(Tab {
                    id: "file".into(),
                    workspace_id: second.workspace_id.clone(),
                    session_id: None,
                });
                view.active_tabs
                    .insert(second.workspace_id.clone(), "file".into());
                core.store.save_view(&view).unwrap();
            }
            "message" => {
                core.store.append_message(&first, "user", "Задача").unwrap();
            }
            "event" => {
                core.store
                    .record_event(&second, "progress", json!({}))
                    .unwrap();
            }
            "draft" | "unchanged" => core.store.save_draft(&draft).unwrap(),
            "edit" => {
                draft.body = "changed".into();
                core.store.save_draft(&draft).unwrap();
            }
            "file" => core
                .store
                .save_draft(&Draft {
                    id: "file-draft".into(),
                    session_id: None,
                    path: Some("main.rs".into()),
                    base_version: Some("base".into()),
                    ..draft.clone()
                })
                .unwrap(),
            _ => unreachable!(),
        }
        for (index, session) in core.store.snapshot().unwrap().sessions.iter().enumerate() {
            assert_eq!(
                session.last_activity_at > 0,
                target == Some(index),
                "{operation}: {}",
                session.id
            );
        }
    }
    assert_eq!(
        crate::conversations::session(&core.store, &first.session_id)
            .unwrap()
            .last_activity_at,
        0
    );
    core.store
        .record_event(&first, "progress", json!({}))
        .unwrap();
    let saved = crate::conversations::session(&core.store, &first.session_id)
        .unwrap()
        .last_activity_at;
    assert!(saved > 0);
    drop(core);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        crate::conversations::session(&store, &first.session_id)
            .unwrap()
            .last_activity_at,
        saved
    );
    assert_eq!(
        crate::conversations::session(&store, &second.session_id)
            .unwrap()
            .last_activity_at,
        0
    );
}

#[test]
fn commands_and_events_reject_unknown_or_foreign_context() {
    let temp = tempfile::tempdir().unwrap();
    let mut core = fixture(&temp.path().join("state.db"), temp.path());
    let valid = context(&core, 0);
    assert_eq!(core.context_status(&valid).unwrap().id, "r0");
    let foreign = context(&core, 1);
    for invalid in [
        Context {
            workspace_id: "missing".into(),
            ..valid.clone()
        },
        Context {
            session_id: "missing".into(),
            ..valid.clone()
        },
        Context {
            run_id: "missing".into(),
            ..valid.clone()
        },
        Context {
            workspace_id: foreign.workspace_id,
            ..valid.clone()
        },
        Context {
            session_id: foreign.session_id,
            ..valid.clone()
        },
        Context {
            run_id: foreign.run_id,
            ..valid.clone()
        },
    ] {
        assert!(core.context_status(&invalid).is_err());
        assert!(core
            .publish_event(&invalid, "message", json!("wrong"), |_| panic!(
                "событие чужого запуска опубликовано"
            ))
            .is_err());
        assert!(core
            .store
            .append_message(&invalid, "user", "wrong")
            .is_err());
    }
    let event = core
        .publish_event(&valid, "message", json!("ok"), |event| {
            assert_eq!(event.context, valid);
            Ok(())
        })
        .unwrap();
    assert_eq!(event.sequence, 1);
}

#[test]
fn all_records_and_relations_survive_reopening_without_starting_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let mut core = fixture(&path, temp.path());
    let c = context(&core, 0);
    let snapshot = core.store.snapshot().unwrap();
    let view = View {
        project_id: Some(snapshot.projects[0].id.clone()),
        workspace_id: Some(c.workspace_id.clone()),
        tabs: vec![Tab {
            id: "tab".into(),
            workspace_id: c.workspace_id.clone(),
            session_id: Some(c.session_id.clone()),
        }],
        active_tabs: [(c.workspace_id.clone(), "tab".into())].into(),
        sidebar_width: 300,
    };
    core.store.save_view(&view).unwrap();
    core.store.append_message(&c, "user", "Привет").unwrap();
    core.publish_event(&c, "output", json!({"text":"Ответ"}), |_| Ok(()))
        .unwrap();
    for draft in [
        Draft {
            id: "message".into(),
            workspace_id: c.workspace_id.clone(),
            session_id: Some(c.session_id.clone()),
            path: None,
            body: "Не отправлено".into(),
            base_version: None,
        },
        Draft {
            id: "file".into(),
            workspace_id: c.workspace_id.clone(),
            session_id: None,
            path: Some("main.rs".into()),
            body: "Изменено".into(),
            base_version: Some("Исходник".into()),
        },
    ] {
        core.store.save_draft(&draft).unwrap();
    }
    core.store.save_setting("theme", &json!("dark")).unwrap();
    drop(core);
    let store = Store::open(&path).unwrap();
    let restored = store.snapshot().unwrap();
    assert_eq!(restored.groups.len(), 1);
    assert_eq!(restored.projects.len(), 2);
    assert_eq!(
        restored.projects[0].group_id,
        Some(restored.groups[0].id.clone())
    );
    assert_eq!(
        restored.workspaces[0].project_id,
        Some(restored.projects[0].id.clone())
    );
    assert_eq!(restored.sessions[0].workspace_id, c.workspace_id);
    assert_eq!(
        restored.sessions[0].external_id.as_deref(),
        Some("external0")
    );
    assert_eq!(restored.view, view);
    assert_eq!(store.runs("s0").unwrap()[0].state, "running");
    assert_eq!(store.messages("s0", 0).unwrap()[0].body, "Привет");
    assert!(store.messages("s1", 0).unwrap().is_empty());
    assert_eq!(store.drafts(&c.workspace_id).unwrap().len(), 2);
    assert_eq!(store.setting("theme").unwrap(), Some(json!("dark")));
    let payload: String = store
        .connection
        .query_row("SELECT payload FROM events WHERE run_id='r0'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
        json!({"text":"Ответ"})
    );
    store
        .connection
        .execute(
            "UPDATE workspaces SET deleted=1 WHERE id=?1",
            [&c.workspace_id],
        )
        .unwrap();
    assert_eq!(store.messages("s0", 0).unwrap().len(), 1);
    assert!(store.validate_context(&c).is_err());
    assert!(store
        .connection
        .execute("DELETE FROM workspaces WHERE id=?1", [c.workspace_id])
        .is_err());
    assert!(store
        .insert_run(&Run {
            id: "orphan".into(),
            session_id: "missing".into(),
            state: "ready".into()
        })
        .is_err());
}

#[test]
fn deleted_folder_reopens_with_its_project_and_history() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let mut core = fixture(&path, temp.path());
    let c = context(&core, 0);
    let before = core.store.snapshot().unwrap();
    let source = temp.path().join("source.txt");
    std::fs::write(&source, "Исходник").unwrap();
    core.store.append_message(&c, "user", "История").unwrap();
    let draft = Draft {
        id: "draft".into(),
        workspace_id: c.workspace_id.clone(),
        session_id: Some(c.session_id.clone()),
        path: None,
        body: "Черновик".into(),
        base_version: None,
    };
    core.store.save_draft(&draft).unwrap();
    core.store.set_archived(&c.workspace_id, true).unwrap();
    core.store
        .finish_workspace_deletion(&c.workspace_id)
        .unwrap();
    drop(core);

    let mut store = Store::open(&path).unwrap();
    store
        .register_folder("Повторно", temp.path(), None)
        .unwrap();
    let restored = store.snapshot().unwrap();
    assert_eq!(restored.projects.len(), before.projects.len());
    assert_eq!(restored.projects[0].id, before.projects[0].id);
    assert_eq!(restored.projects[0].name, before.projects[0].name);
    assert_eq!(restored.projects[0].group_id, before.projects[0].group_id);
    assert_eq!(restored.workspaces.len(), before.workspaces.len());
    let workspace = store.workspace(&c.workspace_id).unwrap();
    assert_eq!(workspace.project_id, Some(before.projects[0].id.clone()));
    assert!(!workspace.archived);
    assert_eq!(workspace.operation_state, "ready");
    assert_eq!(restored.sessions[0].workspace_id, c.workspace_id);
    assert_eq!(store.runs(&c.session_id).unwrap()[0].id, c.run_id);
    assert_eq!(store.messages(&c.session_id, 0).unwrap()[0].body, "История");
    assert_eq!(store.drafts(&c.workspace_id).unwrap(), [draft]);
    store.validate_context(&c).unwrap();
    store
        .save_view(&View {
            project_id: workspace.project_id,
            workspace_id: Some(c.workspace_id),
            sidebar_width: 260,
            ..View::default()
        })
        .unwrap();
    assert_eq!(std::fs::read_to_string(source).unwrap(), "Исходник");
    assert!(store.register_folder("Повтор", temp.path(), None).is_err());
    assert_eq!(
        store.snapshot().unwrap().workspaces.len(),
        before.workspaces.len()
    );
}

#[test]
fn failed_migration_rolls_back_schema_version_and_original_data() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("migration.db");
    let mut connection = Connection::open(&path).unwrap();
    let original = "CREATE TABLE original(value TEXT); INSERT INTO original VALUES('сохранено');";
    migrate(&mut connection, &[original]).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(migrate(&mut connection,&[original,"ALTER TABLE original ADD COLUMN added TEXT; UPDATE original SET value='потеряно'; CREATE TABLE partial(id); INVALID SQL;"]).is_err());
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT value FROM original", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "сохранено"
    );
    assert!(connection.prepare("SELECT added FROM original").is_err());
    assert!(connection.prepare("SELECT * FROM partial").is_err());
    drop(connection);
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn newer_schema_is_rejected_without_changing_it() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    assert!(migrate(&mut connection, &["CREATE TABLE changed(id);"]).is_err());
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
            .unwrap(),
        99
    );
}

#[test]
fn write_failure_never_publishes_success_or_overwrites_saved_view() {
    let temp = tempfile::tempdir().unwrap();
    let mut core = fixture(&temp.path().join("state.db"), temp.path());
    let c = context(&core, 0);
    let view = core.store.snapshot().unwrap().view;
    core.store.save_view(&view).unwrap();
    core.store
        .connection
        .pragma_update(None, "query_only", true)
        .unwrap();
    assert!(core
        .publish_event(&c, "saved", json!(null), |_| panic!(
            "ложный успешный статус"
        ))
        .is_err());
    assert!(core.store.append_message(&c, "user", "not saved").is_err());
    assert!(core
        .store
        .save_view(&View {
            sidebar_width: 320,
            ..view.clone()
        })
        .is_err());
    assert_eq!(core.store.snapshot().unwrap().view, view);
    assert!(core.store.messages("s0", 0).unwrap().is_empty());
}

#[test]
fn view_and_drafts_cannot_move_a_session_to_another_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let core = fixture(&temp.path().join("state.db"), temp.path());
    let c = context(&core, 0);
    let foreign = context(&core, 1);
    let view = View {
        sidebar_width: 260,
        tabs: vec![Tab {
            id: "tab".into(),
            workspace_id: foreign.workspace_id.clone(),
            session_id: Some(c.session_id.clone()),
        }],
        ..View::default()
    };
    assert!(core.store.save_view(&view).is_err());
    assert!(core
        .store
        .save_view(&View {
            workspace_id: Some(c.workspace_id),
            ..View {
                sidebar_width: 260,
                ..View::default()
            }
        })
        .is_err());
    let draft = Draft {
        id: "draft".into(),
        workspace_id: foreign.workspace_id,
        session_id: Some(c.session_id),
        path: None,
        body: "test".into(),
        base_version: None,
    };
    assert!(core.store.save_draft(&draft).is_err());
}

#[cfg(unix)]
#[test]
fn process_is_stopped_if_record_cannot_be_saved() {
    let temp = tempfile::tempdir().unwrap();
    let mut core = fixture(&temp.path().join("state.db"), temp.path());
    let c = context(&core, 0);
    core.store
        .connection
        .pragma_update(None, "query_only", true)
        .unwrap();
    let result = core.processes.spawn(
        &core.store,
        &c,
        std::process::Command::new("/bin/sleep").arg("300"),
    );
    assert!(result.unwrap_err().contains("процесс остановлен"));
    assert_eq!(core.processes.count(), 0);
}

#[cfg(unix)]
#[test]
fn stops_only_the_owned_tree_and_rejects_foreign_run() {
    use std::{
        os::unix::process::CommandExt,
        process::Command,
        time::{Duration, Instant},
    };
    const CHILD_PID_FILE: &str = "YADE_TEST_CHILD_PID_FILE";
    if let Some(path) = std::env::var_os(CHILD_PID_FILE) {
        let path = std::path::PathBuf::from(path);
        let mut child = Command::new("/bin/sleep")
            .arg("300")
            .process_group(0)
            .spawn()
            .unwrap();
        std::fs::write(
            path.with_extension("cwd"),
            std::env::current_dir().unwrap().to_str().unwrap(),
        )
        .unwrap();
        std::fs::write(path, child.id().to_string()).unwrap();
        child.wait().unwrap();
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let mut core = fixture(&temp.path().join("state.db"), temp.path());
    let c = context(&core, 0);
    let foreign = context(&core, 1);
    let pid_file = temp.path().join("child.pid");
    let cwd_file = pid_file.with_extension("cwd");
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "tests::stops_only_the_owned_tree_and_rejects_foreign_run",
        ])
        .env(CHILD_PID_FILE, &pid_file);
    let id = core.processes.spawn(&core.store, &c, &mut command).unwrap();
    let mut unrelated = Command::new("/bin/sleep").arg("300").spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let child_pid: i32 = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "дочерний процесс не запустился");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(unsafe { libc::getpgid(child_pid) }, child_pid);
    let group: i32 = core
        .store
        .connection
        .query_row(
            "SELECT process_group FROM processes WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(child_pid, group);
    assert_eq!(
        std::fs::read_to_string(cwd_file).unwrap().trim(),
        temp.path().canonicalize().unwrap().to_str().unwrap()
    );
    assert!(core.processes.stop(&core.store, &foreign, &id).is_err());
    assert!(core
        .processes
        .spawn(
            &core.store,
            &Context {
                run_id: "missing".into(),
                ..c.clone()
            },
            &mut Command::new("/bin/sleep")
        )
        .is_err());
    let stopped = core.processes.stop(&core.store, &c, &id);
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    stopped.unwrap();
    assert_eq!(core.processes.count(), 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &child_pid.to_string()])
            .output()
            .unwrap();
        assert!(output.status.success() || output.status.code() == Some(1));
        let state = String::from_utf8_lossy(&output.stdout);
        if state.trim().is_empty() || state.trim().starts_with('Z') {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "дочерний процесс остался работать"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let state: String = core
        .store
        .connection
        .query_row("SELECT state FROM processes WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(state, "stopped");
}
