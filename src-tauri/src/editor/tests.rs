use super::*;
use crate::model::NewWorktree;
use std::sync::Mutex;

fn fixture(temp: &Path) -> (Mutex<Core>, String, PathBuf) {
    let path = temp.join("repo");
    fs::create_dir_all(path.join("src")).unwrap();
    workspaces::git(&path, &["init", "-b", "main"]).unwrap();
    workspaces::git(&path, &["config", "user.name", "Test"]).unwrap();
    workspaces::git(&path, &["config", "user.email", "test@example.invalid"]).unwrap();
    fs::write(path.join("file.txt"), "исходник\n").unwrap();
    fs::write(path.join("src/code.ts"), "const text = 'совпадение';\n").unwrap();
    workspaces::git(&path, &["add", "."]).unwrap();
    workspaces::git(&path, &["commit", "-m", "initial"]).unwrap();
    let mut store = Store::open(&temp.join("state.db")).unwrap();
    store.register_folder("Проект", &path, None).unwrap();
    let workspace = store.snapshot().unwrap().workspaces[0].clone();
    let path = PathBuf::from(workspace.path);
    (
        Mutex::new(Core {
            store,
            processes: Default::default(),
        }),
        workspace.id,
        path,
    )
}

#[test]
fn project_search_respects_ignores_masks_regex_and_unicode_columns() {
    let temp = tempfile::tempdir().unwrap();
    let (_, _, root) = fixture(temp.path());
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/cache.ts"), "Hello hello123").unwrap();
    fs::write(root.join("src/matches.ts"), "🦀 Hello hello123 HELLO\n").unwrap();
    fs::write(root.join("src/matches.go"), "Hello\n").unwrap();
    let options = SearchOptions {
        match_case: false,
        whole_word: true,
        regexp: false,
        mask: "*.ts".into(),
        ..Default::default()
    };
    let found = search_with_options(&root, "hello", &options).unwrap();
    assert_eq!(found.matches.len(), 2);
    assert_eq!(found.matches[0].column, 3);
    assert_eq!(found.matches[0].matched, "Hello");
    assert!(found
        .matches
        .iter()
        .all(|item| item.path == "src/matches.ts"));
    let found = search_with_options(
        &root,
        r"hello\d+",
        &SearchOptions {
            regexp: true,
            mask: "*.ts".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].matched, "hello123");
    assert!(search_with_options(
        &root,
        "[",
        &SearchOptions {
            regexp: true,
            ..Default::default()
        }
    )
    .is_err());
    assert!(!source_files(&root)
        .unwrap()
        .iter()
        .any(|path| path.starts_with("ignored/") || path.starts_with(".git/")));

    fs::write(root.join("aaa.txt"), "Hello\n".repeat(201)).unwrap();
    assert!(
        search_with_options(&root, "Hello", &SearchOptions::default())
            .unwrap()
            .truncated
    );
    let scoped = search_with_options(
        &root,
        "Hello",
        &SearchOptions {
            paths: Some(HashSet::from([
                "ignored/cache.ts".into(),
                "src/matches.go".into(),
            ])),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!scoped.truncated);
    assert_eq!(scoped.matches.len(), 1);
    assert_eq!(scoped.matches[0].path, "src/matches.go");
}

#[test]
fn rename_keeps_unsaved_text_and_commits_all_documents() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, root) = fixture(temp.path());
    let mut first = open(&core, &id, "file.txt").unwrap();
    first.body.push_str("ручная правка\n");
    save_draft(
        &core.lock().unwrap().store,
        &id,
        &first.path,
        &first.body,
        &first.base,
    )
    .unwrap();
    let second = open(&core, &id, "src/code.ts").unwrap();
    let edits = vec![
        FileEdit {
            body: first.body.replace("исходник", "переименовано"),
            document: first,
        },
        FileEdit {
            body: second.body.replace("text", "message"),
            document: second,
        },
    ];
    let saved = apply_edits(&core, &id, &edits).unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "переименовано\nручная правка\n"
    );
    assert!(fs::read_to_string(root.join("src/code.ts"))
        .unwrap()
        .contains("message"));
    assert!(drafts(&core.lock().unwrap().store, &id).unwrap().is_empty());
    assert!(saved
        .iter()
        .all(|document| document.body == document.base
            && document.disk.as_ref() == Some(&document.body)));
}

