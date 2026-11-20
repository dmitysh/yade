use crate::{core::Core, editor, store::Result, store::Store, workspaces};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

mod workflow;
pub use workflow::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub workspace_id: String,
    pub repository: String,
}

impl Target {
    pub fn resolve(&self, store: &Store, write: bool) -> Result<PathBuf> {
        let workspace = store.workspace(&self.workspace_id)?;
        if write && workspace.archived {
            return Err("пространство в архиве".into());
        }
        let root = editor::root(store, &self.workspace_id)?;
        let path = editor::target(&root, &self.repository, true)?;
        if !path.join(".git").try_exists().map_err(|e| e.to_string())? {
            return Err("в выбранной папке нет Git-репозитория".into());
        }
        let actual = workspaces::git(&path, &["rev-parse", "--show-toplevel"])?;
        if workspaces::folder_path(Path::new(actual.trim()))? != path {
            return Err("выбранная папка не является корнем репозитория".into());
        }
        Ok(path)
    }
}

pub fn with_target<T>(
    core: &Mutex<Core>,
    target: &Target,
    write: bool,
    operation: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    let (repository, _running) = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        core.processes.ensure_accepting()?;
        let repository = target.resolve(&core.store, write)?;
        (repository, core.processes.track_git()?)
    };
    operation(&repository)
}

pub fn repositories(store: &Store, workspace_id: &str) -> Result<Vec<String>> {
    let root = editor::root(store, workspace_id)?;
    let mut paths = vec![root.clone()];
    paths.extend(
        store
            .snapshot()?
            .projects
            .into_iter()
            .map(|p| PathBuf::from(p.path)),
    );
    let mut repositories = Vec::new();
    for path in paths {
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        if !path.join(".git").try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        let relative = relative.to_str().ok_or("путь не поддерживает UTF-8")?;
        Target {
            workspace_id: workspace_id.into(),
            repository: relative.into(),
        }
        .resolve(store, false)?;
        repositories.push(relative.into());
    }
    repositories.sort();
    repositories.dedup();
    Ok(repositories)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub original_path: Option<String>,
    pub index: char,
    pub worktree: char,
    pub conflict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub reference: String,
    pub changes: Vec<Change>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub remotes: Vec<String>,
    pub operation: Option<String>,
}

