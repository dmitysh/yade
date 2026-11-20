use super::*;

fn log_options() -> LogOptions {
    LogOptions {
        reference: None,
        query: String::new(),
        author: String::new(),
        offset: 0,
    }
}

#[test]
fn amend_preserves_unstaged_work_rejects_stale_head_and_runs_hooks() {
    let temp = temporary();
    init(temp.path());
    let previous = workspaces::git(temp.path(), &["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();
    fs::write(temp.path().join("file.txt"), "prepared\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    fs::write(temp.path().join("file.txt"), "working\n").unwrap();
    action(
        temp.path(),
        &Action::Amend {
            message: "updated commit".into(),
            reference: previous.clone(),
        },
    )
    .unwrap();
    let current = workspaces::git(temp.path(), &["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();
    assert_ne!(current, previous);
    assert_eq!(
        workspaces::git(temp.path(), &["rev-list", "--count", "HEAD"])
            .unwrap()
            .trim(),
        "1"
    );
    assert_eq!(
        workspaces::git(temp.path(), &["show", "HEAD:file.txt"]).unwrap(),
        "prepared\n"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "working\n"
    );
    assert!(action(
        temp.path(),
        &Action::Amend {
            message: "stale".into(),
            reference: previous
        }
    )
    .unwrap_err()
    .contains("изменился"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hook = temp.path().join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho 'amend rejected' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(action(
            temp.path(),
            &Action::Amend {
                message: "rejected".into(),
                reference: current.clone()
            }
        )
        .unwrap_err()
        .contains("amend rejected"));
    }
    assert_eq!(
        workspaces::git(temp.path(), &["rev-parse", "HEAD"])
            .unwrap()
            .trim(),
        current
    );
}

#[test]
fn history_reads_root_changes_binary_deletions_and_literal_paths_without_writes() {
    let temp = temporary();
    init(temp.path());
    let initial = history(temp.path(), &log_options()).unwrap();
    assert_eq!(initial.commits.len(), 1);
    let root = &initial.commits[0];
    assert!(root.parents.is_empty());
    let details = commit_details(temp.path(), &root.hash).unwrap();
    assert_eq!(details.files[0].path, "file.txt");
    assert_eq!(details.files[0].added, Some(1));
    let versions = revision_versions(temp.path(), &root.hash, "file.txt", None).unwrap();
    assert!(versions[0].text.is_none());
    assert_eq!(versions[1].text.as_deref(), Some("original\n"));
    fs::remove_file(temp.path().join("file.txt")).unwrap();
    fs::write(temp.path().join("[a]\t\n.txt"), "new\n").unwrap();
    fs::write(temp.path().join("binary"), b"data\0binary").unwrap();
    stage_files(
        temp.path(),
        &["file.txt".into(), "[a]\t\n.txt".into(), "binary".into()],
    )
    .unwrap();
    commit(temp.path(), "Изменение\n\nПодробное описание").unwrap();
    let before = fs::read(temp.path().join(".git/index")).unwrap();
    let details = commit_details(temp.path(), "HEAD").unwrap();
    assert_eq!(details.message.trim(), "Изменение\n\nПодробное описание");
    assert_eq!(details.files.len(), 3);
    assert!(details
        .files
        .iter()
        .any(|f| f.path == "[a]\t\n.txt" && f.added == Some(1)));
    assert!(details
        .files
        .iter()
        .any(|f| f.path == "binary" && f.added.is_none()));
    let deleted = revision_versions(temp.path(), "HEAD", "file.txt", None).unwrap();
    assert_eq!(deleted[0].text.as_deref(), Some("original\n"));
    assert!(deleted[1].text.is_none());
    let binary = revision_versions(temp.path(), "HEAD", "binary", None).unwrap();
    assert!(binary[1].error.is_some());
    assert!(revision_versions(temp.path(), "HEAD", "../file", None).is_err());
    assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), before);
    let mut options = log_options();
    options.query = "ИЗМЕНЕНИЕ".into();
    assert_eq!(history(temp.path(), &options).unwrap().commits.len(), 1);
    options.query = "test@example.invalid".into();
    assert_eq!(history(temp.path(), &options).unwrap().commits.len(), 2);
    options.query = details.hash[..8].into();
    assert_eq!(
        history(temp.path(), &options).unwrap().commits[0].hash,
        details.hash
    );
    options.author = "other".into();
    assert!(history(temp.path(), &options).unwrap().commits.is_empty());
}

#[test]
fn empty_repository_and_detached_history_are_supported() {
    let temp = temporary();
    workspaces::git(temp.path(), &["init", "-b", "main"]).unwrap();
    assert!(history(temp.path(), &log_options())
        .unwrap()
        .commits
        .is_empty());
    assert_eq!(status(temp.path()).unwrap().reference, "main");
    fs::write(temp.path().join("new"), "work\n").unwrap();
    stage_files(temp.path(), &["new".into()]).unwrap();
    fs::write(temp.path().join("new"), "updated work\n").unwrap();
    unstage_files(temp.path(), &["new".into()]).unwrap();
    assert!(index_version(temp.path(), "new").unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(temp.path().join("new")).unwrap(),
        "updated work\n"
    );
    init(temp.path());
    workspaces::git(temp.path(), &["switch", "--detach"]).unwrap();
    assert_eq!(
        history(temp.path(), &log_options()).unwrap().commits.len(),
        1
    );
}

#[test]
fn unstage_is_literal_preserves_disk_and_handles_renames() {
    let temp = temporary();
    init(temp.path());
    workspaces::git(temp.path(), &["mv", "file.txt", "[renamed].txt"]).unwrap();
    fs::write(temp.path().join("other"), "keep staged\n").unwrap();
    stage_files(temp.path(), &["other".into()]).unwrap();
    unstage_files(temp.path(), &["[renamed].txt".into()]).unwrap();
    assert_eq!(
        workspaces::git(temp.path(), &["diff", "--cached", "--name-only"]).unwrap(),
        "other\n"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("[renamed].txt")).unwrap(),
        "original\n"
    );
    assert!(!temp.path().join("file.txt").exists());
    let before = fs::read(temp.path().join(".git/index")).unwrap();
    assert!(unstage_files(temp.path(), &["other".into(), ".".into()]).is_err());
    assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), before);
}

#[test]
fn discard_checks_the_snapshot_and_only_discards_unstaged_work() {
    let temp = temporary();
    init(temp.path());
    fs::write(temp.path().join("file.txt"), "staged\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    fs::write(temp.path().join("file.txt"), "unstaged\n").unwrap();
    let expected = diff(temp.path(), "file.txt").unwrap();
    fs::write(temp.path().join("file.txt"), "new work\n").unwrap();
    assert!(discard_file(temp.path(), &expected)
        .unwrap_err()
        .contains("обновите"));
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "new work\n"
    );
    discard_file(temp.path(), &diff(temp.path(), "file.txt").unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "staged\n"
    );
    assert_eq!(
        workspaces::git(temp.path(), &["show", "HEAD:file.txt"]).unwrap(),
        "original\n"
    );
    fs::write(temp.path().join("new"), "untracked\n").unwrap();
    discard_file(temp.path(), &diff(temp.path(), "new").unwrap()).unwrap();
    assert!(!temp.path().join("new").exists());
}

#[test]
fn switching_to_a_branch_used_by_another_worktree_explains_how_to_proceed() {
    let temp = temporary();
    let repository = temp.path().join("repo");
    let other = temp.path().join("другая рабочая копия");
    init(&repository);
    workspaces::git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "TASK-12345",
            other.to_str().unwrap(),
        ],
    )
    .unwrap();

    let error = action(
        &repository,
        &Action::Switch {
            reference: "refs/heads/TASK-12345".into(),
        },
    )
    .unwrap_err();

    assert_eq!(error, format!(
        "Не удалось переключиться на ветку «TASK-12345»: она уже открыта в другой рабочей копии: {}.",
        other.display()
    ));
    assert_eq!(status(&repository).unwrap().reference, "main");
    assert_eq!(status(&other).unwrap().reference, "TASK-12345");
}