#[test]
fn rename_rejects_stale_disk_and_drafts_before_writing_any_file() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, root) = fixture(temp.path());
    let first = open(&core, &id, "file.txt").unwrap();
    let second = open(&core, &id, "src/code.ts").unwrap();
    let edits = vec![
        FileEdit {
            body: "новое имя\n".into(),
            document: first.clone(),
        },
        FileEdit {
            body: "новый текст\n".into(),
            document: second.clone(),
        },
    ];
    fs::write(root.join("src/code.ts"), "внешняя правка").unwrap();
    assert!(apply_edits(&core, &id, &edits)
        .unwrap_err()
        .contains("изменён снаружи"));
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        first.body
    );
    fs::write(root.join("src/code.ts"), &second.body).unwrap();
    save_draft(
        &core.lock().unwrap().store,
        &id,
        &second.path,
        "ещё одна ручная правка",
        &second.base,
    )
    .unwrap();
    assert!(apply_edits(&core, &id, &edits)
        .unwrap_err()
        .contains("черновик изменился"));
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        first.body
    );
    assert_eq!(
        open(&core, &id, "src/code.ts").unwrap().body,
        "ещё одна ручная правка"
    );
}

#[test]
fn rename_cannot_write_outside_workspace_or_to_duplicate_paths() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, root) = fixture(temp.path());
    let first = open(&core, &id, "file.txt").unwrap();
    let mut outside = first.clone();
    outside.path = "../outside.txt".into();
    let edits = vec![
        FileEdit {
            body: "new".into(),
            document: first.clone(),
        },
        FileEdit {
            body: "new".into(),
            document: outside,
        },
    ];
    assert!(apply_edits(&core, &id, &edits).is_err());
    let edits = vec![
        FileEdit {
            body: "new".into(),
            document: first.clone(),
        },
        FileEdit {
            body: "other".into(),
            document: first.clone(),
        },
    ];
    assert!(apply_edits(&core, &id, &edits)
        .unwrap_err()
        .contains("повторяется"));
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        first.body
    );
}

#[test]
fn rename_draft_failure_keeps_every_original_draft() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, root) = fixture(temp.path());
    let first = open(&core, &id, "file.txt").unwrap();
    let second = open(&core, &id, "src/code.ts").unwrap();
    core.lock().unwrap().store.connection.execute_batch("CREATE TRIGGER fail_second_draft BEFORE INSERT ON drafts WHEN NEW.path='src/code.ts' BEGIN SELECT RAISE(ABORT,'диск недоступен'); END;").unwrap();
    let edits = vec![
        FileEdit {
            body: "переименовано\n".into(),
            document: first.clone(),
        },
        FileEdit {
            body: "другое имя\n".into(),
            document: second.clone(),
        },
    ];
    assert!(apply_edits(&core, &id, &edits).is_err());
    assert!(drafts(&core.lock().unwrap().store, &id).unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        first.body
    );
    assert_eq!(
        fs::read_to_string(root.join("src/code.ts")).unwrap(),
        second.body
    );
}

#[test]
fn tree_and_search_open_the_selected_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let (core, original, _) = fixture(temp.path());
    let project = core
        .lock()
        .unwrap()
        .store
        .workspace(&original)
        .unwrap()
        .project_id
        .unwrap();
    let mut workspaces = Vec::new();
    for name in ["first", "second"] {
        let workspace = workspaces::create_worktree(
            &core,
            &NewWorktree {
                project_id: project.clone(),
                name: name.into(),
                path: temp.path().join(name).to_str().unwrap().into(),
                source_ref: "main".into(),
                branch: Some(name.into()),
            },
        )
        .unwrap();
        fs::write(
            Path::new(&workspace.path).join("file.txt"),
            format!("{name} совпадение\n"),
        )
        .unwrap();
        workspaces.push(workspace);
    }
    for workspace in workspaces {
        let root = root(&core.lock().unwrap().store, &workspace.id).unwrap();
        let entries = directory(&root, "").unwrap();
        assert_eq!(entries[0].path, "src");
        assert!(entries[0].directory);
        assert!(!entries.iter().any(|e| e.name == ".git"));
        let results = search(&root, "совпадение").unwrap();
        assert_eq!(results.matches.len(), 2);
        let found = results
            .matches
            .iter()
            .find(|m| m.path == "file.txt")
            .unwrap();
        assert_eq!(found.line, 1);
        assert_eq!(found.column, workspace.name.chars().count() + 2);
        let document = open(&core, &workspace.id, &found.path).unwrap();
        assert_eq!(document.body, format!("{} совпадение\n", workspace.name));
    }
}

