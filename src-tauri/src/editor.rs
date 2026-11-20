use crate::{core::Core, model::Draft, store::Result, store::Store, workspaces};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub matched: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub match_case: bool,
    pub whole_word: bool,
    pub regexp: bool,
    pub mask: String,
    pub paths: Option<HashSet<String>>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub body: String,
    pub base: String,
    pub disk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_error: Option<String>,
}

pub fn root(store: &Store, workspace_id: &str) -> Result<PathBuf> {
    let workspace = store.workspace(workspace_id)?;
    if workspace.operation_state != "ready" {
        return Err("пространство недоступно для работы с файлами".into());
    }
    let path = workspaces::folder_path(Path::new(&workspace.path))?;
    if path != Path::new(&workspace.path) {
        return Err("путь пространства перенаправлен".into());
    }
    Ok(path)
}

fn relative_path(path: &str, allow_root: bool) -> Result<&Path> {
    if (!allow_root && path.is_empty())
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(name) if name != ".git"))
    {
        return Err("нужен относительный путь внутри пространства без .git".into());
    }
    Ok(Path::new(path))
}

pub(crate) fn target(root: &Path, path: &str, allow_root: bool) -> Result<PathBuf> {
    if fs::canonicalize(root).map_err(|e| e.to_string())? != root {
        return Err("путь пространства перенаправлен".into());
    }
    let mut target = root.to_path_buf();
    for component in relative_path(path, allow_root)?.components() {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("символическая ссылка недоступна в редакторе".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("путь недоступен: {e}")),
        }
    }
    Ok(target)
}

fn text(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => {
            validate_text(&text)?;
            Ok(Some(text))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            Err("неподдерживаемая кодировка или двоичный файл; редактор принимает UTF-8".into())
        }
        Err(e) => Err(format!("файл не прочитан: {e}")),
    }
}

pub(crate) fn validate_text(text: &str) -> Result<()> {
    let content = text.trim_start_matches('\u{feff}');
    if content.starts_with("%PDF-") {
        return Err("PDF недоступен в текстовом редакторе".into());
    }
    if text.contains('\0') || content.starts_with("GIF87a") || content.starts_with("GIF89a") {
        return Err("двоичный файл недоступен в текстовом редакторе".into());
    }
    Ok(())
}

pub fn directory(root: &Path, path: &str) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(target(root, path, true)?).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let kind = item.file_type().map_err(|e| e.to_string())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "путь не поддерживает UTF-8")?;
        if name == ".git" || !(kind.is_dir() || kind.is_file()) {
            continue;
        }
        entries.push(Entry {
            path: if path.is_empty() {
                name.clone()
            } else {
                format!("{path}/{name}")
            },
            name,
            directory: kind.is_dir(),
        });
    }
    entries.sort_by(|a, b| b.directory.cmp(&a.directory).then(a.name.cmp(&b.name)));
    Ok(entries)
}

pub fn search(root: &Path, query: &str) -> Result<SearchResults> {
    search_with_options(
        root,
        query,
        &SearchOptions {
            match_case: true,
            ..Default::default()
        },
    )
}

pub fn source_files(root: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build()
    {
        let entry = entry.map_err(|e| format!("файлы не прочитаны: {e}"))?;
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("путь не поддерживает UTF-8")?
            .to_string();
        files.push(path);
    }
    files.sort();
    Ok(files)
}