#[test]
fn create_branch_optionally_switches_to_the_selected_commit() {
    for checkout in [false, true] {
        let temp = temporary();
        init(temp.path());
        let start = workspaces::git(temp.path(), &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        fs::write(temp.path().join("file.txt"), "main change\n").unwrap();
        stage_files(temp.path(), &["file.txt".into()]).unwrap();
        commit(temp.path(), "main change").unwrap();
        let current = workspaces::git(temp.path(), &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        fs::write(temp.path().join("local.txt"), "local work\n").unwrap();

        action(
            temp.path(),
            &Action::CreateBranch {
                name: "feature".into(),
                start: start.clone(),
                checkout,
            },
        )
        .unwrap();

        assert_eq!(
            workspaces::git(temp.path(), &["rev-parse", "refs/heads/feature"])
                .unwrap()
                .trim(),
            start
        );
        assert_eq!(
            status(temp.path()).unwrap().reference,
            if checkout { "feature" } else { "main" }
        );
        assert_eq!(
            workspaces::git(temp.path(), &["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            if checkout { start } else { current }
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            if checkout {
                "original\n"
            } else {
                "main change\n"
            }
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("local.txt")).unwrap(),
            "local work\n"
        );
    }
}

#[test]
fn branches_sort_master_first_then_local_and_remote_names() {
    let temp = temporary();
    init(temp.path());
    for reference in [
        "refs/heads/zeta",
        "refs/heads/master",
        "refs/heads/alpha",
        "refs/remotes/origin/zeta",
        "refs/remotes/upstream/master",
        "refs/remotes/origin/alpha",
        "refs/remotes/origin/feature/master",
        "refs/remotes/origin/master",
        "refs/tags/zeta",
        "refs/tags/master",
        "refs/tags/alpha",
    ] {
        workspaces::git(temp.path(), &["update-ref", reference, "HEAD"]).unwrap();
    }
    workspaces::git(
        temp.path(),
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/master",
        ],
    )
    .unwrap();
    let branches = branches(temp.path()).unwrap();
    assert_eq!(
        branches
            .iter()
            .map(|branch| branch.name.as_str())
            .collect::<Vec<_>>(),
        [
            "master",
            "alpha",
            "main",
            "zeta",
            "origin/master",
            "upstream/master",
            "origin/alpha",
            "origin/feature/master",
            "origin/zeta",
            "alpha",
            "master",
            "zeta",
        ]
    );
    assert!(branches.iter().find(|branch| branch.current).unwrap().name == "main");
}

#[test]
fn branches_tags_merges_and_history_use_real_refs() {
    let temp = temporary();
    init(temp.path());
    action(
        temp.path(),
        &Action::CreateBranch {
            name: "feature".into(),
            start: "HEAD".into(),
            checkout: true,
        },
    )
    .unwrap();
    assert_eq!(status(temp.path()).unwrap().reference, "feature");
    fs::write(temp.path().join("file.txt"), "feature\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    commit(temp.path(), "feature change").unwrap();
    action(
        temp.path(),
        &Action::CreateTag {
            name: "v1".into(),
            reference: "HEAD".into(),
        },
    )
    .unwrap();
    assert!(branches(temp.path())
        .unwrap()
        .iter()
        .any(|b| b.kind == "tag" && b.name == "v1"));
    action(
        temp.path(),
        &Action::Switch {
            reference: "refs/heads/main".into(),
        },
    )
    .unwrap();
    assert!(action(
        temp.path(),
        &Action::DeleteBranch {
            name: "feature".into()
        }
    )
    .is_err());
    fs::write(temp.path().join("other"), "main\n").unwrap();
    stage_files(temp.path(), &["other".into()]).unwrap();
    commit(temp.path(), "main change").unwrap();
    action(
        temp.path(),
        &Action::Merge {
            reference: "refs/heads/feature".into(),
        },
    )
    .unwrap();
    let history = history(temp.path(), &log_options()).unwrap();
    assert_eq!(history.commits[0].parents.len(), 2);
    let details = commit_details(temp.path(), "HEAD").unwrap();
    assert_eq!(details.files.len(), 1);
    assert_eq!(details.files[0].path, "file.txt");
    let comparison = compare_branches(temp.path(), "refs/heads/feature", "HEAD").unwrap();
    assert_eq!(comparison.files.len(), 1);
    assert_eq!(comparison.files[0].path, "other");
    let versions = revision_versions(
        temp.path(),
        &comparison.hash,
        "other",
        Some(&comparison.message),
    )
    .unwrap();
    assert!(versions[0].text.is_none());
    assert_eq!(versions[1].text.as_deref(), Some("main\n"));
    action(
        temp.path(),
        &Action::DeleteBranch {
            name: "feature".into(),
        },
    )
    .unwrap();
    action(temp.path(), &Action::DeleteTag { name: "v1".into() }).unwrap();
    for name in ["--force", "HEAD", "../outside", "@{-1}"] {
        assert!(action(
            temp.path(),
            &Action::CreateBranch {
                name: name.into(),
                start: "HEAD".into(),
                checkout: true,
            }
        )
        .is_err());
    }
    assert!(action(
        temp.path(),
        &Action::Switch {
            reference: "--detach".into()
        }
    )
    .is_err());
}

#[test]
fn history_pages_do_not_repeat_commits_and_filters_keep_offsets() {
    let temp = temporary();
    init(temp.path());
    let tree = workspaces::git(temp.path(), &["rev-parse", "HEAD^{tree}"])
        .unwrap()
        .trim()
        .to_string();
    let mut parent = workspaces::git(temp.path(), &["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();
    for index in 0..105 {
        parent = workspaces::git(
            temp.path(),
            &[
                "commit-tree",
                &tree,
                "-p",
                &parent,
                "-m",
                &format!("page {index}"),
            ],
        )
        .unwrap()
        .trim()
        .to_string();
    }
    workspaces::git(temp.path(), &["update-ref", "refs/heads/main", &parent]).unwrap();
    let first = history(temp.path(), &log_options()).unwrap();
    assert_eq!(first.commits.len(), 100);
    assert!(first.has_more);
    let mut options = log_options();
    options.offset = 100;
    let second = history(temp.path(), &options).unwrap();
    assert_eq!(second.commits.len(), 6);
    assert!(!second.has_more);
    assert!(second
        .commits
        .iter()
        .all(|c| first.commits.iter().all(|first| first.hash != c.hash)));
    options.query = "page".into();
    let filtered = history(temp.path(), &options).unwrap();
    assert_eq!(filtered.commits.len(), 5);
    assert!(!filtered.has_more);
    options.reference = Some("--all".into());
    assert!(history(temp.path(), &options).is_err());
}

#[test]
fn fetch_push_pull_track_a_local_remote_and_preserve_work_on_divergence() {
    let temp = temporary();
    let repo = temp.path().join("repo");
    let remote = temp.path().join("remote.git");
    let peer = temp.path().join("peer");
    init(&repo);
    workspaces::git(
        temp.path(),
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    )
    .unwrap();
    workspaces::git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .unwrap();
    action(
        &repo,
        &Action::Push {
            remote: Some("origin".into()),
            force: false,
        },
    )
    .unwrap();
    assert_eq!(
        status(&repo).unwrap().upstream.as_deref(),
        Some("origin/main")
    );
    workspaces::git(
        temp.path(),
        &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
    )
    .unwrap();
    workspaces::git(&peer, &["config", "user.name", "Peer"]).unwrap();
    workspaces::git(&peer, &["config", "user.email", "peer@example.invalid"]).unwrap();
    workspaces::git(&peer, &["config", "commit.gpgSign", "false"]).unwrap();
    fs::write(peer.join("incoming"), "incoming\n").unwrap();
    stage_files(&peer, &["incoming".into()]).unwrap();
    commit(&peer, "incoming").unwrap();
    push(&peer).unwrap();
    action(&repo, &Action::Fetch).unwrap();
    assert_eq!(status(&repo).unwrap().behind, 1);
    assert!(!repo.join("incoming").exists());
    action(&repo, &Action::Pull).unwrap();
    assert_eq!(
        fs::read_to_string(repo.join("incoming")).unwrap(),
        "incoming\n"
    );
    fs::write(repo.join("local"), "local\n").unwrap();
    stage_files(&repo, &["local".into()]).unwrap();
    commit(&repo, "local").unwrap();
    fs::write(peer.join("incoming"), "diverged\n").unwrap();
    stage_files(&peer, &["incoming".into()]).unwrap();
    commit(&peer, "diverged").unwrap();
    push(&peer).unwrap();
    action(&repo, &Action::Fetch).unwrap();
    let status = status(&repo).unwrap();
    assert_eq!((status.ahead, status.behind), (1, 1));
    let head = workspaces::git(&repo, &["rev-parse", "HEAD"]).unwrap();
    assert!(action(&repo, &Action::Pull).is_err());
    assert_eq!(
        workspaces::git(&repo, &["rev-parse", "HEAD"]).unwrap(),
        head
    );
    assert!(action(
        &repo,
        &Action::Push {
            remote: Some("--all".into()),
            force: false,
        }
    )
    .is_err());
    assert!(action(
        &repo,
        &Action::Push {
            remote: None,
            force: false,
        }
    )
    .is_err());
    let remote_head = workspaces::git(&remote, &["rev-parse", "refs/heads/main"]).unwrap();
    workspaces::git(&peer, &["commit", "--allow-empty", "-m", "unseen"]).unwrap();
    push(&peer).unwrap();
    assert!(action(
        &repo,
        &Action::Push {
            remote: None,
            force: true,
        }
    )
    .is_err());
    assert_ne!(
        workspaces::git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(),
        remote_head
    );
    assert_eq!(
        workspaces::git(&repo, &["rev-parse", "HEAD"]).unwrap(),
        head
    );
    action(&repo, &Action::Fetch).unwrap();
    action(
        &repo,
        &Action::Push {
            remote: None,
            force: true,
        },
    )
    .unwrap();
    assert_eq!(
        workspaces::git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(),
        head
    );
}

#[test]
fn stash_keeps_index_untracked_files_and_checks_identity() {
    let temp = temporary();
    init(temp.path());
    fs::write(temp.path().join("file.txt"), "staged\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    fs::write(temp.path().join("file.txt"), "working\n").unwrap();
    fs::write(temp.path().join("new"), "untracked\n").unwrap();
    action(
        temp.path(),
        &Action::StashSave {
            message: "pending".into(),
        },
    )
    .unwrap();
    assert!(status(temp.path()).unwrap().changes.is_empty());
    let stash = stashes(temp.path()).unwrap().remove(0);
    assert!(action(
        temp.path(),
        &Action::StashDrop {
            reference: stash.reference.clone(),
            hash: "stale".into()
        }
    )
    .is_err());
    action(
        temp.path(),
        &Action::StashApply {
            reference: stash.reference.clone(),
            hash: stash.hash.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        workspaces::git(temp.path(), &["show", ":file.txt"]).unwrap(),
        "staged\n"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "working\n"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("new")).unwrap(),
        "untracked\n"
    );
    assert_eq!(stashes(temp.path()).unwrap().len(), 1);
    action(
        temp.path(),
        &Action::StashDrop {
            reference: stash.reference,
            hash: stash.hash,
        },
    )
    .unwrap();
    assert!(stashes(temp.path()).unwrap().is_empty());
}

#[test]
fn pushing_respects_an_upstream_with_a_different_branch_name() {
    let temp = temporary();
    let repo = temp.path().join("repo");
    let remote = temp.path().join("remote.git");
    init(&repo);
    workspaces::git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]).unwrap();
    workspaces::git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .unwrap();
    workspaces::git(
        &repo,
        &["push", "-u", "origin", "HEAD:refs/heads/review/main"],
    )
    .unwrap();
    fs::write(repo.join("file.txt"), "updated\n").unwrap();
    stage_files(&repo, &["file.txt".into()]).unwrap();
    commit(&repo, "update").unwrap();
    workspaces::git(
        &repo,
        &["remote", "add", "another", remote.to_str().unwrap()],
    )
    .unwrap();
    let push: Action = serde_json::from_value(serde_json::json!({ "kind": "push" })).unwrap();
    action(&repo, &push).unwrap();
    assert_eq!(
        workspaces::git(&repo, &["rev-parse", "HEAD"]).unwrap(),
        workspaces::git(&remote, &["rev-parse", "refs/heads/review/main"]).unwrap()
    );
    assert!(workspaces::git(&remote, &["show-ref", "--verify", "refs/heads/main"]).is_err());
    assert_eq!(
        status(&repo).unwrap().upstream.as_deref(),
        Some("origin/review/main")
    );
    action(
        &repo,
        &Action::Switch {
            reference: "refs/remotes/origin/review/main".into(),
        },
    )
    .unwrap();
    assert_eq!(status(&repo).unwrap().reference, "review/main");
}

#[cfg(unix)]
#[test]
fn pushing_preserves_server_messages_and_porcelain_output() {
    use std::os::unix::fs::PermissionsExt;
    for explicit_remote in [true, false] {
        let temp = temporary();
        let repo = temp.path().join("repo");
        let remote = temp.path().join("remote.git");
        init(&repo);
        workspaces::git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        workspaces::git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .unwrap();
        workspaces::git(&repo, &["config", "push.autoSetupRemote", "true"]).unwrap();
        let hook = remote.join("hooks/post-receive");
        fs::write(
            &hook,
            "#!/bin/sh\necho 'Create pull request: https://example.invalid/pull-requests?create' >&2\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

        let output = if explicit_remote {
            action(
                &repo,
                &Action::Push {
                    remote: Some("origin".into()),
                    force: false,
                },
            )
        } else {
            push(&repo)
        }
        .unwrap();

        assert!(output.contains("[new branch]"), "{output}");
        assert!(
            output.contains(
                "remote: Create pull request: https://example.invalid/pull-requests?create"
            ),
            "{output}"
        );
    }
}

#[test]
fn cherry_pick_revert_and_conflict_abort_report_actual_state() {
    let temp = temporary();
    init(temp.path());
    action(
        temp.path(),
        &Action::CreateBranch {
            name: "feature".into(),
            start: "HEAD".into(),
            checkout: true,
        },
    )
    .unwrap();
    fs::write(temp.path().join("file.txt"), "feature\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    commit(temp.path(), "feature").unwrap();
    let feature = workspaces::git(temp.path(), &["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();
    action(
        temp.path(),
        &Action::Switch {
            reference: "refs/heads/main".into(),
        },
    )
    .unwrap();
    action(
        temp.path(),
        &Action::CherryPick {
            reference: feature.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "feature\n"
    );
    action(
        temp.path(),
        &Action::Revert {
            reference: "HEAD".into(),
        },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "original\n"
    );
    fs::write(temp.path().join("file.txt"), "ours\n").unwrap();
    stage_files(temp.path(), &["file.txt".into()]).unwrap();
    commit(temp.path(), "ours").unwrap();
    assert!(action(temp.path(), &Action::CherryPick { reference: feature }).is_err());
    assert_eq!(
        status(temp.path()).unwrap().operation.as_deref(),
        Some("cherry_pick")
    );
    assert!(status(temp.path()).unwrap().changes[0].conflict);
    action(temp.path(), &Action::Abort).unwrap();
    assert!(status(temp.path()).unwrap().operation.is_none());
    assert_eq!(
        fs::read_to_string(temp.path().join("file.txt")).unwrap(),
        "ours\n"
    );
}
