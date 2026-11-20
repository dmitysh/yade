use super::*;
use std::io::{BufRead, BufReader};
use std::process::Stdio;

fn head(repository: &Path) -> Result<Option<String>> {
    let output = workspaces::git_command(repository)?
        .args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Ok(Some(workspaces::git_output(output)?.trim().into()))
}

fn revision(repository: &Path, value: &str) -> Result<String> {
    Ok(workspaces::git(
        repository,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{value}^{{commit}}"),
        ],
    )?
    .trim()
    .into())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub reference: String,
    pub kind: String,
    pub current: bool,
    pub upstream: String,
}

pub fn branches(repository: &Path) -> Result<Vec<Branch>> {
    let output = workspaces::git(
        repository,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let mut branches = output
        .lines()
        .filter(|line| line.ends_with('\0'))
        .map(|line| {
            let fields: Vec<_> = line.split('\0').collect();
            if fields.len() != 4 {
                return Err("некорректный список веток Git".into());
            }
            let (prefix, kind) = if fields[0].starts_with("refs/heads/") {
                ("refs/heads/", "local")
            } else if fields[0].starts_with("refs/remotes/") {
                ("refs/remotes/", "remote")
            } else {
                ("refs/tags/", "tag")
            };
            Ok(Branch {
                name: fields[0][prefix.len()..].into(),
                reference: fields[0].into(),
                kind: kind.into(),
                current: fields[1] == "*",
                upstream: fields[2].into(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let priority = |branch: &Branch| match branch.kind.as_str() {
        "local" if branch.name == "master" => 0,
        "local" => 1,
        "remote"
            if branch
                .name
                .split_once('/')
                .is_some_and(|(_, name)| name == "master") =>
        {
            2
        }
        "remote" => 3,
        _ => 4,
    };
    branches.sort_by(|a, b| {
        priority(a)
            .cmp(&priority(b))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(branches)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: String,
    pub refs: String,
    pub subject: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    pub reference: Option<String>,
    pub query: String,
    pub author: String,
    pub offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub commits: Vec<Commit>,
    pub has_more: bool,
}

pub fn history(repository: &Path, options: &LogOptions) -> Result<History> {
    if options.offset > 1_000_000 {
        return Err("слишком большое смещение истории".into());
    }
    if head(repository)?.is_none() && branches(repository)?.is_empty() {
        return Ok(History {
            commits: vec![],
            has_more: false,
        });
    }
    let mut command = workspaces::git_command(repository)?;
    command.args([
        "log",
        "--topo-order",
        "--date=iso-strict",
        "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00",
        "--no-show-signature",
    ]);
    if let Some(reference) = &options.reference {
        command.arg(revision(repository, reference)?);
    } else {
        command.args(["--branches", "--remotes", "--tags"]);
        if head(repository)?.is_some() {
            command.arg("HEAD");
        }
    }
    let query = options.query.trim().to_lowercase();
    let author = options.author.trim().to_lowercase();
    let filtered = !query.is_empty() || !author.is_empty();
    if !filtered {
        command.args([
            format!("--skip={}", options.offset),
            "--max-count=101".into(),
        ]);
    }
    let errors = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut child = command
        .arg("--")
        .stdout(Stdio::piped())
        .stderr(errors.reopen().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut reader = BufReader::new(child.stdout.take().ok_or("история Git недоступна")?);
        let mut commits = Vec::new();
        let mut skipped = 0;
        loop {
            let mut fields = Vec::new();
            for index in 0..7 {
                let mut bytes = Vec::new();
                reader
                    .read_until(0, &mut bytes)
                    .map_err(|e| e.to_string())?;
                if index == 0 && (bytes.is_empty() || bytes == b"\n") {
                    return Ok(History {
                        commits,
                        has_more: false,
                    });
                }
                if bytes.pop() != Some(0) {
                    return Err("некорректный ответ истории Git".into());
                }
                fields.push(String::from_utf8(bytes).map_err(|e| e.to_string())?);
            }
            let hash = fields[0].trim_start_matches('\n');
            if !format!("{} {} {} {}", hash, fields[2], fields[3], fields[6])
                .to_lowercase()
                .contains(&query)
                || !format!("{} <{}>", fields[2], fields[3])
                    .to_lowercase()
                    .contains(&author)
            {
                continue;
            }
            if filtered && skipped < options.offset {
                skipped += 1;
                continue;
            }
            if commits.len() == 100 {
                return Ok(History {
                    commits,
                    has_more: true,
                });
            }
            commits.push(Commit {
                hash: hash.into(),
                parents: fields[1].split_whitespace().map(String::from).collect(),
                author: fields[2].clone(),
                email: fields[3].clone(),
                time: fields[4].clone(),
                refs: fields[5].clone(),
                subject: fields[6].clone(),
            });
        }
    })();
    let stopped = result.as_ref().is_ok_and(|history| history.has_more) || result.is_err();
    if stopped {
        let _ = child.kill();
    }
    let exit = child.wait().map_err(|e| e.to_string())?;
    if !stopped && !exit.success() {
        return Err(format!(
            "Git: {}",
            fs::read_to_string(errors.path()).map_err(|e| e.to_string())?
        ));
    }
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub added: Option<usize>,
    pub deleted: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub message: String,
    pub files: Vec<CommitFile>,
}

pub fn commit_details(repository: &Path, reference: &str) -> Result<CommitDetails> {
    let hash = revision(repository, reference)?;
    let message = workspaces::git(
        repository,
        &[
            "show",
            "-s",
            "--format=%B",
            "--no-show-signature",
            &hash,
            "--",
        ],
    )?;
    let parents = workspaces::git(
        repository,
        &["rev-list", "--parents", "-n", "1", &hash, "--"],
    )?;
    let mut args = vec![
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--numstat",
        "--no-renames",
        "-r",
        "-z",
    ];
    if let Some(parent) = parents.split_whitespace().nth(1) {
        args.push(parent);
    }
    args.extend([&hash, "--"]);
    let output = workspaces::git(repository, &args)?;
    Ok(CommitDetails {
        hash,
        message,
        files: parse_files(&output)?,
    })
}

fn parse_files(output: &str) -> Result<Vec<CommitFile>> {
    output
        .split_terminator('\0')
        .map(|record| {
            let mut fields = record.splitn(3, '\t');
            let added = fields
                .next()
                .ok_or("отсутствует статистика файла")?
                .parse()
                .ok();
            let deleted = fields
                .next()
                .ok_or("отсутствует статистика файла")?
                .parse()
                .ok();
            let path = fields.next().ok_or("отсутствует путь файла")?.into();
            Ok(CommitFile {
                path,
                added,
                deleted,
            })
        })
        .collect()
}

pub fn compare_branches(repository: &Path, base: &str, reference: &str) -> Result<CommitDetails> {
    let base = revision(repository, base)?;
    let hash = revision(repository, reference)?;
    let output = workspaces::git(
        repository,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "--no-renames",
            "-z",
            &base,
            &hash,
            "--",
        ],
    )?;
    Ok(CommitDetails {
        hash,
        message: base,
        files: parse_files(&output)?,
    })
}

pub fn revision_versions(
    repository: &Path,
    reference: &str,
    path: &str,
    base: Option<&str>,
) -> Result<Vec<Version>> {
    let hash = revision(repository, reference)?;
    let details = commit_details(repository, &hash)?;
    if base.is_none() && !details.files.iter().any(|file| file.path == path) {
        return Err("файл отсутствует в изменениях коммита".into());
    }
    let previous = match base {
        Some(base) => Some(revision(repository, base)?),
        None => workspaces::git(
            repository,
            &["rev-list", "--parents", "-n", "1", &hash, "--"],
        )?
        .split_whitespace()
        .nth(1)
        .map(String::from),
    };
    let version = |name: &str, revision: Option<&str>| -> Version {
        Version::new(
            name,
            (|| {
                let Some(revision) = revision else {
                    return Ok(None);
                };
                let tree = workspaces::git(
                    repository,
                    &["--literal-pathspecs", "ls-tree", "-z", revision, "--", path],
                )?;
                let oid = tree
                    .split_once('\t')
                    .and_then(|(meta, _)| meta.split_whitespace().nth(2));
                blob(repository, oid)
            })(),
        )
    };
    Ok(vec![
        version(
            previous
                .as_deref()
                .map(|h| &h[..8])
                .unwrap_or("Пустой файл"),
            previous.as_deref(),
        ),
        version(&hash[..8], Some(&hash)),
    ])
}

fn selected_paths(repository: &Path, paths: &[String]) -> Result<Vec<String>> {
    if paths.is_empty() {
        return Err("выберите файлы".into());
    }
    let status = status(repository)?;
    let mut selected = Vec::new();
    for path in paths {
        let change = status
            .changes
            .iter()
            .find(|c| &c.path == path)
            .ok_or("список изменений устарел; обновите Git")?;
        if change.conflict {
            return Err("сначала разрешите конфликт".into());
        }
        selected.push(path.clone());
        if let Some(original) = &change.original_path {
            selected.push(original.clone());
        }
    }
    selected.sort();
    selected.dedup();
    Ok(selected)
}

pub fn unstage_files(repository: &Path, paths: &[String]) -> Result<()> {
    mutate(repository, || {
        let paths = selected_paths(repository, paths)?;
        let head = head(repository)?;
        let mut args = if let Some(head) = head.as_deref() {
            vec!["--literal-pathspecs", "reset", "-q", head, "--"]
        } else {
            vec!["--literal-pathspecs", "rm", "--cached", "-f", "--"]
        };
        args.extend(paths.iter().map(String::as_str));
        workspaces::git(repository, &args)?;
        Ok(())
    })
}

pub fn discard_file(repository: &Path, expected: &Diff) -> Result<()> {
    mutate(repository, || {
        if diff(repository, &expected.path)? != *expected {
            return Err("файл или индекс изменился; обновите сравнение".into());
        }
        if index_version(repository, &expected.path)?.is_empty() {
            let path = editor::target(repository, &expected.path, false)?;
            fs::remove_file(path).map_err(|e| e.to_string())?;
        } else {
            workspaces::git(
                repository,
                &[
                    "--literal-pathspecs",
                    "restore",
                    "--worktree",
                    "--",
                    &expected.path,
                ],
            )?;
        }
        Ok(())
    })
}

#[derive(Debug, Serialize)]
pub struct Stash {
    pub reference: String,
    pub hash: String,
    pub message: String,
}

pub fn stashes(repository: &Path) -> Result<Vec<Stash>> {
    let output = workspaces::git(repository, &["stash", "list", "--format=%gd%x00%H%x00%gs"])?;
    output
        .lines()
        .map(|line| {
            let mut fields = line.splitn(3, '\0');
            Ok(Stash {
                reference: fields.next().ok_or("отсутствует ссылка stash")?.into(),
                hash: fields.next().ok_or("отсутствует коммит stash")?.into(),
                message: fields.next().ok_or("отсутствует описание stash")?.into(),
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Amend { message: String, reference: String },
    Fetch,
    Pull,
    Push {
        remote: Option<String>,
        #[serde(default)]
        force: bool,
    },
    Switch { reference: String },
    CreateBranch {
        name: String,
        start: String,
        checkout: bool,
    },
    DeleteBranch { name: String },
    Merge { reference: String },
    CherryPick { reference: String },
    Revert { reference: String },
    CreateTag { name: String, reference: String },
    DeleteTag { name: String },
    StashSave { message: String },
    StashApply { reference: String, hash: String },
    StashDrop { reference: String, hash: String },
    Continue,
    Abort,
}

fn valid_name(repository: &Path, name: &str) -> Result<()> {
    if name.starts_with('-') || name.starts_with("@{") {
        return Err("некорректное имя ветки или тега".into());
    }
    workspaces::git(repository, &["check-ref-format", "--branch", name])?;
    Ok(())
}

pub fn action(repository: &Path, action: &Action) -> Result<String> {
    mutate(repository, || {
        let status = status(repository)?;
        match action {
            Action::Amend { message, reference } => {
                if message.trim().is_empty() {
                    return Err("укажите сообщение коммита".into());
                }
                if status.operation.is_some() {
                    return Err("сначала завершите текущую операцию Git".into());
                }
                if revision(repository, "HEAD")? != *reference {
                    return Err(
                        "последний коммит изменился; выберите дополнение коммита повторно".into(),
                    );
                }
                workspaces::git(repository, &["commit", "--amend", "-m", message])
            }
            Action::Fetch => workspaces::git(repository, &["fetch", "--all"]),
            Action::Pull => workspaces::git(repository, &["pull", "--ff-only"]),
            Action::Push { remote, force } => {
                let branch = workspaces::git(repository, &["symbolic-ref", "--quiet", "HEAD"])?;
                let tracking = workspaces::git(
                    repository,
                    &[
                        "for-each-ref",
                        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
                        branch.trim(),
                    ],
                )?;
                let (upstream_remote, upstream_ref) = tracking
                    .trim_end_matches('\n')
                    .split_once('\0')
                    .ok_or("некорректная отслеживаемая ветка")?;
                let remote = remote.as_deref().unwrap_or(upstream_remote);
                if !status.remotes.iter().any(|name| name == remote) {
                    return Err("выберите существующий удалённый репозиторий".into());
                }
                let destination = if upstream_remote == remote && !upstream_ref.is_empty() {
                    upstream_ref
                } else {
                    branch.trim()
                };
                let refspec = format!("{}:{destination}", branch.trim());
                push_command(
                    repository,
                    &[
                        "--set-upstream",
                        if *force {
                            "--force-with-lease"
                        } else {
                            "--no-force"
                        },
                        "--",
                        remote,
                        &refspec,
                    ],
                )
            }
            Action::Switch { reference } => {
                let branch = branches(repository)?
                    .into_iter()
                    .find(|b| &b.reference == reference)
                    .ok_or("ветка не найдена")?;
                match branch.kind.as_str() {
                    "local" => workspaces::git(repository, &["switch", "--", &branch.name]),
                    "remote" => {
                        workspaces::git(repository, &["switch", "--track", "--", &branch.name])
                    }
                    _ => workspaces::git(
                        repository,
                        &["switch", "--detach", &revision(repository, reference)?],
                    ),
                }
            }
            Action::CreateBranch {
                name,
                start,
                checkout,
            } => {
                valid_name(repository, name)?;
                if *checkout && start == "HEAD" && head(repository)?.is_none() {
                    return workspaces::git(repository, &["switch", "-c", name]);
                }
                if !checkout {
                    return workspaces::git(
                        repository,
                        &["branch", "--", name, &revision(repository, start)?],
                    );
                }
                workspaces::git(
                    repository,
                    &["switch", "-c", name, &revision(repository, start)?],
                )
            }
            Action::DeleteBranch { name } => {
                valid_name(repository, name)?;
                workspaces::git(repository, &["branch", "-d", "--", name])
            }
            Action::Merge { reference } => workspaces::git(
                repository,
                &["merge", "--no-edit", &revision(repository, reference)?],
            ),
            Action::CherryPick { reference } | Action::Revert { reference } => {
                if !status.changes.is_empty() {
                    return Err("сначала закоммитьте или сохраните изменения в stash".into());
                }
                let command = if matches!(action, Action::CherryPick { .. }) {
                    "cherry-pick"
                } else {
                    "revert"
                };
                workspaces::git(
                    repository,
                    &[command, "--no-edit", &revision(repository, reference)?],
                )
            }
            Action::CreateTag { name, reference } => {
                valid_name(repository, name)?;
                workspaces::git(
                    repository,
                    &["tag", "--", name, &revision(repository, reference)?],
                )
            }
            Action::DeleteTag { name } => {
                valid_name(repository, name)?;
                workspaces::git(repository, &["tag", "-d", "--", name])
            }
            Action::StashSave { message } => workspaces::git(
                repository,
                &["stash", "push", "--include-untracked", "-m", message],
            ),
            Action::StashApply { reference, hash } | Action::StashDrop { reference, hash } => {
                if !stashes(repository)?
                    .iter()
                    .any(|s| &s.reference == reference && &s.hash == hash)
                {
                    return Err("список stash изменился; обновите Git".into());
                }
                if matches!(action, Action::StashApply { .. }) {
                    workspaces::git(repository, &["stash", "apply", "--index", hash])
                } else {
                    workspaces::git(repository, &["stash", "drop", reference])
                }
            }
            Action::Continue | Action::Abort => {
                let operation = status.operation.ok_or("нет незавершённой операции Git")?;
                let command = match operation.as_str() {
                    "merge" => "merge",
                    "rebase" => "rebase",
                    "cherry_pick" => "cherry-pick",
                    "revert" => "revert",
                    _ => return Err("неизвестная операция Git".into()),
                };
                let mut git = workspaces::git_command(repository)?;
                git.env("GIT_EDITOR", "true")
                    .env("GIT_SEQUENCE_EDITOR", "true")
                    .args([
                        command,
                        if matches!(action, Action::Continue) {
                            "--continue"
                        } else {
                            "--abort"
                        },
                    ]);
                workspaces::git_output(git.output().map_err(|e| e.to_string())?)
            }
        }
    })
}
