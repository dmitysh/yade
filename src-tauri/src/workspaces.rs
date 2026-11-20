use crate::store::Result;
use crate::{
    core::Core,
    model::{DeletionCheck, NewWorktree, Snapshot, Workspace},
    store::Store,
};
use std::sync::Mutex;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn folder_path(path: &Path) -> Result<PathBuf> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("папка недоступна: {e}"))?;
    if !path.is_dir() {
        return Err("нужна папка проекта".into());
    }
    std::fs::read_dir(&path).map_err(|e| format!("папка недоступна: {e}"))?;
    Ok(path)
}

pub(crate) fn git_command(path: &Path) -> Result<Command> {
    let executable = crate::executors::executable("git")
        .ok_or("Git не найден. Установите Git и откройте приложение заново.")?;
    let mut command = Command::new(executable);
    command
        .env("PATH", crate::executors::search_path())
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .current_dir(path);
    Ok(command)
}

pub fn git(path: &Path, args: &[&str]) -> Result<String> {
    let output = git_command(path)?
        .args(args)
        .output()
        .map_err(|e| format!("не удалось запустить Git: {e}"))?;
    git_output(output)
}

pub(crate) fn git_output(output: std::process::Output) -> Result<String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(message) = stderr.trim().strip_prefix("fatal: '") {
            if let Some((branch, path)) = message
                .split_once("' is already used by worktree at '")
                .or_else(|| message.split_once("' is already checked out at '"))
                .and_then(|(branch, path)| path.strip_suffix('\'').map(|path| (branch, path)))
            {
                return Err(format!(
                    "Не удалось переключиться на ветку «{branch}»: она уже открыта в другой рабочей копии: {path}."
                ));
            }
        }
        return Err(format!(
            "Git: {}{}",
            String::from_utf8_lossy(&output.stdout),
            stderr
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("ответ Git не поддерживает UTF-8: {e}"))
}

pub fn git_ref(path: &Path) -> Result<String> {
    let branch = git(path, &["branch", "--show-current"])?;
    if !branch.trim().is_empty() {
        return Ok(branch.trim().into());
    }
    Ok(git(path, &["rev-parse", "--verify", "HEAD"])?.trim().into())
}

pub fn snapshot(core: &Mutex<Core>) -> Result<Snapshot> {
    let (mut snapshot, _running) = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        core.store.recognize_repositories()?;
        let mut snapshot = core.store.snapshot()?;
        snapshot.terminals = core
            .processes
            .terminals
            .values()
            .map(|terminal| terminal.info.clone())
            .collect();
        snapshot.terminals.sort_by(|a, b| a.id.cmp(&b.id));
        for terminal in &snapshot.terminals {
            if let Some(project) = snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.id == terminal.workspace_id)
                .and_then(|workspace| {
                    snapshot
                        .projects
                        .iter_mut()
                        .find(|project| Some(&project.id) == workspace.project_id.as_ref())
                })
            {
                project.last_activity_at = project.last_activity_at.max(terminal.last_activity_at);
            }
        }
        (snapshot, core.processes.track_git()?)
    };
    for workspace in &mut snapshot.workspaces {
        if workspace.deleted || workspace.archived || workspace.operation_state != "ready" {
            continue;
        }
        let path = Path::new(&workspace.path);
        workspace.git_ref = if path.join(".git").exists() {
            git_ref(path).ok()
        } else {
            None
        };
    }
    Ok(snapshot)
}

pub fn project_branches(core: &Mutex<Core>, project_id: &str) -> Result<Vec<String>> {
    let path = core
        .lock()
        .map_err(|e| e.to_string())?
        .store
        .snapshot()?
        .projects
        .into_iter()
        .find(|p| p.id == project_id && p.kind == "repository")
        .ok_or("выберите проект с Git-репозиторием")?
        .path;
    let output = git(
        Path::new(&path),
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname:short)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let (name, symbolic) = line.split_once('\0')?;
            symbolic.is_empty().then(|| name.to_string())
        })
        .collect())
}

