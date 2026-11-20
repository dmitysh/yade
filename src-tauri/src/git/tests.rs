use super::*;
use std::fs;

mod workflow;

fn temporary() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

fn init(path: &Path) {
    fs::create_dir_all(path).unwrap();
    workspaces::git(path, &["init", "-b", "main"]).unwrap();
    workspaces::git(path, &["config", "user.name", "Test"]).unwrap();
    workspaces::git(path, &["config", "user.email", "test@example.invalid"]).unwrap();
    workspaces::git(path, &["config", "commit.gpgSign", "false"]).unwrap();
    fs::write(path.join("file.txt"), "original\n").unwrap();
    workspaces::git(path, &["add", "."]).unwrap();
    workspaces::git(path, &["commit", "-m", "initial"]).unwrap();
}

#[test]
fn targets_select_only_roots_inside_the_workspace() {
    let temp = temporary();
    let parent = temp.path().join("projects");
    init(&parent.join("first"));
    init(&parent.join("second"));
    init(&temp.path().join("outside"));
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.create_group("Группа", Some(&parent)).unwrap();
    let group = store.snapshot().unwrap().groups[0].id.clone();
    for name in ["first", "second"] {
        store
            .register_folder(name, &parent.join(name), Some(&group))
            .unwrap();
    }
    let workspace = store.open_group_folder(&group).unwrap();
    assert_eq!(
        repositories(&store, &workspace.id).unwrap(),
        ["first", "second"]
    );
    for name in ["first", "second"] {
        let target = Target {
            workspace_id: workspace.id.clone(),
            repository: name.into(),
        };
        let path = target.resolve(&store, false).unwrap();
        assert_eq!(path, parent.join(name).canonicalize().unwrap());
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let status = status(&path).unwrap();
        assert_eq!(status.reference, "main");
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].path, format!("{name}.txt"));
    }
    for invalid in ["", "../outside", "/tmp", "first/.git", "first/subfolder"] {
        assert!(Target {
            workspace_id: workspace.id.clone(),
            repository: invalid.into()
        }
        .resolve(&store, false)
        .is_err());
    }
    let detached = parent.join("first");
    workspaces::git(&detached, &["checkout", "--detach"]).unwrap();
    assert_eq!(
        status(&detached).unwrap().reference,
        workspaces::git(&detached, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.path().join("outside"), parent.join("link")).unwrap();
        assert!(Target {
            workspace_id: workspace.id.clone(),
            repository: "link".into()
        }
        .resolve(&store, true)
        .is_err());
    }
}

#[test]
fn ordinary_folder_does_not_inherit_parent_repository() {
    let temp = temporary();
    init(temp.path());
    let folder = temp.path().join("ordinary");
    fs::create_dir(&folder).unwrap();
    let mut store = Store::open(&temp.path().join("state.db")).unwrap();
    store.register_folder("Папка", &folder, None).unwrap();
    let id = store.snapshot().unwrap().workspaces[0].id.clone();
    assert!(repositories(&store, &id).unwrap().is_empty());
    assert!(Target {
        workspace_id: id,
        repository: "".into()
    }
    .resolve(&store, true)
    .unwrap_err()
    .contains("нет Git"));
}

#[test]
fn staging_is_literal_and_keeps_other_files_and_repositories_out_of_index() {
    let temp = temporary();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    init(&first);
    init(&second);
    fs::write(first.join("file.txt"), "changed\n").unwrap();
    fs::write(first.join("[a]\n.txt"), "selected\n").unwrap();
    fs::write(first.join("a\n.txt"), "unselected\n").unwrap();
    fs::write(second.join("file.txt"), "neighbor\n").unwrap();
    assert!(stage_files(&first, &[".".into()]).is_err());
    assert!(stage_files(&first, &["../second/file.txt".into()]).is_err());
    stage_files(&first, &["[a]\n.txt".into()]).unwrap();
    let staged = workspaces::git(&first, &["diff", "--cached", "--name-only", "-z"]).unwrap();
    assert_eq!(staged, "[a]\n.txt\0");
    assert!(workspaces::git(&second, &["diff", "--cached"])
        .unwrap()
        .is_empty());
    let changes = status(&first).unwrap().changes;
    assert_eq!(
        changes
            .iter()
            .find(|c| c.path == "[a]\n.txt")
            .unwrap()
            .index,
        'A'
    );
    assert_eq!(
        changes.iter().find(|c| c.path == "file.txt").unwrap().index,
        ' '
    );
    fs::remove_file(first.join("file.txt")).unwrap();
    stage_files(&first, &["file.txt".into()]).unwrap();
    assert_eq!(
        status(&first)
            .unwrap()
            .changes
            .iter()
            .find(|c| c.path == "file.txt")
            .unwrap()
            .index,
        'D'
    );
}