#[test]
fn paths_cannot_escape_workspace_or_read_git_internals() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let root = root(&core.lock().unwrap().store, &id).unwrap();
    for invalid in [
        "../state.db",
        "/etc/hosts",
        ".git/config",
        "src/../../state.db",
    ] {
        assert!(disk(&root, invalid).is_err());
        assert!(directory(&root, invalid).is_err());
    }
    assert!(open(&core, "unknown", "file.txt").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.path().join("state.db"), path.join("link")).unwrap();
        assert!(disk(&root, "link").is_err());
        assert!(!directory(&root, "")
            .unwrap()
            .iter()
            .any(|e| e.path == "link"));
    }
    fs::write(path.join("binary"), [0, 255, 10]).unwrap();
    assert!(disk(&root, "binary").is_err());
    fs::write(path.join("many.txt"), "найти\n".repeat(205)).unwrap();
    let results = search(&root, "найти").unwrap();
    assert_eq!(results.matches.len(), 200);
    assert!(results.truncated);
}

#[test]
fn draft_survives_restart_and_external_edit_until_explicit_resolution() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let mut document = open(&core, &id, "file.txt").unwrap();
    document.body = "ручные правки\n".into();
    save_draft(
        &core.lock().unwrap().store,
        &id,
        &document.path,
        &document.body,
        &document.base,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        "исходник\n"
    );
    fs::write(path.join("file.txt"), "внешняя правка\n").unwrap();
    drop(core);
    let core = Mutex::new(Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    });
    let mut restored = open(&core, &id, "file.txt").unwrap();
    assert_eq!(restored.base, "исходник\n");
    assert_eq!(restored.body, "ручные правки\n");
    assert_eq!(restored.disk.as_deref(), Some("внешняя правка\n"));
    assert!(save(&core, &id, &restored, false).is_err());
    fs::write(path.join("file.txt"), "ещё одна правка\n").unwrap();
    assert!(save(&core, &id, &restored, true).is_err());
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        "ещё одна правка\n"
    );
    restored.disk = Some("ещё одна правка\n".into());
    let saved = save(&core, &id, &restored, true).unwrap();
    assert_eq!(saved.body, saved.base);
    assert_eq!(saved.disk.as_deref(), Some(saved.body.as_str()));
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        "ручные правки\n"
    );
    assert!(core.lock().unwrap().store.drafts(&id).unwrap().is_empty());
}

#[test]
fn unreadable_source_restores_draft_after_restart_without_allowing_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    save_draft(
        &core.lock().unwrap().store,
        &id,
        "file.txt",
        "ручные правки\n",
        "исходник\n",
    )
    .unwrap();
    drop(core);
    let core = Mutex::new(Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    });
    for bytes in [vec![255, 10], b"binary\0text".to_vec()] {
        fs::write(path.join("file.txt"), &bytes).unwrap();
        let restored = open(&core, &id, "file.txt").unwrap();
        assert_eq!(restored.body, "ручные правки\n");
        assert_eq!(restored.base, "исходник\n");
        assert!(restored.disk_error.is_some());
        assert!(save(&core, &id, &restored, false).is_err());
        assert!(save(&core, &id, &restored, true).is_err());
        assert_eq!(fs::read(path.join("file.txt")).unwrap(), bytes);
        assert!(open(&core, &id, "src/code.ts")
            .unwrap()
            .disk_error
            .is_none());
    }
    fs::remove_file(path.join("file.txt")).unwrap();
    fs::create_dir(path.join("file.txt")).unwrap();
    let restored = open(&core, &id, "file.txt").unwrap();
    assert_eq!(restored.body, "ручные правки\n");
    assert!(restored.disk_error.is_some());
    fs::remove_dir(path.join("file.txt")).unwrap();
    fs::write(path.join("file.txt"), "внешняя версия").unwrap();
    let restored = open(&core, &id, "file.txt").unwrap();
    assert!(restored.disk_error.is_none());
    assert_eq!(restored.disk.as_deref(), Some("внешняя версия"));
    save(&core, &id, &restored, true).unwrap();
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        "ручные правки\n"
    );
}

#[test]
fn unreadable_file_without_draft_still_fails_to_open() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    fs::write(path.join("file.txt"), [255]).unwrap();
    assert!(open(&core, &id, "file.txt").is_err());
    #[cfg(unix)]
    {
        save_draft(
            &core.lock().unwrap().store,
            &id,
            "link",
            "правки",
            "исходник",
        )
        .unwrap();
        std::os::unix::fs::symlink(path.join("file.txt"), path.join("link")).unwrap();
        assert!(open(&core, &id, "link").is_err());
    }
}