pub fn create_worktree(core: &Mutex<Core>, request: &NewWorktree) -> Result<Workspace> {
    if request.name.trim().is_empty() || request.source_ref.trim().is_empty() {
        return Err("укажите название пространства и исходную ветку или коммит".into());
    }
    let project = core
        .lock()
        .map_err(|e| e.to_string())?
        .store
        .snapshot()?
        .projects
        .into_iter()
        .find(|p| p.id == request.project_id && p.kind == "repository")
        .ok_or("выберите проект с Git-репозиторием")?;
    let requested_path = if request.path.is_empty() {
        let home = std::env::var_os("HOME").ok_or("домашняя папка недоступна")?;
        let path = default_worktree_path(
            &PathBuf::from(home).join("yade/workspaces"),
            Path::new(&project.path),
            &request.name,
        )?;
        std::fs::create_dir_all(path.parent().ok_or("нужна родительская папка")?)
            .map_err(|e| format!("не удалось создать папку пространств: {e}"))?;
        path
    } else {
        PathBuf::from(&request.path)
    };
    if !requested_path.is_absolute() {
        return Err("укажите абсолютный путь нового worktree".into());
    }
    let path = folder_path(requested_path.parent().ok_or("нужна родительская папка")?)?.join(
        requested_path
            .file_name()
            .ok_or("нужно название новой папки")?,
    );
    match std::fs::symlink_metadata(&path) {
        Ok(_) => return Err("путь нового worktree уже существует".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("путь недоступен: {e}")),
    }
    let path = path.to_str().ok_or("путь не поддерживает UTF-8")?;
    let id = {
        let core = core.lock().map_err(|e| e.to_string())?;
        core.store.insert_worktree(request, path)?
    };
    let result = (|| {
        let repository = Path::new(&project.path);
        let commit = git(
            repository,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{}^{{commit}}", request.source_ref),
            ],
        )?;
        let reference = git(
            repository,
            &[
                "rev-parse",
                "--symbolic-full-name",
                "--verify",
                "--end-of-options",
                &request.source_ref,
            ],
        )?;
        let source_ref = if reference.trim().is_empty() {
            commit.trim()
        } else {
            reference.trim()
        };
        core.lock()
            .map_err(|e| e.to_string())?
            .store
            .connection
            .execute(
                "UPDATE workspaces SET source_ref=?2,source_commit=?3 WHERE id=?1",
                rusqlite::params![id, source_ref, commit.trim()],
            )
            .map_err(|e| e.to_string())?;
        let branch = request.branch.as_deref().unwrap_or(request.name.trim());
        if branch.starts_with('-') || branch.is_empty() {
            return Err("недопустимое имя новой ветки".into());
        }
        git(repository, &["check-ref-format", "--branch", branch])?;
        git(
            repository,
            &["worktree", "add", "-b", branch, "--", path, commit.trim()],
        )?;
        git_ref(Path::new(path))
    })()
    .map_err(|e| {
        format!(
            "{e}; путь: {path}; папка {}",
            if Path::new(path).exists() {
                "существует"
            } else {
                "не создана"
            }
        )
    });
    let core = core.lock().map_err(|e| e.to_string())?;
    core.store.finish_worktree_creation(&id, &result)?;
    result?;
    core.store.workspace(&id)
}

pub(crate) fn default_worktree_path(root: &Path, project: &Path, name: &str) -> Result<PathBuf> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
    {
        return Err("название пространства не должно содержать путь".into());
    }
    Ok(root
        .join(project.file_name().ok_or("нужно название папки проекта")?)
        .join(name))
}

fn repository_path(store: &Store, workspace: &Workspace) -> Result<PathBuf> {
    let project = store
        .snapshot()?
        .projects
        .into_iter()
        .find(|p| Some(&p.id) == workspace.project_id.as_ref())
        .ok_or("проект пространства отсутствует")?;
    folder_path(Path::new(&project.path))
}

fn worktree_record(repository: &Path, path: &str) -> Result<Option<(Option<String>, String)>> {
    let records = git(repository, &["worktree", "list", "--porcelain", "-z"])?;
    for record in records.split("\0\0") {
        let fields: Vec<_> = record.split('\0').collect();
        if fields.first().and_then(|f| f.strip_prefix("worktree ")) == Some(path) {
            let branch = fields
                .iter()
                .find_map(|f| f.strip_prefix("branch refs/heads/"))
                .map(str::to_string);
            let head = fields
                .iter()
                .find_map(|f| f.strip_prefix("HEAD "))
                .ok_or("не удалось определить коммит worktree")?;
            return Ok(Some((branch, head.into())));
        }
    }
    Ok(None)
}