pub fn search_with_options(
    root: &Path,
    query: &str,
    options: &SearchOptions,
) -> Result<SearchResults> {
    let mut results = SearchResults::default();
    if query.is_empty() {
        return Ok(results);
    }
    let pattern = if options.regexp {
        query.into()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    let pattern = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!options.match_case)
        .build()
        .map_err(|e| format!("некорректное выражение: {e}"))?;
    let mut masks = ignore::overrides::OverrideBuilder::new(root);
    for mask in options
        .mask
        .split(',')
        .map(str::trim)
        .filter(|mask| !mask.is_empty())
    {
        masks
            .add(mask)
            .map_err(|e| format!("некорректная маска: {e}"))?;
    }
    let masks = masks.build().map_err(|e| e.to_string())?;
    for path in source_files(root)? {
        if options
            .paths
            .as_ref()
            .is_some_and(|paths| !paths.contains(&path))
            || masks.matched(root.join(&path), false).is_ignore()
        {
            continue;
        }
        let file = fs::File::open(target(root, &path, false)?).map_err(|e| e.to_string())?;
        for (number, line) in BufReader::new(file).lines().enumerate() {
            let line = match line {
                Ok(line) if !line.contains('\0') => line,
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => break,
                Err(e) => return Err(format!("поиск не завершён: {e}")),
            };
            for found in pattern.find_iter(&line).filter(|found| !found.is_empty()) {
                if results.matches.len() == 200 {
                    results.truncated = true;
                    return Ok(results);
                }
                results.matches.push(SearchMatch {
                    path: path.clone(),
                    line: number + 1,
                    column: line[..found.start()].chars().count() + 1,
                    text: line.chars().take(500).collect(),
                    matched: found.as_str().into(),
                });
            }
        }
    }
    Ok(results)
}

pub fn drafts(store: &Store, workspace_id: &str) -> Result<Vec<String>> {
    store.workspace(workspace_id)?;
    Ok(store
        .drafts(workspace_id)?
        .into_iter()
        .filter(|draft| draft.session_id.is_none())
        .filter_map(|draft| draft.path)
        .collect())
}

fn draft_id(workspace_id: &str, path: &str) -> String {
    format!("file:{workspace_id}:{path}")
}

pub fn open(core: &Mutex<Core>, workspace_id: &str, path: &str) -> Result<Document> {
    let (root, draft) = {
        let core = core.lock().map_err(|e| e.to_string())?;
        let root = root(&core.store, workspace_id)?;
        let draft = core
            .store
            .drafts(workspace_id)?
            .into_iter()
            .find(|d| d.path.as_deref() == Some(path));
        (root, draft)
    };
    let (disk, disk_error) = match text(&target(&root, path, false)?) {
        Ok(disk) => (disk, None),
        Err(error) if draft.is_some() => (None, Some(error)),
        Err(error) => return Err(error),
    };
    let (body, base) = if let Some(draft) = draft {
        (
            draft.body,
            draft
                .base_version
                .ok_or("у черновика отсутствует исходная версия")?,
        )
    } else {
        let body = disk.clone().ok_or("файл отсутствует")?;
        (body.clone(), body)
    };
    Ok(Document {
        path: path.into(),
        body,
        base,
        disk,
        disk_error,
    })
}

pub fn disk(root: &Path, path: &str) -> Result<Option<String>> {
    text(&target(root, path, false)?)
}

pub fn save_draft(
    store: &Store,
    workspace_id: &str,
    path: &str,
    body: &str,
    base: &str,
) -> Result<()> {
    relative_path(path, false)?;
    store.workspace(workspace_id)?;
    if body == base {
        return clear_draft(store, workspace_id, path);
    }
    store.save_draft(&Draft {
        id: draft_id(workspace_id, path),
        workspace_id: workspace_id.into(),
        session_id: None,
        path: Some(path.into()),
        body: body.into(),
        base_version: Some(base.into()),
    })
}

fn clear_draft(store: &Store, workspace_id: &str, path: &str) -> Result<()> {
    store
        .connection
        .execute(
            "DELETE FROM drafts WHERE workspace_id=?1 AND path=?2 AND session_id IS NULL",
            rusqlite::params![workspace_id, path],
        )
        .map_err(|e| format!("черновик не очищен: {e}"))?;
    Ok(())
}