fn two_hunks(path: &Path) -> (String, String) {
    let original: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    fs::write(path.join("file.txt"), &original).unwrap();
    stage_files(path, &["file.txt".into()]).unwrap();
    workspaces::git(path, &["commit", "-m", "lines"]).unwrap();
    let changed = original
        .replace("line 2\n", "first\ninserted\n")
        .replace("line 28\n", "last\n");
    fs::write(path.join("file.txt"), &changed).unwrap();
    (original, changed)
}

#[test]
fn selected_hunk_keeps_other_hunk_and_worktree_unchanged() {
    for hunk in [0, 1] {
        let temp = temporary();
        init(temp.path());
        let (original, changed) = two_hunks(temp.path());
        let expected = diff(temp.path(), "file.txt").unwrap();
        assert_eq!(expected.hunks.len(), 2);
        stage_hunk(temp.path(), &expected, hunk).unwrap();
        let index = workspaces::git(temp.path(), &["show", ":file.txt"]).unwrap();
        assert_eq!(
            index,
            if hunk == 0 {
                original.replace("line 2\n", "first\ninserted\n")
            } else {
                original.replace("line 28\n", "last\n")
            }
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            changed
        );
        assert_eq!(diff(temp.path(), "file.txt").unwrap().hunks.len(), 1);
        assert!(!temp.path().join(".git/index.lock").exists());
    }
}

#[test]
fn stale_file_or_index_and_forged_patch_do_not_change_the_index() {
    let temp = temporary();
    init(temp.path());
    let (_, changed) = two_hunks(temp.path());
    let expected = diff(temp.path(), "file.txt").unwrap();
    let index_path = temp.path().join(".git/index");
    let before = fs::read(&index_path).unwrap();
    fs::write(temp.path().join("file.txt"), "external\n").unwrap();
    assert!(stage_hunk(temp.path(), &expected, 0)
        .unwrap_err()
        .contains("обновите diff"));
    assert_eq!(fs::read(&index_path).unwrap(), before);
    fs::write(temp.path().join("file.txt"), &changed).unwrap();
    let mut forged = expected.clone();
    forged.patch = forged.patch.replace("file.txt", "other.txt");
    assert!(stage_hunk(temp.path(), &forged, 0).is_err());
    assert_eq!(fs::read(&index_path).unwrap(), before);
    stage_hunk(temp.path(), &expected, 0).unwrap();
    let after = fs::read(&index_path).unwrap();
    assert!(stage_hunk(temp.path(), &expected, 1)
        .unwrap_err()
        .contains("обновите diff"));
    assert_eq!(fs::read(&index_path).unwrap(), after);
    assert!(!temp.path().join(".git/index.lock").exists());
}

#[test]
fn hunks_handle_new_deleted_and_quoted_paths_and_respect_git_lock() {
    let temp = temporary();
    init(temp.path());
    let name = "[a] space\n.txt";
    fs::write(temp.path().join(name), "new\n").unwrap();
    let expected = diff(temp.path(), name).unwrap();
    fs::write(temp.path().join(".git/index.lock"), "another Git").unwrap();
    assert!(stage_hunk(temp.path(), &expected, 0)
        .unwrap_err()
        .contains("индекс занят"));
    assert_eq!(
        fs::read_to_string(temp.path().join(".git/index.lock")).unwrap(),
        "another Git"
    );
    fs::remove_file(temp.path().join(".git/index.lock")).unwrap();
    stage_hunk(temp.path(), &expected, 0).unwrap();
    assert_eq!(
        editor::git_version(temp.path(), name, "index").unwrap(),
        "new\n"
    );
    fs::remove_file(temp.path().join("file.txt")).unwrap();
    let deleted = diff(temp.path(), "file.txt").unwrap();
    stage_hunk(temp.path(), &deleted, 0).unwrap();
    assert!(editor::git_version(temp.path(), "file.txt", "index")
        .unwrap()
        .is_empty());
    assert_eq!(fs::read_to_string(temp.path().join(name)).unwrap(), "new\n");
}