fn ensure_deletion_idle(core: &Core, workspace_id: &str) -> Result<()> {
    core.ensure_workspace_idle(workspace_id)?;
    let workspace = core.store.workspace(workspace_id)?;
    let target = Path::new(&workspace.path);
    if workspace.kind == "worktree" {
        for other in core
            .store
            .snapshot()?
            .workspaces
            .iter()
            .filter(|w| w.id != workspace.id && !w.deleted)
        {
            let path = Path::new(&other.path);
            if path.starts_with(target) || target.starts_with(path) {
                core.ensure_workspace_idle(&other.id)?;
            }
        }
    }
    Ok(())
}

pub fn inspect_deletion(core: &Mutex<Core>, workspace_id: &str) -> Result<DeletionCheck> {
    let (workspace, repository, drafts) = {
        let core = core.lock().map_err(|e| e.to_string())?;
        ensure_deletion_idle(&core, workspace_id)?;
        let workspace = core.store.workspace(workspace_id)?;
        let repository = if workspace.kind == "worktree" {
            Some(repository_path(&core.store, &workspace)?)
        } else {
            None
        };
        let drafts = core
            .store
            .drafts(workspace_id)?
            .into_iter()
            .filter(|d| d.path.is_some() || !d.body.is_empty())
            .collect();
        (workspace, repository, drafts)
    };
    let target = Path::new(&workspace.path);
    let mut check = DeletionCheck {
        workspace_id: workspace.id.clone(),
        path: workspace.path.clone(),
        kind: workspace.kind.clone(),
        path_exists: target
            .try_exists()
            .map_err(|e| format!("путь недоступен: {e}"))?,
        registered: false,
        branch: None,
        head: None,
        drafts,
        changes: String::new(),
        unmerged: String::new(),
    };
    let Some(repository) = repository else {
        return Ok(check);
    };
    let record = worktree_record(&repository, &workspace.path)?;
    let Some((branch, head)) = record else {
        return Ok(check);
    };
    check.registered = true;
    check.branch = branch;
    check.head = Some(head.clone());
    if check.path_exists {
        if folder_path(target)? != target {
            return Err("путь пространства перенаправлен; удаление запрещено".into());
        }
        let expected = git(
            &repository,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        let actual = git(
            target,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        if Path::new(expected.trim())
            .canonicalize()
            .map_err(|e| e.to_string())?
            != Path::new(actual.trim())
                .canonicalize()
                .map_err(|e| e.to_string())?
        {
            return Err(
                "путь пространства принадлежит другому репозиторию; удаление запрещено".into(),
            );
        }
        let root = git(target, &["rev-parse", "--show-toplevel"])?;
        if folder_path(Path::new(root.trim()))? != folder_path(target)? {
            return Err("путь пространства больше не является корнем worktree".into());
        }
        if git(target, &["rev-parse", "--verify", "HEAD"])?.trim() != head
            || git(target, &["branch", "--show-current"])?.trim()
                != check.branch.as_deref().unwrap_or("")
        {
            return Err(
                "регистрация worktree не соответствует его ветке или коммиту; удаление запрещено"
                    .into(),
            );
        }
        check.changes = git(
            target,
            &[
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignored=matching",
            ],
        )?;
    }
    let source = workspace
        .source_ref
        .as_deref()
        .ok_or("исходная точка пространства отсутствует")?;
    let source = git(
        &repository,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{source}^{{commit}}"),
        ],
    )
    .or_else(|error| workspace.source_commit.clone().ok_or(error))?;
    check.unmerged = git(
        &repository,
        &[
            "log",
            "--format=%h %s",
            &format!("{}..{head}", source.trim()),
            "--",
        ],
    )?;
    Ok(check)
}

pub fn delete_workspace(
    core: &Mutex<Core>,
    expected: &DeletionCheck,
    confirmed: bool,
    discard_work: bool,
) -> Result<()> {
    if !confirmed {
        return Err("удаление отменено".into());
    }
    let check = inspect_deletion(core, &expected.workspace_id)?;
    if &check != expected {
        return Err("состояние пространства изменилось; проверьте удаление повторно".into());
    }
    if check.kind == "worktree" && check.has_work() && !discard_work {
        return Err("обнаружена незавершённая работа; требуется явное подтверждение".into());
    }
    let repository = {
        let core = core.lock().map_err(|e| e.to_string())?;
        ensure_deletion_idle(&core, &expected.workspace_id)?;
        let drafts: Vec<_> = core
            .store
            .drafts(&expected.workspace_id)?
            .into_iter()
            .filter(|d| d.path.is_some() || !d.body.is_empty())
            .collect();
        if drafts != expected.drafts {
            return Err("черновики изменились; проверьте удаление повторно".into());
        }
        let workspace = core.store.workspace(&expected.workspace_id)?;
        let repository = if workspace.kind == "worktree" {
            Some(repository_path(&core.store, &workspace)?)
        } else {
            None
        };
        if workspace.kind == "worktree" {
            core.store
                .connection
                .execute(
                    "UPDATE workspaces SET git_ref=?2 WHERE id=?1",
                    rusqlite::params![workspace.id, check.branch.as_ref().or(check.head.as_ref())],
                )
                .map_err(|e| e.to_string())?;
        }
        core.store
            .workspace_operation(&workspace.id, "deleting", None)?;
        repository
    };
    let result = if expected.registered {
        let mut args = vec!["worktree", "remove"];
        if discard_work || !expected.path_exists {
            args.push("--force");
        }
        args.extend(["--", &expected.path]);
        git(
            repository
                .as_deref()
                .ok_or("репозиторий пространства отсутствует")?,
            &args,
        )
        .map(|_| ())
    } else {
        Ok(())
    };
    let mut core = core.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(()) => {
            if let Err(error) = core.store.finish_workspace_deletion(&expected.workspace_id) {
                let message = format!(
                    "операция Git выполнена, но результат не сохранён: {error}; путь: {}",
                    expected.path
                );
                let _ =
                    core.store
                        .workspace_operation(&expected.workspace_id, "error", Some(&message));
                return Err(message);
            }
            Ok(())
        }
        Err(error) => {
            let exists = Path::new(&expected.path).exists();
            let registered = repository
                .as_deref()
                .map(|r| worktree_record(r, &expected.path).map(|w| w.is_some()))
                .unwrap_or(Ok(false));
            let message = format!(
                "{error}; папка {}: {}; регистрация worktree: {}",
                expected.path,
                if exists {
                    "существует"
                } else {
                    "отсутствует"
                },
                match registered {
                    Ok(true) => "сохранена".into(),
                    Ok(false) => "отсутствует".into(),
                    Err(e) => e,
                }
            );
            core.store
                .workspace_operation(&expected.workspace_id, "error", Some(&message))?;
            Err(message)
        }
    }
}

pub fn delete_workspace_branch(
    core: &Mutex<Core>,
    workspace_id: &str,
    branch: &str,
    head: &str,
    confirmed: bool,
) -> Result<()> {
    if !confirmed {
        return Err("удаление ветки не подтверждено".into());
    }
    if branch.is_empty() || branch.starts_with('-') {
        return Err("недопустимое имя ветки".into());
    }
    let repository = {
        let core = core.lock().map_err(|e| e.to_string())?;
        let workspace = core
            .store
            .snapshot()?
            .workspaces
            .into_iter()
            .find(|w| w.id == workspace_id && w.deleted && w.kind == "worktree")
            .ok_or("сначала удалите worktree")?;
        if workspace.git_ref.as_deref() != Some(branch) {
            return Err("ветка не принадлежит удалённому пространству".into());
        }
        repository_path(&core.store, &workspace)?
    };
    let current = git(
        &repository,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("refs/heads/{branch}"),
        ],
    )?;
    if current.trim() != head {
        return Err("ветка изменилась; удаление отменено".into());
    }
    git(&repository, &["branch", "-D", "--", branch])?;
    Ok(())
}
