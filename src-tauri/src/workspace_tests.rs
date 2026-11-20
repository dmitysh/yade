use crate::{core::Core, model::NewWorktree, processes::Processes, workspaces::create_worktree};
use crate::{store::Store, workspaces::git};
use std::path::Path;
use std::sync::Mutex;

fn history(store: &Store, workspace_id: &str) -> crate::model::Context {
    let session_id = uuid::Uuid::new_v4().to_string();
    let run_id = uuid::Uuid::new_v4().to_string();
    store
        .insert_session(&crate::model::Session {
            id: session_id.clone(),
            workspace_id: workspace_id.into(),
            executor: "codex".into(),
            external_id: None,
            title: "Разговор".into(),
            state: "completed".into(),
            last_activity_at: 0,
        })
        .unwrap();
    store
        .insert_run(&crate::model::Run {
            id: run_id.clone(),
            session_id: session_id.clone(),
            state: "completed".into(),
        })
        .unwrap();
    let context = crate::model::Context {
        workspace_id: workspace_id.into(),
        session_id,
        run_id,
    };
    store.append_message(&context, "user", "История").unwrap();
    context
}

fn repository_core(temp: &Path) -> (Mutex<Core>, String) {
    let repo = temp.join("repo");
    repository(&repo);
    let mut store = Store::open(&temp.join("state.db")).unwrap();
    store.register_folder("Проект", &repo, None).unwrap();
    let project = store.snapshot().unwrap().projects[0].id.clone();
    (
        Mutex::new(Core {
            store,
            processes: Processes::default(),
        }),
        project,
    )
}

fn worktree(core: &Mutex<Core>, temp: &Path, project: &str, name: &str) -> crate::model::Workspace {
    create_worktree(
        core,
        &NewWorktree {
            project_id: project.into(),
            name: name.into(),
            path: temp.join(name).to_str().unwrap().into(),
            source_ref: "main".into(),
            branch: Some(name.into()),
        },
    )
    .unwrap()
}

fn repository(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "-b", "main"]).unwrap();
    git(path, &["config", "user.name", "Test"]).unwrap();
    git(path, &["config", "user.email", "test@example.invalid"]).unwrap();
    std::fs::write(path.join("file.txt"), "original\n").unwrap();
    git(path, &["add", "file.txt"]).unwrap();
    git(path, &["commit", "-m", "initial"]).unwrap();
}

#[test]
fn snapshot_recognizes_git_initialized_after_opening_a_folder() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.register_folder("Проект", &repo, None).unwrap();
    let saved = store.snapshot().unwrap();
    let project = saved.projects[0].id.clone();
    let workspace = saved.workspaces[0].id.clone();
    let context = history(&store, &workspace);
    let core = Mutex::new(Core {
        store,
        processes: Processes::default(),
    });

    repository(&repo.join("nested"));
    assert_eq!(
        crate::workspaces::snapshot(&core).unwrap().projects[0].kind,
        "folder"
    );
    git(&repo, &["init", "-b", "main"]).unwrap();
    let live = crate::workspaces::snapshot(&core).unwrap();
    assert_eq!(live.projects[0].id, project);
    assert_eq!(live.projects[0].kind, "repository");
    assert_eq!(live.workspaces[0].id, workspace);
    assert_eq!(live.workspaces[0].git_ref.as_deref(), Some("main"));
    assert!(crate::workspaces::project_branches(&core, &project)
        .unwrap()
        .is_empty());
    {
        let guard = core.lock().unwrap();
        assert_eq!(
            guard.store.snapshot().unwrap().projects[0].kind,
            "repository"
        );
        assert_eq!(
            guard.store.messages(&context.session_id, 0).unwrap()[0].body,
            "История"
        );
    }
    repository(&repo);
    assert_eq!(
        worktree(&core, temp.path(), &project, "task").kind,
        "worktree"
    );
}

#[test]
fn snapshot_reads_live_branches_and_detached_heads_without_changing_creation_records() {
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let task = worktree(&core, temp.path(), &project, "task");
    let repo = temp.path().join("repo");
    git(&repo, &["switch", "-c", "new-main"]).unwrap();
    crate::git::action(
        Path::new(&task.path),
        &crate::git::Action::CreateBranch {
            name: "new-task".into(),
            start: "HEAD".into(),
            checkout: true,
        },
    )
    .unwrap();
    let live = crate::workspaces::snapshot(&core).unwrap();
    assert_eq!(live.workspaces[0].git_ref.as_deref(), Some("new-main"));
    assert_eq!(live.workspaces[1].git_ref.as_deref(), Some("new-task"));
    let stored = core.lock().unwrap().store.snapshot().unwrap();
    assert_eq!(stored.workspaces[0].git_ref.as_deref(), Some("main"));
    assert_eq!(stored.workspaces[1].git_ref.as_deref(), Some("task"));

    git(Path::new(&task.path), &["switch", "--detach"]).unwrap();
    let head = git(Path::new(&task.path), &["rev-parse", "HEAD"]).unwrap();
    let live = crate::workspaces::snapshot(&core).unwrap();
    assert_eq!(live.workspaces[1].git_ref.as_deref(), Some(head.trim()));

    std::fs::rename(&task.path, temp.path().join("missing-task")).unwrap();
    let live = crate::workspaces::snapshot(&core).unwrap();
    assert_eq!(live.workspaces[0].git_ref.as_deref(), Some("new-main"));
    assert_eq!(live.workspaces[1].git_ref, None);
}