#[cfg(unix)]
#[test]
fn preparing_text_hunk_does_not_prepare_file_mode_change() {
    use std::os::unix::fs::PermissionsExt;
    let temp = temporary();
    init(temp.path());
    let (original, _) = two_hunks(temp.path());
    fs::set_permissions(
        temp.path().join("file.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let expected = diff(temp.path(), "file.txt").unwrap();
    stage_hunk(temp.path(), &expected, 0).unwrap();
    assert!(index_version(temp.path(), "file.txt")
        .unwrap()
        .starts_with("100644 "));
    assert_eq!(
        workspaces::git(temp.path(), &["show", ":file.txt"]).unwrap(),
        original.replace("line 2\n", "first\ninserted\n")
    );
}

#[test]
fn commit_and_push_preserve_unstaged_work_and_report_hook_and_remote_rejections() {
    let temp = temporary();
    let repository = temp.path().join("repo");
    let remote = temp.path().join("remote.git");
    init(&repository);
    workspaces::git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]).unwrap();
    workspaces::git(
        &repository,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .unwrap();
    workspaces::git(&repository, &["config", "push.autoSetupRemote", "true"]).unwrap();
    fs::write(repository.join("file.txt"), "staged\n").unwrap();
    stage_files(&repository, &["file.txt".into()]).unwrap();
    fs::write(repository.join("file.txt"), "unstaged\n").unwrap();
    fs::write(repository.join("other.txt"), "untracked\n").unwrap();
    assert!(commit(&repository, "   ").is_err());
    commit(&repository, "selected changes").unwrap();
    assert_eq!(
        workspaces::git(&repository, &["show", "HEAD:file.txt"]).unwrap(),
        "staged\n"
    );
    assert_eq!(
        workspaces::git(&repository, &["ls-tree", "--name-only", "HEAD"]).unwrap(),
        "file.txt\n"
    );
    push(&repository).unwrap();
    assert_eq!(
        workspaces::git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(),
        workspaces::git(&repository, &["rev-parse", "HEAD"]).unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hook = repository.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho 'commit rejected' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        stage_files(&repository, &["file.txt".into()]).unwrap();
        let head = workspaces::git(&repository, &["rev-parse", "HEAD"]).unwrap();
        let index = index_version(&repository, "file.txt").unwrap();
        assert!(commit(&repository, "rejected")
            .unwrap_err()
            .contains("commit rejected"));
        assert_eq!(
            workspaces::git(&repository, &["rev-parse", "HEAD"]).unwrap(),
            head
        );
        assert_eq!(index_version(&repository, "file.txt").unwrap(), index);
        fs::remove_file(hook).unwrap();
        commit(&repository, "local commit").unwrap();
        let hook = remote.join("hooks/pre-receive");
        fs::write(&hook, "#!/bin/sh\necho 'remote rejected' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let head = workspaces::git(&repository, &["rev-parse", "HEAD"]).unwrap();
        assert!(push(&repository).unwrap_err().contains("remote rejected"));
        assert_eq!(
            workspaces::git(&repository, &["rev-parse", "HEAD"]).unwrap(),
            head
        );
    }
    assert_eq!(
        fs::read_to_string(repository.join("file.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        fs::read_to_string(repository.join("other.txt")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn real_merge_conflict_is_read_edited_saved_staged_and_committed() {
    for delete_incoming in [false, true] {
        let temp = temporary();
        let repository = temp.path().join("repo");
        init(&repository);
        workspaces::git(&repository, &["checkout", "-b", "incoming"]).unwrap();
        if delete_incoming {
            fs::remove_file(repository.join("file.txt")).unwrap();
        } else {
            fs::write(repository.join("file.txt"), "theirs\n").unwrap();
        }
        stage_files(&repository, &["file.txt".into()]).unwrap();
        commit(&repository, "incoming change").unwrap();
        workspaces::git(&repository, &["checkout", "main"]).unwrap();
        fs::write(repository.join("file.txt"), "ours\n").unwrap();
        stage_files(&repository, &["file.txt".into()]).unwrap();
        commit(&repository, "our change").unwrap();
        assert!(workspaces::git(&repository, &["merge", "incoming"]).is_err());
        assert!(status(&repository)
            .unwrap()
            .changes
            .iter()
            .any(|c| c.path == "file.txt" && c.conflict));
        assert!(diff(&repository, "file.txt").is_err());
        let before = fs::read(repository.join(".git/index")).unwrap();
        let versions = versions(&repository, "file.txt").unwrap();
        assert_eq!(versions[0].text.as_deref(), Some("ours\n"));
        assert_eq!(
            versions[1].text.as_deref(),
            if delete_incoming {
                None
            } else {
                Some("theirs\n")
            }
        );
        assert_eq!(versions[2].text.as_deref(), Some("original\n"));
        assert_eq!(fs::read(repository.join(".git/index")).unwrap(), before);
        let mut store = Store::open(&temp.path().join("state.db")).unwrap();
        store.register_folder("Проект", &repository, None).unwrap();
        let id = store.snapshot().unwrap().workspaces[0].id.clone();
        let core = Mutex::new(crate::core::Core {
            store,
            processes: Default::default(),
        });
        let mut document = editor::open(&core, &id, "file.txt").unwrap();
        let resolution = if delete_incoming {
            "ours\n"
        } else {
            "manually resolved\n"
        };
        document.body = resolution.into();
        editor::save(&core, &id, &document, false).unwrap();
        assert!(status(&repository).unwrap().changes[0].conflict);
        stage_files(&repository, &["file.txt".into()]).unwrap();
        assert!(status(&repository)
            .unwrap()
            .changes
            .iter()
            .all(|c| !c.conflict));
        assert_eq!(
            workspaces::git(&repository, &["show", ":file.txt"]).unwrap(),
            resolution
        );
        commit(&repository, "resolve conflict").unwrap();
        assert_eq!(
            workspaces::git(&repository, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .unwrap()
                .split_whitespace()
                .count(),
            3
        );
        assert!(status(&repository).unwrap().changes.is_empty());
    }
}

#[test]
fn staged_text_comparison_survives_binary_working_file() {
    let temp = temporary();
    init(temp.path());
    fs::write(temp.path().join("file.txt"), "prepared\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    fs::write(temp.path().join("file.txt"), b"binary\0content").unwrap();

    let versions = versions(temp.path(), "file.txt").unwrap();
    assert_eq!(versions[0].text.as_deref(), Some("original\n"));
    assert_eq!(versions[1].text.as_deref(), Some("prepared\n"));
    assert_eq!(versions[2].text, None);
    assert!(versions[0].error.is_none());
    assert!(versions[1].error.is_none());
    assert!(versions[2]
        .error
        .as_deref()
        .unwrap()
        .contains("двоичный файл"));
}

#[test]
fn comparisons_show_exact_head_index_and_disk_without_writing() {
    let temp = temporary();
    init(temp.path());
    fs::write(temp.path().join("file.txt"), "prepared\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    fs::write(temp.path().join("file.txt"), "working\n").unwrap();
    let before = fs::read(temp.path().join(".git/index")).unwrap();
    let versions = versions(temp.path(), "file.txt").unwrap();
    assert_eq!(
        versions
            .iter()
            .map(|v| v.text.as_deref())
            .collect::<Vec<_>>(),
        [Some("original\n"), Some("prepared\n"), Some("working\n")]
    );
    assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), before);
    let unborn = temp.path().join("unborn");
    fs::create_dir(&unborn).unwrap();
    workspaces::git(&unborn, &["init", "-b", "main"]).unwrap();
    fs::write(unborn.join(".gitattributes"), "*.txt text eol=lf\n").unwrap();
    fs::write(unborn.join("new.txt"), "new\r\n").unwrap();
    let expected = diff(&unborn, "new.txt").unwrap();
    stage_hunk(&unborn, &expected, 0).unwrap();
    let versions = super::versions(&unborn, "new.txt").unwrap();
    assert_eq!(versions[0].text, None);
    assert_eq!(versions[1].text.as_deref(), Some("new\n"));
}

#[test]
fn changing_another_index_entry_invalidates_the_hunk_snapshot() {
    let temp = temporary();
    init(temp.path());
    two_hunks(temp.path());
    let expected = diff(temp.path(), "file.txt").unwrap();
    fs::write(temp.path().join("other.txt"), "external staged file\n").unwrap();
    stage_files(temp.path(), &["other.txt".into()]).unwrap();
    let before = fs::read(temp.path().join(".git/index")).unwrap();
    assert!(stage_hunk(temp.path(), &expected, 0)
        .unwrap_err()
        .contains("обновите diff"));
    assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), before);
}

#[test]
fn concurrent_hunks_use_the_selected_worktree_index_and_recheck_the_snapshot() {
    use std::sync::Barrier;
    let temp = temporary();
    let repository = temp.path().join("repo");
    let worktree = temp.path().join("task");
    init(&repository);
    let (_, changed) = two_hunks(&repository);
    workspaces::git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "task",
            "--",
            worktree.to_str().unwrap(),
        ],
    )
    .unwrap();
    fs::write(worktree.join("file.txt"), &changed).unwrap();
    let original_index = fs::read(repository.join(".git/index")).unwrap();
    let expected = diff(&worktree, "file.txt").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|hunk| {
                let barrier = &barrier;
                let expected = &expected;
                let worktree = &worktree;
                scope.spawn(move || {
                    barrier.wait();
                    stage_hunk(worktree, expected, hunk)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(results
        .iter()
        .find_map(|r| r.as_ref().err())
        .unwrap()
        .contains("обновите diff"));
    assert_eq!(diff(&worktree, "file.txt").unwrap().hunks.len(), 1);
    assert_eq!(
        fs::read(repository.join(".git/index")).unwrap(),
        original_index
    );
    assert_eq!(
        fs::read_to_string(worktree.join("file.txt")).unwrap(),
        changed
    );
}

#[test]
fn renamed_file_comparison_reads_head_from_the_original_path() {
    for prepared in ["original\n", "original\nchanged\n"] {
        let temp = temporary();
        init(temp.path());
        workspaces::git(temp.path(), &["mv", "file.txt", "renamed.txt"]).unwrap();
        fs::write(temp.path().join("renamed.txt"), prepared).unwrap();
        workspaces::git(temp.path(), &["add", "--", "renamed.txt"]).unwrap();
        let changes = status(temp.path()).unwrap().changes;
        assert_eq!(changes[0].index, 'R');
        assert_eq!(changes[0].original_path.as_deref(), Some("file.txt"));
        let before = fs::read(temp.path().join(".git/index")).unwrap();
        let versions = versions(temp.path(), "renamed.txt").unwrap();
        assert_eq!(versions[0].text.as_deref(), Some("original\n"));
        assert_eq!(versions[1].text.as_deref(), Some(prepared));
        assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), before);
    }
}

#[test]
fn staging_deleted_file_does_not_stage_its_replacement_directory() {
    for select_nested in [false, true] {
        let temp = temporary();
        init(temp.path());
        fs::remove_file(temp.path().join("file.txt")).unwrap();
        fs::create_dir(temp.path().join("file.txt")).unwrap();
        fs::write(temp.path().join("file.txt/unselected.txt"), "unselected\n").unwrap();
        fs::write(temp.path().join("file.txt/selected.txt"), "selected\n").unwrap();
        let before = fs::read(temp.path().join(".git/index")).unwrap();
        assert!(stage_files(temp.path(), &["file.txt".into(), "stale.txt".into()]).is_err());
        assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), before);
        let mut paths = Vec::new();
        if select_nested {
            paths.push("file.txt/selected.txt".into());
        }
        paths.push("file.txt".into());

        stage_files(temp.path(), &paths).unwrap();
        stage_files(temp.path(), &["file.txt".into()]).unwrap();

        assert_eq!(
            workspaces::git(temp.path(), &["diff", "--cached", "--name-status", "-z"]).unwrap(),
            if select_nested {
                "D\0file.txt\0A\0file.txt/selected.txt\0"
            } else {
                "D\0file.txt\0"
            }
        );
        assert!(index_version(temp.path(), "file.txt/unselected.txt")
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt/unselected.txt")).unwrap(),
            "unselected\n"
        );
    }
}

#[test]
fn staging_restored_file_replaces_its_staged_deletion() {
    let temp = temporary();
    init(temp.path());
    fs::remove_file(temp.path().join("file.txt")).unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    fs::write(temp.path().join("file.txt"), "restored\n").unwrap();

    stage_files(temp.path(), &["file.txt".into()]).unwrap();

    assert_eq!(
        workspaces::git(temp.path(), &["show", ":file.txt"]).unwrap(),
        "restored\n"
    );
}