#[test]
fn unsupported_formats_and_encodings_never_open_or_overwrite_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    for (name, bytes) in [
        (
            "document.pdf",
            b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n".as_slice(),
        ),
        ("image.gif", b"GIF89a1111111".as_slice()),
        ("binary", b"binary\0data".as_slice()),
        ("utf16le.txt", &[0xff, 0xfe, b'a', 0, b'b', 0]),
        ("utf16be.txt", &[0xfe, 0xff, 0, b'a', 0, b'b']),
        ("cp1251.txt", &[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
    ] {
        fs::write(path.join(name), bytes).unwrap();
        assert!(open(&core, &id, name).is_err(), "{name}");
        assert!(disk(&path, name).is_err(), "{name}");
        let document = Document {
            path: name.into(),
            body: "правки".into(),
            base: "".into(),
            disk: Some("".into()),
            disk_error: None,
        };
        assert!(save(&core, &id, &document, true).is_err(), "{name}");
        assert_eq!(fs::read(path.join(name)).unwrap(), bytes);
    }
    workspaces::git(&path, &["add", "document.pdf"]).unwrap();
    assert!(git_version(&path, "document.pdf", "index").is_err());
    assert!(crate::git::versions(&path, "document.pdf")
        .unwrap()
        .iter()
        .filter(|version| version.name != "HEAD")
        .all(|version| version.error.is_some()));
}

#[test]
fn utf8_line_endings_bom_and_svg_source_survive_edit_and_save() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    for (name, original) in [
        ("unknown", "обычный UTF-8\n"),
        ("bom.go", "\u{feff}package main\r\n"),
        ("lf.ts", "const value = 42;\n"),
        ("crlf.ts", "const value = 42;\r\n"),
        ("image.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>throw 'never execute'</script></svg>"),
    ] {
        fs::write(path.join(name), original).unwrap();
        let mut document = open(&core, &id, name).unwrap();
        assert_eq!(document.body, original);
        assert_eq!(fs::read_to_string(path.join(name)).unwrap(), original);
        document.body.push_str(" ");
        let saved = save(&core, &id, &document, false).unwrap();
        assert_eq!(saved.body, format!("{original} "));
        assert_eq!(fs::read_to_string(path.join(name)).unwrap(), saved.body);
    }
}

#[test]
fn deleted_file_keeps_draft_and_requires_explicit_restore() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let mut document = open(&core, &id, "file.txt").unwrap();
    document.body = "восстановлено".into();
    save_draft(
        &core.lock().unwrap().store,
        &id,
        &document.path,
        &document.body,
        &document.base,
    )
    .unwrap();
    fs::remove_file(path.join("file.txt")).unwrap();
    let restored = open(&core, &id, "file.txt").unwrap();
    assert_eq!(restored.disk, None);
    assert_eq!(restored.body, document.body);
    assert!(save(&core, &id, &restored, false).is_err());
    assert!(!path.join("file.txt").exists());
    save(&core, &id, &restored, true).unwrap();
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        "восстановлено"
    );
}

#[test]
fn write_error_keeps_original_and_draft() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let mut document = open(&core, &id, "file.txt").unwrap();
    document.body = "ручная правка".into();
    let mut permissions = fs::metadata(path.join("file.txt")).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path.join("file.txt"), permissions).unwrap();
    assert!(save(&core, &id, &document, false)
        .unwrap_err()
        .contains("только для чтения"));
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        document.base
    );
    assert_eq!(open(&core, &id, "file.txt").unwrap().body, document.body);
}

#[test]
fn draft_database_failure_prevents_source_write() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let mut document = open(&core, &id, "file.txt").unwrap();
    document.body = "ручная правка".into();
    core.lock().unwrap().store.connection.execute_batch("CREATE TRIGGER fail_draft BEFORE INSERT ON drafts BEGIN SELECT RAISE(FAIL, 'disk full'); END;").unwrap();
    assert!(save(&core, &id, &document, false)
        .unwrap_err()
        .contains("disk full"));
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        document.base
    );
}