#[test]
fn projects_keep_repository_boundaries_and_reject_unavailable_folders() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    repository(&first);
    repository(&second);
    git(&second, &["branch", "-m", "other"]).unwrap();
    let plain = temp.path().join("plain");
    std::fs::create_dir(&plain).unwrap();
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.create_group("Группа", Some(temp.path())).unwrap();
    let group = store.snapshot().unwrap().groups[0].clone();
    store
        .register_folder("Первый", &first, Some(&group.id))
        .unwrap();
    store
        .register_folder("Второй", &second, Some(&group.id))
        .unwrap();
    store.register_folder("Папка", &plain, None).unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .projects
            .iter()
            .map(|p| p.kind.as_str())
            .collect::<Vec<_>>(),
        ["repository", "repository", "folder"]
    );
    assert_eq!(snapshot.workspaces[0].git_ref.as_deref(), Some("main"));
    assert_eq!(snapshot.workspaces[1].git_ref.as_deref(), Some("other"));
    assert!(!plain.join(".git").exists());
    assert!(store
        .register_folder("Нет", &temp.path().join("missing"), None)
        .is_err());
    assert!(store
        .register_folder("Файл", &first.join("file.txt"), None)
        .is_err());
    assert!(store.register_folder("Повтор", &first, None).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = store.register_folder("Недоступно", &plain, None);
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(denied.is_err());
    }
    assert_eq!(store.snapshot().unwrap().projects.len(), 3);
    assert_eq!(
        group.path.as_deref(),
        temp.path().canonicalize().unwrap().to_str()
    );
}

#[test]
fn project_branches_include_local_and_remote_branches_without_symbolic_refs_or_tags() {
    let temp = tempfile::tempdir().unwrap();
    let (core, project_id) = repository_core(temp.path());
    let repo = temp.path().join("repo");
    git(&repo, &["branch", "feature/payment"]).unwrap();
    git(
        &repo,
        &["update-ref", "refs/remotes/origin/release", "HEAD"],
    )
    .unwrap();
    git(
        &repo,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/release",
        ],
    )
    .unwrap();
    git(&repo, &["tag", "v1"]).unwrap();
    let second = temp.path().join("second");
    repository(&second);
    git(&second, &["branch", "other-project"]).unwrap();
    core.lock()
        .unwrap()
        .store
        .register_folder("Другой", &second, None)
        .unwrap();
    assert_eq!(
        crate::workspaces::project_branches(&core, &project_id).unwrap(),
        ["feature/payment", "main", "origin/release"]
    );
    let copy = create_worktree(
        &core,
        &NewWorktree {
            project_id: project_id.clone(),
            name: "Из-удалённой-ветки".into(),
            path: temp.path().join("remote-copy").to_str().unwrap().into(),
            source_ref: "origin/release".into(),
            branch: None,
        },
    )
    .unwrap();
    assert_eq!(
        copy.source_ref.as_deref(),
        Some("refs/remotes/origin/release")
    );
    assert_eq!(copy.git_ref.as_deref(), Some("Из-удалённой-ветки"));
    assert!(crate::workspaces::project_branches(&core, "unknown-project").is_err());
}

#[test]
fn duplicate_path_after_failed_creation_returns_an_actionable_error_without_changing_the_workspace()
{
    let temp = tempfile::tempdir().unwrap();
    let (core, project_id) = repository_core(temp.path());
    let path = temp.path().join("reserved");
    let mut request = NewWorktree {
        project_id,
        name: "Задача".into(),
        path: path.to_str().unwrap().into(),
        source_ref: "missing-branch".into(),
        branch: None,
    };
    assert!(create_worktree(&core, &request).is_err());
    let before = core.lock().unwrap().store.snapshot().unwrap();
    let failed = before.workspaces.last().unwrap();
    assert_eq!(failed.operation_state, "error");
    assert!(!path.exists());
    request.source_ref = "main".into();
    let error = create_worktree(&core, &request).unwrap_err();
    assert!(error.contains("Это расположение уже используется рабочим пространством"));
    assert!(error.contains("Укажите другое название пространства"));
    assert!(!error.contains("UNIQUE"));
    assert!(!error.contains("workspaces.path"));
    let after = core.lock().unwrap().store.snapshot().unwrap();
    assert_eq!(after.workspaces.len(), before.workspaces.len());
    assert_eq!(after.workspaces.last().unwrap().id, failed.id);
    assert_eq!(
        after.workspaces.last().unwrap().operation_error,
        failed.operation_error
    );
    assert!(!path.exists());
}