pub fn status(repository: &Path) -> Result<Status> {
    let output = workspaces::git(
        repository,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    let mut records = output.split('\0').filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        let bytes = record.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' || !bytes[..2].is_ascii() {
            return Err("некорректный ответ Git status".into());
        }
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let original_path = if [index, worktree].iter().any(|c| matches!(c, 'R' | 'C')) {
            Some(
                records
                    .next()
                    .ok_or("отсутствует исходный путь переименования")?
                    .into(),
            )
        } else {
            None
        };
        changes.push(Change {
            path: record[3..].into(),
            original_path,
            index,
            worktree,
            conflict: matches!(&record[..2], "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU"),
        });
    }
    let upstream_output = workspaces::git_command(repository)?
        .args([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let upstream = upstream_output.status.success().then(|| {
        String::from_utf8_lossy(&upstream_output.stdout)
            .trim()
            .to_string()
    });
    let (ahead, behind) = if let Some(upstream) = &upstream {
        let counts = workspaces::git(
            repository,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{upstream}"),
                "--",
            ],
        )?;
        let mut counts = counts.split_whitespace();
        (
            counts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            counts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
        )
    } else {
        (0, 0)
    };
    let directory = workspaces::git(repository, &["rev-parse", "--absolute-git-dir"])?;
    let directory = Path::new(directory.trim());
    let operation = [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry_pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .into_iter()
    .find(|(path, _)| directory.join(path).exists())
    .map(|(_, name)| name.into());
    Ok(Status {
        reference: workspaces::git_ref(repository)?,
        changes,
        upstream,
        ahead,
        behind,
        operation,
        remotes: workspaces::git(repository, &["remote"])?
            .lines()
            .map(String::from)
            .collect(),
    })
}

fn mutate<T>(repository: &Path, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let lock = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?
        .entry(repository.to_path_buf())
        .or_default()
        .clone();
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    operation()
}

pub fn stage_files(repository: &Path, paths: &[String]) -> Result<()> {
    mutate(repository, || {
        if paths.is_empty() {
            return Err("выберите файлы для подготовки".into());
        }
        let status = status(repository)?;
        let mut args = vec!["--literal-pathspecs", "add", "--"];
        let mut removed = vec!["update-index", "--force-remove", "--"];
        for path in paths {
            let change = status
                .changes
                .iter()
                .find(|c| c.path == *path)
                .ok_or("список изменений устарел; обновите Git и выберите файлы повторно")?;
            if !change.conflict
                && (change.worktree == 'D'
                    || (change.index == 'D'
                        && fs::symlink_metadata(repository.join(path))
                            .is_ok_and(|metadata| metadata.is_dir())))
            {
                removed.push(path);
            } else {
                args.push(path);
            }
            if let Some(original) = &change.original_path {
                if change.worktree == 'R' {
                    removed.push(original);
                }
            }
        }
        if removed.len() > 3 {
            workspaces::git(repository, &removed)?;
        }
        if args.len() > 3 {
            workspaces::git(repository, &args)?;
        }
        Ok(())
    })
}

pub fn commit(repository: &Path, message: &str) -> Result<String> {
    if message.trim().is_empty() {
        return Err("укажите сообщение коммита".into());
    }
    mutate(repository, || {
        workspaces::git(repository, &["commit", "-m", message])
    })
}

pub fn push(repository: &Path) -> Result<String> {
    mutate(repository, || push_command(repository, &[]))
}

fn push_command(repository: &Path, args: &[&str]) -> Result<String> {
    let output = workspaces::git_command(repository)?
        .args(["push", "--porcelain"])
        .args(args)
        .output()
        .map_err(|e| format!("не удалось запустить Git: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok(workspaces::git_output(output)? + &stderr)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub name: String,
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Version {
    fn new(name: &str, result: Result<Option<String>>) -> Self {
        let (text, error) = match result {
            Ok(text) => (text, None),
            Err(error) => (None, Some(error)),
        };
        Self {
            name: name.into(),
            text,
            error,
        }
    }
}

fn blob(repository: &Path, oid: Option<&str>) -> Result<Option<String>> {
    let Some(oid) = oid else { return Ok(None) };
    let text = workspaces::git(repository, &["cat-file", "blob", oid])?;
    editor::validate_text(&text)?;
    Ok(Some(text))
}

pub fn versions(repository: &Path, path: &str) -> Result<Vec<Version>> {
    editor::target(repository, path, false)?;
    let index = index_version(repository, path)?;
    let entries: Vec<Vec<&str>> = index
        .split('\0')
        .filter_map(|record| record.split_once('\t'))
        .map(|(metadata, _)| metadata.split_whitespace().collect())
        .collect();
    let mut versions = Vec::new();
    if entries
        .iter()
        .any(|fields| fields.get(2).is_some_and(|stage| *stage != "0"))
    {
        for (stage, name) in [
            ("2", "Наша версия"),
            ("3", "Входящая версия"),
            ("1", "Общий предок"),
        ] {
            let oid = entries
                .iter()
                .find(|f| f.get(2) == Some(&stage))
                .and_then(|f| f.get(1))
                .copied();
            versions.push(Version::new(name, blob(repository, oid)));
        }
    } else {
        let status = status(repository)?;
        let head_path = status
            .changes
            .iter()
            .find(|change| change.path == path && matches!(change.index, 'R' | 'C'))
            .and_then(|change| change.original_path.as_deref())
            .unwrap_or(path);
        let head = workspaces::git_command(repository)?
            .args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
            .output()
            .map_err(|e| format!("не удалось запустить Git: {e}"))?;
        let tree = if head.status.code() == Some(1) {
            String::new()
        } else {
            let commit = workspaces::git_output(head)?;
            workspaces::git(
                repository,
                &[
                    "--literal-pathspecs",
                    "ls-tree",
                    "-z",
                    commit.trim(),
                    "--",
                    head_path,
                ],
            )?
        };
        let oid = tree
            .split_once('\t')
            .and_then(|(metadata, _)| metadata.split_whitespace().nth(2));
        versions.push(Version::new("HEAD", blob(repository, oid)));
        versions.push(Version::new(
            "Индекс Git",
            blob(repository, entries.first().and_then(|f| f.get(1)).copied()),
        ));
    }
    versions.push(Version::new(
        "Файл на диске",
        editor::disk(repository, path),
    ));
    Ok(versions)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub patch: String,
    pub hunks: Vec<String>,
}

fn working_version(repository: &Path, path: &str) -> Result<String> {
    let path = editor::target(repository, path, false)?;
    match fs::read(&path) {
        Ok(bytes) => {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(&path)
                    .map_err(|e| e.to_string())?
                    .permissions()
                    .mode()
                    & 0o111
            };
            #[cfg(not(unix))]
            let mode = 0;
            Ok(format!("{mode}:{}", STANDARD.encode(bytes)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("deleted".into()),
        Err(e) => Err(format!("файл не прочитан: {e}")),
    }
}

fn index_version(repository: &Path, path: &str) -> Result<String> {
    workspaces::git(
        repository,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            path,
        ],
    )
}

fn index_path(repository: &Path) -> Result<PathBuf> {
    let path = workspaces::git(
        repository,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?;
    Ok(PathBuf::from(path.trim()))
}

fn index_state(repository: &Path) -> Result<String> {
    let path = index_path(repository)?;
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok("absent".into());
    }
    workspaces::git(
        repository,
        &[
            "hash-object",
            "--no-filters",
            "--",
            path.to_str().ok_or("путь не поддерживает UTF-8")?,
        ],
    )
}

pub fn diff(repository: &Path, path: &str) -> Result<Diff> {
    let worktree = working_version(repository, path)?;
    let index = index_state(repository)?;
    let entry = index_version(repository, path)?;
    if entry
        .split('\0')
        .filter(|s| !s.is_empty())
        .any(|s| !s.split('\t').next().is_some_and(|s| s.ends_with(" 0")))
    {
        return Err("сначала разрешите конфликт файла вручную".into());
    }
    let args = [
        "--no-optional-locks",
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--unified=3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    let patch = if entry.is_empty() {
        let output = workspaces::git_command(repository)?
            .args(args)
            .args(["--no-index", "--", "/dev/null", path])
            .output()
            .map_err(|e| format!("не удалось запустить Git: {e}"))?;
        if output.status.code() == Some(1) {
            String::from_utf8(output.stdout).map_err(|e| e.to_string())?
        } else {
            workspaces::git_output(output)?
        }
    } else {
        workspaces::git(repository, &[args.as_slice(), &["--", path]].concat())?
    };
    if working_version(repository, path)? != worktree || index_state(repository)? != index {
        return Err("файл или индекс изменился; обновите diff".into());
    }
    let mut hunks: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            hunks.push(String::new());
        }
        if let Some(hunk) = hunks.last_mut() {
            hunk.push_str(line);
        }
    }
    Ok(Diff {
        path: path.into(),
        index,
        worktree,
        patch,
        hunks,
    })
}

struct IndexLock {
    path: PathBuf,
    file: Option<fs::File>,
}

fn index_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("индекс не прочитан: {e}")),
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        if self.file.is_some() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn stage_hunk(repository: &Path, expected: &Diff, hunk: usize) -> Result<()> {
    mutate(repository, || {
        let index_path = index_path(repository)?;
        let index_path = index_path.as_path();
        let lock_path = index_path.with_file_name("index.lock");
        let mut lock = IndexLock {
            file: Some(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&lock_path)
                    .map_err(|e| format!("индекс занят или недоступен: {e}"))?,
            ),
            path: lock_path,
        };
        let original = index_bytes(index_path)?;
        let current = diff(repository, &expected.path)?;
        if &current != expected {
            return Err(
                "файл или индекс изменился; обновите diff и выберите фрагмент повторно".into(),
            );
        }
        let hunk = current
            .hunks
            .get(hunk)
            .ok_or("выбранный фрагмент отсутствует; обновите diff")?;
        let mut patch = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        for line in current
            .patch
            .split_inclusive('\n')
            .take_while(|line| !line.starts_with("@@ "))
        {
            if !line.starts_with("old mode ") && !line.starts_with("new mode ") {
                patch
                    .write_all(line.as_bytes())
                    .map_err(|e| e.to_string())?;
            }
        }
        patch
            .write_all(hunk.as_bytes())
            .map_err(|e| e.to_string())?;
        let directory = index_path.parent().ok_or("папка индекса отсутствует")?;
        let temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        if let Some(bytes) = &original {
            fs::write(temporary.path(), bytes).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(temporary.path()).map_err(|e| e.to_string())?;
        }
        let mut command = workspaces::git_command(repository)?;
        command.env("GIT_INDEX_FILE", temporary.path());
        if index_version(repository, &current.path)?.is_empty() {
            command.args(["--literal-pathspecs", "add", "--", &current.path]);
        } else {
            command
                .args(["apply", "--cached", "--whitespace=nowarn", "--"])
                .arg(patch.path());
        }
        let output = command
            .output()
            .map_err(|e| format!("не удалось запустить Git: {e}"))?;
        workspaces::git_output(output)?;
        if working_version(repository, &expected.path)? != expected.worktree
            || index_bytes(index_path)? != original
        {
            return Err("файл или индекс изменился во время подготовки; обновите diff".into());
        }
        let bytes = fs::read(temporary.path()).map_err(|e| e.to_string())?;
        let file = lock.file.as_mut().ok_or("блокировка индекса отсутствует")?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&lock.path, index_path).map_err(|e| format!("индекс не записан: {e}"))?;
        lock.file = None;
        Ok(())
    })
}

#[cfg(test)]
mod tests;