pub fn save(
    core: &Mutex<Core>,
    workspace_id: &str,
    document: &Document,
    overwrite: bool,
) -> Result<Document> {
    let core = core.lock().map_err(|e| e.to_string())?;
    save_draft(
        &core.store,
        workspace_id,
        &document.path,
        &document.body,
        &document.base,
    )?;
    if document.disk_error.is_some() {
        return Err(
            "внешняя версия не прочитана; проверьте файл на диске перед сохранением".into(),
        );
    }
    if core.store.workspace(workspace_id)?.archived {
        return Err("пространство в архиве".into());
    }
    let root = root(&core.store, workspace_id)?;
    let path = target(&root, &document.path, false)?;
    let expected = if overwrite {
        document.disk.as_deref()
    } else {
        Some(document.base.as_str())
    };
    if text(&path)?.as_deref() != expected {
        return Err("файл изменён снаружи или удалён; обновите сравнение и выберите версию".into());
    }
    let permissions = fs::metadata(&path).map(|m| m.permissions());
    if permissions.as_ref().is_ok_and(|p| p.readonly()) {
        return Err("файл доступен только для чтения; черновик сохранён".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("папка файла отсутствует")?)
            .map_err(|e| format!("файл не записан: {e}"))?;
    temporary
        .write_all(document.body.as_bytes())
        .map_err(|e| format!("файл не записан: {e}"))?;
    if let Ok(permissions) = permissions {
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|e| e.to_string())?;
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    if target(&root, &document.path, false)? != path || text(&path)?.as_deref() != expected {
        return Err("файл изменился во время сохранения; повторите сравнение".into());
    }
    temporary
        .persist(&path)
        .map_err(|e| format!("файл не записан: {e}"))?;
    clear_draft(&core.store, workspace_id, &document.path)
        .map_err(|e| format!("файл записан, но {e}"))?;
    Ok(Document {
        path: document.path.clone(),
        body: document.body.clone(),
        base: document.body.clone(),
        disk: Some(document.body.clone()),
        disk_error: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub document: Document,
    pub body: String,
}

pub fn apply_edits(
    core: &Mutex<Core>,
    workspace_id: &str,
    edits: &[FileEdit],
) -> Result<Vec<Document>> {
    let core = core.lock().map_err(|e| e.to_string())?;
    if core.store.workspace(workspace_id)?.archived {
        return Err("пространство в архиве".into());
    }
    let root = root(&core.store, workspace_id)?;
    let mut paths = std::collections::HashSet::new();
    let mut prepared = Vec::new();
    for edit in edits {
        let document = &edit.document;
        if !paths.insert(&document.path) {
            return Err("в списке изменений повторяется файл".into());
        }
        let path = target(&root, &document.path, false)?;
        validate_text(&edit.body)?;
        if document.disk_error.is_some()
            || document.disk.as_ref() != Some(&document.base)
            || text(&path)?.as_deref() != Some(document.base.as_str())
        {
            return Err(format!(
                "{}: файл изменён снаружи; повторите предварительный просмотр",
                document.path
            ));
        }
        let draft = core
            .store
            .drafts(workspace_id)?
            .into_iter()
            .find(|draft| draft.path.as_deref() == Some(&document.path));
        if draft.as_ref().is_some_and(|draft| {
            draft.body != document.body || draft.base_version.as_ref() != Some(&document.base)
        }) || (draft.is_none() && document.body != document.base)
        {
            return Err(format!(
                "{}: черновик изменился; повторите предварительный просмотр",
                document.path
            ));
        }
        let permissions = fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        if permissions.readonly() {
            return Err(format!(
                "{}: файл доступен только для чтения",
                document.path
            ));
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(path.parent().ok_or("папка файла отсутствует")?)
                .map_err(|e| e.to_string())?;
        temporary
            .write_all(edit.body.as_bytes())
            .map_err(|e| e.to_string())?;
        temporary
            .as_file()
            .set_permissions(permissions.clone())
            .map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        let mut backup =
            tempfile::NamedTempFile::new_in(path.parent().ok_or("папка файла отсутствует")?)
                .map_err(|e| e.to_string())?;
        backup
            .write_all(document.base.as_bytes())
            .map_err(|e| e.to_string())?;
        backup
            .as_file()
            .set_permissions(permissions)
            .map_err(|e| e.to_string())?;
        backup.as_file().sync_all().map_err(|e| e.to_string())?;
        prepared.push((path, Some(temporary), Some(backup)));
    }
    let drafts_transaction = core
        .store
        .connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    for edit in edits {
        save_draft(
            &core.store,
            workspace_id,
            &edit.document.path,
            &edit.body,
            &edit.document.base,
        )?;
    }
    drafts_transaction.commit().map_err(|e| e.to_string())?;
    let mut written = 0;
    let result = (|| -> Result<()> {
        for (edit, (path, temporary, _)) in edits.iter().zip(prepared.iter_mut()) {
            if target(&root, &edit.document.path, false)? != *path
                || text(path)?.as_deref() != Some(edit.document.base.as_str())
            {
                return Err(format!(
                    "{}: файл изменился во время применения",
                    edit.document.path
                ));
            }
            temporary
                .take()
                .ok_or("подготовленный файл отсутствует")?
                .persist(path)
                .map_err(|e| e.to_string())?;
            written += 1;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut recovery = Vec::new();
        for index in (0..written).rev() {
            let (path, _, backup) = &mut prepared[index];
            let backup = backup.take().ok_or("резервная версия отсутствует")?;
            if target(&root, &edits[index].document.path, false).is_ok_and(|target| target == *path)
                && text(path).is_ok_and(|body| body.as_deref() == Some(edits[index].body.as_str()))
            {
                if let Err(failed) = backup.persist(&*path) {
                    let (_, saved) = failed.file.keep().map_err(|e| e.to_string())?;
                    recovery.push(saved.display().to_string());
                }
            } else {
                let (_, saved) = backup.keep().map_err(|e| e.to_string())?;
                recovery.push(saved.display().to_string());
            }
        }
        if recovery.is_empty() {
            for edit in edits {
                save_draft(
                    &core.store,
                    workspace_id,
                    &edit.document.path,
                    &edit.document.body,
                    &edit.document.base,
                )?;
            }
            return Err(format!("изменения отменены: {error}"));
        }
        return Err(format!("{error}; часть файлов требует восстановления. Новые версии сохранены в черновиках, исходные: {}", recovery.join(", ")));
    }
    let mut documents = Vec::new();
    for edit in edits {
        clear_draft(&core.store, workspace_id, &edit.document.path)
            .map_err(|e| format!("файлы переименованы, но черновики не очищены: {e}"))?;
        documents.push(Document {
            path: edit.document.path.clone(),
            body: edit.body.clone(),
            base: edit.body.clone(),
            disk: Some(edit.body.clone()),
            disk_error: None,
        });
    }
    Ok(documents)
}

pub fn git_version(root: &Path, path: &str, revision: &str) -> Result<String> {
    let path = target(root, path, false)?;
    let parent = path.parent().ok_or("папка файла отсутствует")?;
    let repository = workspaces::git(parent, &["rev-parse", "--show-toplevel"])?;
    let repository = workspaces::folder_path(Path::new(repository.trim()))?;
    if !repository.starts_with(root) {
        return Err("репозиторий находится вне выбранного пространства".into());
    }
    let relative = path
        .strip_prefix(&repository)
        .map_err(|e| e.to_string())?
        .to_str()
        .ok_or("путь не поддерживает UTF-8")?;
    let (version, entries) = if revision == "index" {
        (
            format!(":0:{relative}"),
            workspaces::git(
                &repository,
                &[
                    "--literal-pathspecs",
                    "ls-files",
                    "--stage",
                    "-z",
                    "--",
                    relative,
                ],
            )?,
        )
    } else {
        let commit = match workspaces::git(
            &repository,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{revision}^{{commit}}"),
            ],
        ) {
            Ok(commit) => commit,
            Err(_)
                if revision == "HEAD"
                    && workspaces::git(&repository, &["rev-list", "--all", "--count"])?.trim()
                        == "0" =>
            {
                return Ok(String::new())
            }
            Err(error) => return Err(error),
        };
        let commit = commit.trim();
        (
            format!("{commit}:{relative}"),
            workspaces::git(
                &repository,
                &[
                    "--literal-pathspecs",
                    "ls-tree",
                    "-z",
                    commit,
                    "--",
                    relative,
                ],
            )?,
        )
    };
    if entries.is_empty() {
        return Ok(String::new());
    }
    let text = workspaces::git(&repository, &["show", &version])?;
    validate_text(&text)?;
    Ok(text)
}

#[cfg(test)]
mod tests;