#[test]
fn automatic_worktree_paths_stay_inside_the_project_directory_and_keep_existing_files() {
    let temp = tempfile::tempdir().unwrap();
    let (core, project_id) = repository_core(temp.path());
    let root = temp.path().join("workspaces");
    let repo = temp.path().join("repo");
    let mut request: NewWorktree = serde_json::from_value(serde_json::json!({
        "projectId": project_id,
        "name": "Исправление оплаты",
        "sourceRef": "main",
        "branch": "fix/payment"
    }))
    .unwrap();
    assert!(request.path.is_empty());
    let path = crate::workspaces::default_worktree_path(&root, &repo, &request.name).unwrap();
    assert_eq!(path, root.join("repo/Исправление оплаты"));
    for name in [
        "",
        " ",
        ".",
        "..",
        "../outside",
        "/outside",
        "a/b",
        "a\\b",
        "a\0b",
    ] {
        assert!(crate::workspaces::default_worktree_path(&root, &repo, name).is_err());
    }
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    request.path = path.to_str().unwrap().into();
    let workspace = create_worktree(&core, &request).unwrap();
    assert_eq!(Path::new(&workspace.path), path.canonicalize().unwrap());
    assert_eq!(workspace.git_ref.as_deref(), Some("fix/payment"));
    std::fs::write(path.join("file.txt"), "Незавершённая работа").unwrap();
    assert!(create_worktree(&core, &request)
        .unwrap_err()
        .contains("уже существует"));
    assert_eq!(
        std::fs::read_to_string(path.join("file.txt")).unwrap(),
        "Незавершённая работа"
    );
}