#[test]
fn comparisons_read_head_index_worktree_and_selected_commit_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let root = root(&core.lock().unwrap().store, &id).unwrap();
    let initial = workspaces::git(&path, &["rev-parse", "HEAD"]).unwrap();
    fs::write(path.join("file.txt"), "подготовлено\n").unwrap();
    workspaces::git(&path, &["add", "file.txt"]).unwrap();
    fs::write(path.join("file.txt"), "не подготовлено\n").unwrap();
    let index_path = workspaces::git(
        &path,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )
    .unwrap();
    let index_before = fs::read(index_path.trim()).unwrap();
    assert_eq!(
        git_version(&root, "file.txt", "HEAD").unwrap(),
        "исходник\n"
    );
    assert_eq!(
        git_version(&root, "file.txt", initial.trim()).unwrap(),
        "исходник\n"
    );
    assert_eq!(
        git_version(&root, "file.txt", "index").unwrap(),
        "подготовлено\n"
    );
    assert_eq!(
        disk(&root, "file.txt").unwrap().as_deref(),
        Some("не подготовлено\n")
    );
    assert!(git_version(&root, "file.txt", "does-not-exist").is_err());
    assert_eq!(git_version(&root, "new.txt", "HEAD").unwrap(), "");
    assert_eq!(git_version(&root, "new.txt", "index").unwrap(), "");
    assert_eq!(fs::read(index_path.trim()).unwrap(), index_before);
    assert_eq!(
        fs::read_to_string(path.join("file.txt")).unwrap(),
        "не подготовлено\n"
    );
    let nested = path.join("ordinary");
    fs::create_dir(&nested).unwrap();
    assert!(git_version(&nested, "file.txt", "HEAD").is_err());
}

#[test]
fn comparison_selects_nested_repository_and_literal_path() {
    let temp = tempfile::tempdir().unwrap();
    let (_, _, parent) = fixture(temp.path());
    let nested = parent.join("nested");
    fs::create_dir(&nested).unwrap();
    workspaces::git(&nested, &["init"]).unwrap();
    workspaces::git(&nested, &["config", "user.name", "Test"]).unwrap();
    workspaces::git(&nested, &["config", "user.email", "test@example.invalid"]).unwrap();
    fs::write(nested.join("[a].txt"), "вложенный").unwrap();
    workspaces::git(&nested, &["--literal-pathspecs", "add", "--", "[a].txt"]).unwrap();
    assert_eq!(git_version(&parent, "nested/[a].txt", "HEAD").unwrap(), "");
    assert_eq!(
        git_version(&parent, "nested/[a].txt", "index").unwrap(),
        "вложенный"
    );
    workspaces::git(&nested, &["commit", "-m", "initial"]).unwrap();
    assert_eq!(
        git_version(&parent, "nested/[a].txt", "HEAD").unwrap(),
        "вложенный"
    );
}

#[test]
fn deleted_drafts_remain_listed_after_restart_only_in_their_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let (core, id, path) = fixture(temp.path());
    let other_path = temp.path().join("other");
    fs::create_dir(&other_path).unwrap();
    let other_id = {
        let mut core = core.lock().unwrap();
        core.store
            .register_folder("Другой проект", &other_path, None)
            .unwrap();
        let other_id = core
            .store
            .snapshot()
            .unwrap()
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id != id)
            .unwrap()
            .id;
        save_draft(&core.store, &id, "file.txt", "ручные правки", "исходник\n").unwrap();
        save_draft(&core.store, &other_id, "other.txt", "другие правки", "").unwrap();
        core.store
            .insert_session(&crate::model::Session {
                id: "conversation".into(),
                workspace_id: id.clone(),
                executor: "codex".into(),
                external_id: None,
                title: "Разговор".into(),
                state: "completed".into(),
                last_activity_at: 0,
            })
            .unwrap();
        core.store
            .save_draft(&Draft {
                id: "conversation-draft".into(),
                workspace_id: id.clone(),
                session_id: Some("conversation".into()),
                path: None,
                body: "сообщение".into(),
                base_version: None,
            })
            .unwrap();
        other_id
    };
    fs::remove_file(path.join("file.txt")).unwrap();
    drop(core);
    let core = Mutex::new(Core {
        store: Store::open(&temp.path().join("state.db")).unwrap(),
        processes: Default::default(),
    });
    assert_eq!(
        drafts(&core.lock().unwrap().store, &id).unwrap(),
        ["file.txt"]
    );
    assert_eq!(
        drafts(&core.lock().unwrap().store, &other_id).unwrap(),
        ["other.txt"]
    );
    assert!(drafts(&core.lock().unwrap().store, "unknown").is_err());
    let restored = open(&core, &id, "file.txt").unwrap();
    assert_eq!(restored.body, "ручные правки");
    assert!(restored.disk.is_none());
}