#[test]
fn worktrees_from_branch_and_commit_are_independent_and_errors_are_recorded() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    repository(&repo);
    let commit = git(&repo, &["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.register_folder("Проект", &repo, None).unwrap();
    let project_id = store.snapshot().unwrap().projects[0].id.clone();
    let core = Mutex::new(Core {
        store,
        processes: Processes::default(),
    });
    let mut request = NewWorktree {
        project_id,
        name: "Из ветки".into(),
        path: temp.path().join("branch copy").to_str().unwrap().into(),
        source_ref: "main".into(),
        branch: Some("feature".into()),
    };
    let first = create_worktree(&core, &request).unwrap();
    assert_eq!(first.operation_state, "ready");
    assert_eq!(first.git_ref.as_deref(), Some("feature"));
    assert_eq!(first.source_ref.as_deref(), Some("refs/heads/main"));
    assert_eq!(first.source_commit.as_deref(), Some(commit.as_str()));
    request.path = temp.path().join("commit-copy").to_str().unwrap().into();
    request.name = " commit-copy ".into();
    request.source_ref = commit.clone();
    request.branch = None;
    let second = create_worktree(&core, &request).unwrap();
    assert_eq!(second.git_ref.as_deref(), Some("commit-copy"));
    assert_eq!(
        git(Path::new(&second.path), &["branch", "--show-current"])
            .unwrap()
            .trim(),
        "commit-copy"
    );
    assert_eq!(second.source_commit.as_deref(), Some(commit.as_str()));
    std::fs::write(Path::new(&first.path).join("file.txt"), "changed").unwrap();
    assert_eq!(
        std::fs::read_to_string(Path::new(&second.path).join("file.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("file.txt")).unwrap(),
        "original\n"
    );
    assert!(create_worktree(&core, &request)
        .unwrap_err()
        .contains("уже существует"));
    request.path = temp.path().join("failed").to_str().unwrap().into();
    request.source_ref = "missing-branch".into();
    assert!(create_worktree(&core, &request).is_err());
    let snapshot = core.lock().unwrap().store.snapshot().unwrap();
    let failed = snapshot.workspaces.last().unwrap();
    assert_eq!(failed.operation_state, "error");
    assert!(failed
        .operation_error
        .as_ref()
        .unwrap()
        .contains("папка не создана"));
    assert!(!Path::new(&failed.path).exists());
    assert_eq!(snapshot.workspaces.len(), 4);
}

#[test]
fn invalid_or_existing_new_branch_never_creates_a_detached_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let (core, project_id) = repository_core(temp.path());
    for (index, (name, branch)) in [
        ("bad name", None),
        ("main", None),
        ("empty", Some("")),
        ("spaces", Some("   ")),
        ("option", Some("-bad")),
    ]
    .into_iter()
    .enumerate()
    {
        let path = temp.path().join(format!("invalid-{index}"));
        let request = NewWorktree {
            project_id: project_id.clone(),
            name: name.into(),
            path: path.to_str().unwrap().into(),
            source_ref: "main".into(),
            branch: branch.map(str::to_string),
        };
        assert!(create_worktree(&core, &request).is_err());
        assert!(!path.exists());
    }
}

#[test]
fn group_folder_has_shared_files_and_separate_repositories() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    repository(&first);
    repository(&second);
    git(&second, &["branch", "-m", "other"]).unwrap();
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store
        .create_group("Общая папка", Some(temp.path()))
        .unwrap();
    let group = store.snapshot().unwrap().groups[0].id.clone();
    store
        .register_folder("Первый", &first, Some(&group))
        .unwrap();
    store
        .register_folder("Второй", &second, Some(&group))
        .unwrap();
    let workspace = store.open_group_folder(&group).unwrap();
    assert_eq!(store.open_group_folder(&group).unwrap().id, workspace.id);
    assert!(workspace.project_id.is_none());
    assert!(workspace.git_ref.is_none());
    for name in ["first", "second"] {
        assert_eq!(
            std::fs::read_to_string(Path::new(&workspace.path).join(name).join("file.txt"))
                .unwrap(),
            "original\n"
        );
    }
    std::fs::write(first.join("file.txt"), "changed").unwrap();
    assert!(git(&first, &["status", "--porcelain"])
        .unwrap()
        .contains("file.txt"));
    assert!(git(&second, &["status", "--porcelain"]).unwrap().is_empty());
    assert_eq!(
        git(&second, &["branch", "--show-current"]).unwrap().trim(),
        "other"
    );
    assert!(!temp.path().join(".git").exists());
}

#[cfg(unix)]
#[test]
fn preparation_runs_only_when_configured_and_preserves_failed_worktree_and_output() {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    repository(&repo);
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.register_folder("Проект", &repo, None).unwrap();
    let project_id = store.snapshot().unwrap().projects[0].id.clone();
    let core = Arc::new(Mutex::new(Core {
        store,
        processes: Processes::default(),
    }));
    for (name, command, expected) in [
        ("without", "", "skipped"),
        (
            "success",
            "pwd; printf 'ready' > prepared.txt; printf 'output'; printf 'diagnostic' >&2",
            "completed",
        ),
        (
            "failure",
            "pwd; printf 'keep' > prepared.txt; printf 'error-output' >&2; exit 7",
            "failed",
        ),
    ] {
        core.lock()
            .unwrap()
            .store
            .set_preparation_command(&project_id, command)
            .unwrap();
        let workspace = create_worktree(
            &core,
            &NewWorktree {
                project_id: project_id.clone(),
                name: name.into(),
                path: temp.path().join(name).to_str().unwrap().into(),
                source_ref: "main".into(),
                branch: None,
            },
        )
        .unwrap();
        crate::preparation::start(core.clone(), &workspace.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let finished = loop {
            let current = core.lock().unwrap().store.workspace(&workspace.id).unwrap();
            if !["pending", "running"].contains(&current.preparation_state.as_str()) {
                break current;
            }
            assert!(Instant::now() < deadline, "подготовка не завершилась");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(
            finished.preparation_state, expected,
            "{}",
            finished.preparation_output
        );
        assert_eq!(finished.operation_state, "ready");
        assert!(Path::new(&finished.path).is_dir());
        if command.is_empty() {
            assert!(finished.preparation_output.is_empty());
            assert!(!Path::new(&finished.path).join("prepared.txt").exists());
        } else {
            assert!(finished.preparation_output.contains(&finished.path));
            assert!(finished.preparation_output.contains("output"));
            assert!(Path::new(&finished.path).join("prepared.txt").exists());
        }
    }
    assert_eq!(core.lock().unwrap().processes.count(), 0);
    let workspace = core.lock().unwrap().store.snapshot().unwrap().workspaces[1]
        .id
        .clone();
    core.lock()
        .unwrap()
        .store
        .preparation_output(&workspace, &"ы".repeat(100000), "completed")
        .unwrap();
    assert!(
        core.lock()
            .unwrap()
            .store
            .workspace(&workspace)
            .unwrap()
            .preparation_output
            .len()
            <= 65536
    );
    drop(core);
    let restored = Store::open(&temp.path().join("state.db"))
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(
        restored.workspaces.last().unwrap().preparation_state,
        "failed"
    );
    assert!(restored
        .workspaces
        .last()
        .unwrap()
        .preparation_output
        .contains("error-output"));
}

#[cfg(unix)]
#[test]
fn preparation_streams_output_while_core_remains_available() {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    repository(&repo);
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.register_folder("Проект", &repo, None).unwrap();
    let project_id = store.snapshot().unwrap().projects[0].id.clone();
    store
        .set_preparation_command(
            &project_id,
            "printf started; while [ ! -f release ]; do sleep 0.02; done",
        )
        .unwrap();
    let core = Arc::new(Mutex::new(Core {
        store,
        processes: Processes::default(),
    }));
    let workspace = create_worktree(
        &core,
        &NewWorktree {
            project_id,
            name: "Подготовка".into(),
            path: temp.path().join("worktree").to_str().unwrap().into(),
            source_ref: "main".into(),
            branch: None,
        },
    )
    .unwrap();
    crate::preparation::start(core.clone(), &workspace.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let guard = core.lock().unwrap();
        let current = guard.store.workspace(&workspace.id).unwrap();
        if current.preparation_output.contains("started") {
            assert_eq!(current.preparation_state, "running");
            assert!(guard.processes.has_workspace(&workspace.id));
            assert!(guard.ensure_workspace_idle(&workspace.id).is_err());
            guard
                .store
                .save_view(&guard.store.snapshot().unwrap().view)
                .unwrap();
            break;
        }
        drop(guard);
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::write(Path::new(&workspace.path).join("release"), "").unwrap();
    loop {
        if core
            .lock()
            .unwrap()
            .store
            .workspace(&workspace.id)
            .unwrap()
            .preparation_state
            == "completed"
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn archive_and_restore_keep_files_history_and_tabs() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.register_folder("Проект", temp.path(), None).unwrap();
    std::fs::write(temp.path().join("source.txt"), "source").unwrap();
    let workspace = store.snapshot().unwrap().workspaces[0].clone();
    let context = history(&store, &workspace.id);
    let view = crate::model::View {
        project_id: workspace.project_id.clone(),
        workspace_id: Some(workspace.id.clone()),
        tabs: vec![crate::model::Tab {
            id: "conversation".into(),
            workspace_id: workspace.id.clone(),
            session_id: Some(context.session_id.clone()),
        }],
        active_tabs: [(workspace.id.clone(), "conversation".into())].into(),
        sidebar_width: 260,
    };
    store.save_view(&view).unwrap();
    let mut core = Core {
        store,
        processes: Processes::default(),
    };
    core.archive_workspace(&workspace.id, true).unwrap();
    let archived = core.store.snapshot().unwrap();
    assert!(archived.workspaces[0].archived);
    assert!(archived.view.workspace_id.is_none());
    assert_eq!(archived.view.tabs, view.tabs);
    assert_eq!(
        core.store.messages(&context.session_id, 0).unwrap()[0].body,
        "История"
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("source.txt")).unwrap(),
        "source"
    );
    core.archive_workspace(&workspace.id, false).unwrap();
    core.store.save_view(&view).unwrap();
    core.store
        .connection
        .execute(
            "UPDATE sessions SET state='running' WHERE id=?1",
            [&context.session_id],
        )
        .unwrap();
    assert!(core.archive_workspace(&workspace.id, true).is_err());
    assert!(!core.store.workspace(&workspace.id).unwrap().archived);
    drop(core);
    let restored = Store::open(&path).unwrap();
    assert_eq!(restored.snapshot().unwrap().view, view);
    assert_eq!(restored.messages(&context.session_id, 0).unwrap().len(), 1);
}

#[test]
fn worktree_deletion_requires_current_confirmation_and_keeps_branch_and_history() {
    use crate::workspaces::{delete_workspace, delete_workspace_branch, inspect_deletion};
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let workspace = worktree(&core, temp.path(), &project, "feature");
    let path = Path::new(&workspace.path);
    let context = history(&core.lock().unwrap().store, &workspace.id);
    std::fs::write(path.join("file.txt"), "committed work").unwrap();
    git(path, &["add", "file.txt"]).unwrap();
    git(path, &["commit", "-m", "work"]).unwrap();
    std::fs::write(path.join("file.txt"), "uncommitted").unwrap();
    std::fs::write(path.join("untracked.txt"), "untracked").unwrap();
    std::fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(path.join("ignored.txt"), "ignored").unwrap();
    let draft = crate::model::Draft {
        id: "draft".into(),
        workspace_id: workspace.id.clone(),
        session_id: None,
        path: Some("file.txt".into()),
        body: "manual work".into(),
        base_version: Some("original".into()),
    };
    core.lock().unwrap().store.save_draft(&draft).unwrap();
    let check = inspect_deletion(&core, &workspace.id).unwrap();
    assert_eq!(check.drafts, std::slice::from_ref(&draft));
    assert!(check.changes.contains(" M file.txt"));
    assert!(check.changes.contains("?? untracked.txt"));
    assert!(check.changes.contains("!! ignored.txt"));
    assert!(check.unmerged.contains("work"));
    assert!(delete_workspace(&core, &check, false, true).is_err());
    assert!(delete_workspace(&core, &check, true, false).is_err());
    assert!(path.exists());
    assert_eq!(
        core.lock().unwrap().store.drafts(&workspace.id).unwrap(),
        std::slice::from_ref(&draft)
    );
    std::fs::write(path.join("new.txt"), "new").unwrap();
    assert!(delete_workspace(&core, &check, true, true)
        .unwrap_err()
        .contains("изменилось"));
    let fresh = inspect_deletion(&core, &workspace.id).unwrap();
    delete_workspace(&core, &fresh, true, true).unwrap();
    assert!(!path.exists());
    assert!(
        core.lock()
            .unwrap()
            .store
            .snapshot()
            .unwrap()
            .workspaces
            .iter()
            .find(|w| w.id == workspace.id)
            .unwrap()
            .deleted
    );
    assert_eq!(
        core.lock().unwrap().store.drafts(&workspace.id).unwrap(),
        [draft]
    );
    assert_eq!(
        core.lock()
            .unwrap()
            .store
            .messages(&context.session_id, 0)
            .unwrap()[0]
            .body,
        "История"
    );
    assert!(git(
        &temp.path().join("repo"),
        &["rev-parse", "--verify", "refs/heads/feature"]
    )
    .is_ok());
    assert!(delete_workspace_branch(
        &core,
        &workspace.id,
        "feature",
        fresh.head.as_deref().unwrap(),
        false
    )
    .is_err());
    let repo = temp.path().join("repo");
    let main = git(&repo, &["rev-parse", "main"]).unwrap();
    git(&repo, &["update-ref", "refs/heads/feature", main.trim()]).unwrap();
    assert!(delete_workspace_branch(
        &core,
        &workspace.id,
        "feature",
        fresh.head.as_deref().unwrap(),
        true
    )
    .unwrap_err()
    .contains("ветка изменилась"));
    git(
        &repo,
        &[
            "update-ref",
            "refs/heads/feature",
            fresh.head.as_deref().unwrap(),
        ],
    )
    .unwrap();
    delete_workspace_branch(
        &core,
        &workspace.id,
        "feature",
        fresh.head.as_deref().unwrap(),
        true,
    )
    .unwrap();
    assert!(git(
        &temp.path().join("repo"),
        &["rev-parse", "--verify", "refs/heads/feature"]
    )
    .is_err());
    assert!(git(
        &temp.path().join("repo"),
        &["rev-parse", "--verify", "refs/heads/main"]
    )
    .is_ok());
}

#[test]
fn locked_worktree_error_preserves_actual_state_and_can_be_retried() {
    use crate::workspaces::{delete_workspace, inspect_deletion};
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let workspace = worktree(&core, temp.path(), &project, "locked");
    let repo = temp.path().join("repo");
    git(&repo, &["worktree", "lock", &workspace.path]).unwrap();
    let check = inspect_deletion(&core, &workspace.id).unwrap();
    assert!(!check.has_work());
    assert!(delete_workspace(&core, &check, true, false).is_err());
    let failed = core.lock().unwrap().store.workspace(&workspace.id).unwrap();
    assert!(!failed.deleted);
    assert_eq!(failed.operation_state, "error");
    assert!(failed
        .operation_error
        .unwrap()
        .contains("регистрация worktree: сохранена"));
    assert!(Path::new(&workspace.path).exists());
    git(&repo, &["worktree", "unlock", &workspace.path]).unwrap();
    let check = inspect_deletion(&core, &workspace.id).unwrap();
    delete_workspace(&core, &check, true, false).unwrap();
    assert!(git(&repo, &["rev-parse", "--verify", "refs/heads/locked"]).is_ok());
}

#[test]
fn worktree_deletion_uses_saved_commit_after_source_branch_is_deleted_and_store_reopens() {
    use crate::workspaces::{delete_workspace, inspect_deletion};
    for committed_work in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (core, project_id) = repository_core(temp.path());
        let repo = temp.path().join("repo");
        git(&repo, &["branch", "base"]).unwrap();
        let workspace = create_worktree(
            &core,
            &NewWorktree {
                project_id,
                name: "Задача".into(),
                path: temp.path().join("feature").to_str().unwrap().into(),
                source_ref: "base".into(),
                branch: Some("feature".into()),
            },
        )
        .unwrap();
        let path = Path::new(&workspace.path);
        if committed_work {
            std::fs::write(path.join("file.txt"), "work").unwrap();
            git(path, &["add", "file.txt"]).unwrap();
            git(path, &["commit", "-m", "feature work"]).unwrap();
            git(&repo, &["update-ref", "refs/heads/base", "feature"]).unwrap();
            let check = inspect_deletion(&core, &workspace.id).unwrap();
            assert!(!check.has_work());
        }
        git(&repo, &["branch", "-D", "base"]).unwrap();
        drop(core);
        let core = Mutex::new(Core {
            store: Store::open(&temp.path().join("state.db")).unwrap(),
            processes: Processes::default(),
        });
        assert_eq!(
            core.lock()
                .unwrap()
                .store
                .workspace(&workspace.id)
                .unwrap()
                .source_commit,
            workspace.source_commit
        );
        let check = inspect_deletion(&core, &workspace.id).unwrap();
        assert!(check.changes.is_empty());
        assert_eq!(check.has_work(), committed_work);
        if committed_work {
            assert!(check.unmerged.contains("feature work"));
            assert!(delete_workspace(&core, &check, true, false).is_err());
            assert!(path.exists());
        }
        delete_workspace(&core, &check, true, committed_work).unwrap();
        assert!(!path.exists());
        assert!(git(&repo, &["rev-parse", "--verify", "refs/heads/feature"]).is_ok());
    }
}

#[cfg(unix)]
#[test]
fn deletion_rejects_active_sessions_processes_and_overlapping_workspace_activity() {
    use crate::workspaces::inspect_deletion;
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let workspace = worktree(&core, temp.path(), &project, "active");
    let context = history(&core.lock().unwrap().store, &workspace.id);
    {
        let mut guard = core.lock().unwrap();
        guard
            .store
            .connection
            .execute(
                "UPDATE sessions SET state='running' WHERE id=?1",
                [&context.session_id],
            )
            .unwrap();
        assert!(guard.ensure_workspace_idle(&workspace.id).is_err());
        guard
            .store
            .connection
            .execute(
                "UPDATE sessions SET state='completed' WHERE id=?1",
                [&context.session_id],
            )
            .unwrap();
        let Core { store, processes } = &mut *guard;
        let id = processes
            .spawn(
                store,
                &context,
                std::process::Command::new("/bin/sleep").arg("300"),
            )
            .unwrap();
        assert!(guard.ensure_workspace_idle(&workspace.id).is_err());
        let Core { store, processes } = &mut *guard;
        processes.stop(store, &context, &id).unwrap();
        assert!(guard.ensure_workspace_idle(&workspace.id).is_ok());
        guard
            .store
            .create_group("Общая папка", Some(temp.path()))
            .unwrap();
        let group = guard.store.snapshot().unwrap().groups[0].id.clone();
        let shared = guard.store.open_group_folder(&group).unwrap();
        let shared_context = history(&guard.store, &shared.id);
        guard
            .store
            .connection
            .execute(
                "UPDATE runs SET state='running' WHERE id=?1",
                [&shared_context.run_id],
            )
            .unwrap();
    }
    assert!(inspect_deletion(&core, &workspace.id).is_err());
}

#[test]
fn deletion_never_removes_a_replacement_repository_or_unregistered_files() {
    use crate::workspaces::{delete_workspace, inspect_deletion};
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let workspace = worktree(&core, temp.path(), &project, "replaced");
    std::fs::rename(&workspace.path, temp.path().join("original")).unwrap();
    repository(Path::new(&workspace.path));
    assert!(inspect_deletion(&core, &workspace.id)
        .unwrap_err()
        .contains("другому репозиторию"));
    assert!(Path::new(&workspace.path).join("file.txt").exists());
    let request = NewWorktree {
        project_id: project,
        name: "Ошибка создания".into(),
        path: temp.path().join("failed").to_str().unwrap().into(),
        source_ref: "missing".into(),
        branch: None,
    };
    assert!(create_worktree(&core, &request).is_err());
    std::fs::create_dir(&request.path).unwrap();
    std::fs::write(Path::new(&request.path).join("keep.txt"), "keep").unwrap();
    let failed_id = core
        .lock()
        .unwrap()
        .store
        .snapshot()
        .unwrap()
        .workspaces
        .last()
        .unwrap()
        .id
        .clone();
    let check = inspect_deletion(&core, &failed_id).unwrap();
    assert!(!check.registered);
    assert!(check.path_exists);
    delete_workspace(&core, &check, true, false).unwrap();
    assert!(Path::new(&request.path).join("keep.txt").exists());
}

#[test]
fn folder_deletion_preserves_sources_nested_repositories_history_and_drafts_after_reopening() {
    use crate::{
        model::{Draft, Tab, View},
        workspaces::{delete_workspace, inspect_deletion},
    };
    let temp = tempfile::tempdir().unwrap();
    let (core, _) = repository_core(temp.path());
    let (folder, shared, contexts) = {
        let guard = core.lock().unwrap();
        guard
            .store
            .create_group("Общая папка", Some(temp.path()))
            .unwrap();
        let group = guard.store.snapshot().unwrap().groups[0].id.clone();
        let shared = guard.store.open_group_folder(&group).unwrap();
        let folder = guard.store.snapshot().unwrap().workspaces[0].clone();
        let contexts = [
            history(&guard.store, &folder.id),
            history(&guard.store, &shared.id),
        ];
        (folder, shared, contexts)
    };
    for (workspace, context) in [folder, shared].iter().zip(contexts.iter()) {
        let draft = Draft {
            id: format!("message:{}", context.session_id),
            workspace_id: workspace.id.clone(),
            session_id: Some(context.session_id.clone()),
            path: None,
            body: "Не отправлено".into(),
            base_version: None,
        };
        core.lock().unwrap().store.save_draft(&draft).unwrap();
        core.lock()
            .unwrap()
            .store
            .save_view(&View {
                project_id: workspace.project_id.clone(),
                workspace_id: Some(workspace.id.clone()),
                tabs: vec![Tab {
                    id: "tab".into(),
                    workspace_id: workspace.id.clone(),
                    session_id: Some(context.session_id.clone()),
                }],
                active_tabs: [(workspace.id.clone(), "tab".into())].into(),
                sidebar_width: 260,
            })
            .unwrap();
        let check = inspect_deletion(&core, &workspace.id).unwrap();
        assert_eq!(check.kind, "folder");
        assert!(delete_workspace(&core, &check, false, false).is_err());
        assert!(core.lock().unwrap().store.workspace(&workspace.id).is_ok());
        delete_workspace(&core, &check, true, false).unwrap();
        let guard = core.lock().unwrap();
        assert!(guard.store.workspace(&workspace.id).is_err());
        assert!(guard.store.validate_context(context).is_err());
        assert_eq!(guard.store.drafts(&workspace.id).unwrap(), [draft]);
        let snapshot = guard.store.snapshot().unwrap();
        assert!(snapshot.view.workspace_id.is_none());
        assert!(snapshot.view.tabs.is_empty());
        assert!(snapshot.view.active_tabs.is_empty());
    }
    assert_eq!(
        std::fs::read_to_string(temp.path().join("repo/file.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        git(&temp.path().join("repo"), &["branch", "--show-current"])
            .unwrap()
            .trim(),
        "main"
    );
    drop(core);
    let store = Store::open(&temp.path().join("state.db")).unwrap();
    assert_eq!(store.snapshot().unwrap().sessions.len(), 2);
    for context in contexts {
        assert_eq!(
            store.messages(&context.session_id, 0).unwrap()[0].body,
            "История"
        );
        assert_eq!(
            store.drafts(&context.workspace_id).unwrap()[0].body,
            "Не отправлено"
        );
    }
}

#[test]
fn upgrading_stage_two_database_preserves_process_context() {
    use crate::store::migrate;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("old.db");
    let mut connection = rusqlite::Connection::open(&path).unwrap();
    migrate(
        &mut connection,
        &[include_str!("../migrations/001_initial.sql")],
    )
    .unwrap();
    connection.execute_batch("INSERT INTO projects(id,name,path,kind) VALUES('p','Проект','/old','folder');
        INSERT INTO workspaces(id,project_id,name,path,kind) VALUES('w','p','Основное','/old','folder');
        INSERT INTO sessions(id,workspace_id,executor,title,state) VALUES('s','w','codex','История','completed');
        INSERT INTO runs(id,session_id,state) VALUES('r','s','completed');
        INSERT INTO processes(id,run_id,pid,process_group,state) VALUES('process','r',123,123,'stopped');
        INSERT INTO messages(session_id,run_id,role,body) VALUES('s','r','user','Сохранено');").unwrap();
    drop(connection);
    let store = Store::open(&path).unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.workspaces[0].operation_state, "ready");
    assert_eq!(snapshot.workspaces[0].source_commit, None);
    assert_eq!(snapshot.workspaces[0].preparation_state, "skipped");
    assert_eq!(store.messages("s", 0).unwrap()[0].body, "Сохранено");
    let context: (String, String, i32) = store
        .connection
        .query_row(
            "SELECT run_id,workspace_id,pid FROM processes WHERE id='process'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(context, ("r".into(), "w".into(), 123));
}

#[cfg(unix)]
#[test]
fn preparation_background_child_blocks_deletion_after_shell_exit() {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let core = Arc::new(core);
    core.lock()
        .unwrap()
        .store
        .set_preparation_command(
            &project,
            "sleep 300 </dev/null >/dev/null 2>&1 & printf '%s' $! > child.pid",
        )
        .unwrap();
    let workspace = worktree(&core, temp.path(), &project, "background");
    crate::preparation::start(core.clone(), &workspace.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let child: i32 = loop {
        if let Some(pid) = std::fs::read_to_string(Path::new(&workspace.path).join("child.pid"))
            .ok()
            .and_then(|s| s.parse().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    std::thread::sleep(Duration::from_millis(150));
    let blocked = crate::workspaces::inspect_deletion(&core, &workspace.id);
    let state = core
        .lock()
        .unwrap()
        .store
        .workspace(&workspace.id)
        .unwrap()
        .preparation_state;
    let tracked = core.lock().unwrap().processes.has_workspace(&workspace.id);
    assert_eq!(unsafe { libc::kill(child, libc::SIGTERM) }, 0);
    assert!(blocked.is_err());
    assert_eq!(state, "running");
    assert!(tracked);
    loop {
        if core
            .lock()
            .unwrap()
            .store
            .workspace(&workspace.id)
            .unwrap()
            .preparation_state
            == "completed"
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(crate::workspaces::inspect_deletion(&core, &workspace.id).is_ok());
}

#[cfg(unix)]
#[test]
fn deletion_rejects_worktree_path_redirected_to_main_repository() {
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let workspace = worktree(&core, temp.path(), &project, "redirected");
    std::fs::rename(&workspace.path, temp.path().join("original")).unwrap();
    std::os::unix::fs::symlink(temp.path().join("repo"), &workspace.path).unwrap();
    assert!(crate::workspaces::inspect_deletion(&core, &workspace.id)
        .unwrap_err()
        .contains("перенаправлен"));
    assert!(temp.path().join("repo/file.txt").exists());
}

#[test]
fn saved_folder_project_is_recognized_as_repository_without_changing_relations() {
    let temp = tempfile::tempdir().unwrap();
    let (core, project) = repository_core(temp.path());
    let (workspace_id, context) = {
        let guard = core.lock().unwrap();
        let workspace_id = guard.store.snapshot().unwrap().workspaces[0].id.clone();
        let context = history(&guard.store, &workspace_id);
        guard
            .store
            .connection
            .execute("UPDATE projects SET kind='folder' WHERE id=?1", [&project])
            .unwrap();
        guard
            .store
            .connection
            .execute(
                "UPDATE workspaces SET git_ref=NULL WHERE id=?1",
                [&workspace_id],
            )
            .unwrap();
        (workspace_id, context)
    };
    drop(core);
    let store = Store::open(&temp.path().join("state.db")).unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.projects[0].id, project);
    assert_eq!(snapshot.projects[0].kind, "repository");
    assert_eq!(snapshot.workspaces[0].id, workspace_id);
    assert_eq!(snapshot.workspaces[0].git_ref.as_deref(), Some("main"));
    assert_eq!(snapshot.sessions[0].workspace_id, workspace_id);
    assert_eq!(
        store.messages(&context.session_id, 0).unwrap()[0].body,
        "История"
    );
    store.set_preparation_command(&project, "pwd").unwrap();
}
