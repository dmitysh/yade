use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::Path;

pub type Result<T> = std::result::Result<T, String>;

pub struct Store {
    pub(crate) connection: Connection,
}

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial.sql"),
    include_str!("../migrations/002_workspaces.sql"),
    include_str!("../migrations/003_preparation.sql"),
    include_str!("../migrations/004_source_commit.sql"),
    include_str!("../migrations/005_process_identity.sql"),
    include_str!("../migrations/006_language_files.sql"),
    include_str!("../migrations/007_project_activity.sql"),
    include_str!("../migrations/008_session_activity.sql"),
];

pub fn migrate(connection: &mut Connection, migrations: &[&str]) -> Result<()> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let version: u32 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version as usize > migrations.len() {
        return Err("база создана более новой версией приложения".into());
    }
    for (index, sql) in migrations.iter().enumerate().skip(version as usize) {
        tx.execute_batch(sql)
            .map_err(|e| format!("ошибка миграции {}: {e}", index + 1))?;
        tx.pragma_update(None, "user_version", (index + 1) as u32)
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|e| e.to_string())?;
        upgrade(&mut connection, path, MIGRATIONS)?;
        let mut store = Self { connection };
        store.recognize_repositories()?;
        Ok(store)
    }

    pub(crate) fn recognize_repositories(&mut self) -> Result<()> {
        let mut repositories = Vec::new();
        for project in self
            .snapshot()?
            .projects
            .into_iter()
            .filter(|p| p.kind == "folder")
        {
            let path = Path::new(&project.path);
            if path.join(".git").exists() {
                if let Ok(reference) = crate::workspaces::git_ref(path) {
                    repositories.push((project.id, reference));
                }
            }
        }
        if repositories.is_empty() {
            return Ok(());
        }
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        for (project, reference) in repositories {
            tx.execute(
                "UPDATE projects SET kind='repository' WHERE id=?1",
                [&project],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("UPDATE workspaces SET git_ref=?2 WHERE project_id=?1 AND kind='folder' AND git_ref IS NULL", params![project,reference]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn validate_context(&self, context: &Context) -> Result<()> {
        let exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id
             JOIN workspaces w ON w.id=s.workspace_id
             WHERE r.id=?1 AND s.id=?2 AND w.id=?3 AND w.deleted=0 AND w.operation_state='ready')",
                params![context.run_id, context.session_id, context.workspace_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(
                "неизвестный контекст или запуск принадлежит другой сессии или пространству".into(),
            );
        }
        Ok(())
    }

    pub fn record_event(
        &mut self,
        context: &Context,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<StoredEvent> {
        self.validate_context(context)?;
        self.connection
            .execute(
                "INSERT INTO events(run_id,kind,payload) VALUES(?1,?2,?3)",
                params![context.run_id, kind, payload.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(StoredEvent {
            sequence: self.connection.last_insert_rowid(),
            context: context.clone(),
            kind: kind.into(),
            payload,
        })
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let groups = self
            .connection
            .prepare("SELECT id,name,path FROM project_groups ORDER BY rowid")
            .and_then(|mut q| {
                q.query_map([], |r| {
                    Ok(Group {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|e| e.to_string())?;
        let projects = self
            .connection
            .prepare("SELECT id,group_id,name,path,kind,preparation_command,last_activity_at FROM projects ORDER BY rowid")
            .and_then(|mut q| {
                q.query_map([], |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        group_id: r.get(1)?,
                        name: r.get(2)?,
                        path: r.get(3)?,
                        kind: r.get(4)?,
                        preparation_command: r.get(5)?,
                        last_activity_at: r.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|e| e.to_string())?;
        let workspaces = self.connection.prepare("SELECT id,project_id,group_id,name,path,kind,source_ref,git_ref,archived,deleted,operation_state,operation_error,preparation_command,preparation_state,preparation_output,source_commit FROM workspaces ORDER BY rowid")
            .and_then(|mut q| q.query_map([], |r| Ok(Workspace { id:r.get(0)?,project_id:r.get(1)?,group_id:r.get(2)?,name:r.get(3)?,path:r.get(4)?,kind:r.get(5)?,source_ref:r.get(6)?,git_ref:r.get(7)?,archived:r.get(8)?,deleted:r.get(9)?,operation_state:r.get(10)?,operation_error:r.get(11)?,preparation_command:r.get(12)?,preparation_state:r.get(13)?,preparation_output:r.get(14)?,source_commit:r.get(15)? }))?.collect::<rusqlite::Result<Vec<_>>>()).map_err(|e|e.to_string())?;
        let sessions = self.connection.prepare("SELECT id,workspace_id,executor,external_id,title,state,last_activity_at FROM sessions ORDER BY rowid")
            .and_then(|mut q| q.query_map([], |r| Ok(Session { id:r.get(0)?,workspace_id:r.get(1)?,executor:r.get(2)?,external_id:r.get(3)?,title:r.get(4)?,state:r.get(5)?,last_activity_at:r.get(6)? }))?.collect::<rusqlite::Result<Vec<_>>>()).map_err(|e|e.to_string())?;
        let view = self
            .connection
            .query_row("SELECT value FROM view_state WHERE id=1", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| format!("ошибка чтения расположения: {e}"))?
            .unwrap_or(View {
                sidebar_width: 260,
                ..View::default()
            });
        Ok(Snapshot {
            screen_reader_enabled: true,
            groups,
            projects,
            workspaces,
            sessions,
            terminals: Vec::new(),
            view,
        })
    }

    pub fn save_view(&self, view: &View) -> Result<()> {
        let snapshot = self.snapshot()?;
        if let Some(id) = &view.project_id {
            if !snapshot.projects.iter().any(|p| &p.id == id) {
                return Err("неизвестный проект".into());
            }
        }
        if let Some(id) = &view.workspace_id {
            let w = snapshot
                .workspaces
                .iter()
                .find(|w| &w.id == id && !w.deleted && !w.archived)
                .ok_or("неизвестное пространство")?;
            if w.project_id != view.project_id {
                return Err("пространство принадлежит другому проекту".into());
            }
        }
        let mut ids = std::collections::HashSet::new();
        for tab in &view.tabs {
            if !ids.insert(&tab.id) {
                return Err("повторяющаяся вкладка".into());
            }
            if !snapshot
                .workspaces
                .iter()
                .any(|w| w.id == tab.workspace_id && !w.deleted)
            {
                return Err("неизвестное пространство вкладки".into());
            }
            if let Some(id) = &tab.session_id {
                if !snapshot
                    .sessions
                    .iter()
                    .any(|s| &s.id == id && s.workspace_id == tab.workspace_id)
                {
                    return Err("сессия вкладки принадлежит другому пространству".into());
                }
            }
        }
        for (workspace, tab) in &view.active_tabs {
            if !view
                .tabs
                .iter()
                .any(|t| &t.id == tab && &t.workspace_id == workspace)
            {
                return Err("неизвестная активная вкладка".into());
            }
        }
        if !(180..=420).contains(&view.sidebar_width) {
            return Err("недопустимая ширина панели".into());
        }
        let json = serde_json::to_string(view).map_err(|e| e.to_string())?;
        self.connection.execute("INSERT INTO view_state(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [json]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn register_folder(
        &mut self,
        name: &str,
        path: &Path,
        group_id: Option<&str>,
    ) -> Result<()> {
        if name.trim().is_empty() {
            return Err("укажите название проекта".into());
        }
        let path = crate::workspaces::folder_path(path)?;
        let (kind, git_ref) = if path.join(".git").try_exists().map_err(|e| e.to_string())? {
            crate::workspaces::git(&path, &["rev-parse", "--show-toplevel"])?;
            ("repository", Some(crate::workspaces::git_ref(&path)?))
        } else {
            ("folder", None)
        };
        let path = path.to_str().ok_or("путь не поддерживает UTF-8")?;
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        let reopened = tx.execute(
            "UPDATE workspaces SET deleted=0,archived=0,operation_state='ready',operation_error=NULL,git_ref=?2 WHERE project_id=(SELECT id FROM projects WHERE path=?1) AND path=?1 AND kind='folder' AND deleted=1",
            params![path, git_ref],
        ).map_err(|e| e.to_string())?;
        if reopened > 0 {
            tx.execute(
                "UPDATE projects SET kind=?2 WHERE path=?1",
                params![path, kind],
            )
            .map_err(|e| e.to_string())?;
            return tx.commit().map_err(|e| e.to_string());
        }
        let project = uuid::Uuid::new_v4().to_string();
        let workspace = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO projects(id,group_id,name,path,kind) VALUES(?1,?2,?3,?4,?5)",
            params![project, group_id, name.trim(), path, kind],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO workspaces(id,project_id,name,path,kind,git_ref) VALUES(?1,?2,?3,?4,'folder',?5)",
            params![workspace, project, "Основное", path, git_ref],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn workspace(&self, id: &str) -> Result<Workspace> {
        self.snapshot()?
            .workspaces
            .into_iter()
            .find(|w| w.id == id && !w.deleted)
            .ok_or("пространство отсутствует".into())
    }

    pub fn set_archived(&mut self, workspace_id: &str, archived: bool) -> Result<()> {
        self.workspace(workspace_id)?;
        let mut view = self.snapshot()?.view;
        if archived && view.workspace_id.as_deref() == Some(workspace_id) {
            view.workspace_id = None;
        }
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE workspaces SET archived=?2 WHERE id=?1",
            params![workspace_id, archived],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO view_state(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [serde_json::to_string(&view).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn finish_workspace_deletion(&mut self, workspace_id: &str) -> Result<()> {
        let mut view = self.snapshot()?.view;
        if view.workspace_id.as_deref() == Some(workspace_id) {
            view.workspace_id = None;
        }
        view.tabs.retain(|t| t.workspace_id != workspace_id);
        view.active_tabs.remove(workspace_id);
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE workspaces SET deleted=1,operation_state='deleted',operation_error=NULL WHERE id=?1", [workspace_id]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO view_state(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [serde_json::to_string(&view).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn workspace_operation(
        &self,
        workspace_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.connection
            .execute(
                "UPDATE workspaces SET operation_state=?2,operation_error=?3 WHERE id=?1",
                params![workspace_id, state, error],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn insert_worktree(&self, request: &NewWorktree, path: &str) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO workspaces(id,project_id,name,path,kind,source_ref,operation_state,preparation_command,preparation_state) SELECT ?1,id,?3,?4,'worktree',?5,'creating',preparation_command,CASE WHEN preparation_command IS NULL THEN 'skipped' ELSE 'pending' END FROM projects WHERE id=?2",
            params![id,request.project_id,request.name.trim(),path,request.source_ref]
        ).map_err(|e| {
            if matches!(&e, rusqlite::Error::SqliteFailure(error, _) if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE) {
                "Это расположение уже используется рабочим пространством. Укажите другое название пространства.".into()
            } else {
                e.to_string()
            }
        })?;
        Ok(id)
    }

    pub fn finish_worktree_creation(&self, id: &str, result: &Result<String>) -> Result<()> {
        let (state, git_ref, error) = match result {
            Ok(reference) => ("ready", Some(reference), None),
            Err(error) => ("error", None, Some(error)),
        };
        self.connection.execute(
            "UPDATE workspaces SET operation_state=?2,git_ref=?3,operation_error=?4,preparation_state=CASE WHEN ?2='ready' THEN preparation_state ELSE 'skipped' END WHERE id=?1",
            params![id,state,git_ref,error]
        ).map_err(|e| format!("не удалось сохранить результат создания: {e}"))?;
        Ok(())
    }

    pub fn set_preparation_command(&self, project_id: &str, command: &str) -> Result<()> {
        let command = (!command.trim().is_empty()).then_some(command);
        let changed = self
            .connection
            .execute(
                "UPDATE projects SET preparation_command=?2 WHERE id=?1 AND kind='repository'",
                params![project_id, command],
            )
            .map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("выберите проект с Git-репозиторием".into());
        }
        Ok(())
    }

    pub fn preparation_output(&self, workspace_id: &str, text: &str, state: &str) -> Result<()> {
        let mut output = self.workspace(workspace_id)?.preparation_output;
        output.push_str(text);
        if output.len() > 65536 {
            let mut start = output.len() - 65536;
            while !output.is_char_boundary(start) {
                start += 1;
            }
            output.drain(..start);
        }
        self.connection
            .execute(
                "UPDATE workspaces SET preparation_state=?2,preparation_output=?3 WHERE id=?1",
                params![workspace_id, state, output],
            )
            .map_err(|e| format!("вывод подготовки не сохранён: {e}"))?;
        Ok(())
    }

    pub fn create_group(&self, name: &str, path: Option<&Path>) -> Result<()> {
        if name.trim().is_empty() {
            return Err("укажите название группы".into());
        }
        let path = path.map(crate::workspaces::folder_path).transpose()?;
        let path = path
            .as_ref()
            .map(|p| p.to_str().ok_or("путь не поддерживает UTF-8"))
            .transpose()?;
        self.connection
            .execute(
                "INSERT INTO project_groups(id,name,path) VALUES(?1,?2,?3)",
                params![uuid::Uuid::new_v4().to_string(), name.trim(), path],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn open_group_folder(&self, group_id: &str) -> Result<Workspace> {
        let snapshot = self.snapshot()?;
        let group = snapshot
            .groups
            .iter()
            .find(|g| g.id == group_id)
            .ok_or("группа отсутствует")?;
        let path = crate::workspaces::folder_path(Path::new(
            group
                .path
                .as_deref()
                .ok_or("у группы не задана общая папка")?,
        ))?;
        let path = path.to_str().ok_or("путь не поддерживает UTF-8")?;
        if let Some(workspace) = snapshot
            .workspaces
            .into_iter()
            .find(|w| w.group_id.as_deref() == Some(group_id) && w.path == path && !w.deleted)
        {
            return Ok(workspace);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.connection
            .execute(
                "INSERT INTO workspaces(id,group_id,name,path,kind) VALUES(?1,?2,?3,?4,'folder')",
                params![id, group_id, group.name, path],
            )
            .map_err(|e| e.to_string())?;
        self.workspace(&id)
    }

    pub fn insert_session(&self, session: &Session) -> Result<()> {
        self.connection.execute("INSERT INTO sessions(id,workspace_id,executor,external_id,title,state) VALUES(?1,?2,?3,?4,?5,?6)",params![session.id,session.workspace_id,session.executor,session.external_id,session.title,session.state]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn insert_run(&self, run: &Run) -> Result<()> {
        self.connection
            .execute(
                "INSERT INTO runs(id,session_id,state) VALUES(?1,?2,?3)",
                params![run.id, run.session_id, run.state],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn runs(&self, session_id: &str) -> Result<Vec<Run>> {
        self.connection
            .prepare("SELECT id,session_id,state FROM runs WHERE session_id=?1 ORDER BY rowid")
            .and_then(|mut q| {
                q.query_map([session_id], |r| {
                    Ok(Run {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        state: r.get(2)?,
                    })
                })?
                .collect()
            })
            .map_err(|e| e.to_string())
    }

    pub fn append_message(&self, context: &Context, role: &str, body: &str) -> Result<i64> {
        self.validate_context(context)?;
        self.connection
            .execute(
                "INSERT INTO messages(session_id,run_id,role,body) VALUES(?1,?2,?3,?4)",
                params![context.session_id, context.run_id, role, body],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn messages(&self, session_id: &str, after: i64) -> Result<Vec<Message>> {
        self.connection.prepare("SELECT sequence,session_id,run_id,role,body FROM messages WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 100").and_then(|mut q|q.query_map(params![session_id,after],|r|Ok(Message {sequence:r.get(0)?,session_id:r.get(1)?,run_id:r.get(2)?,role:r.get(3)?,body:r.get(4)?}))?.collect()).map_err(|e|e.to_string())
    }

    pub fn events(&self, session_id: &str, after: i64) -> Result<Vec<StoredEvent>> {
        self.connection.prepare("SELECT e.sequence,s.workspace_id,r.session_id,e.run_id,e.kind,e.payload FROM events e JOIN runs r ON r.id=e.run_id JOIN sessions s ON s.id=r.session_id WHERE s.id=?1 AND e.sequence>?2 ORDER BY e.sequence LIMIT 100")
            .and_then(|mut q| q.query_map(params![session_id,after], |r| {
                let payload: String = r.get(5)?;
                Ok((r.get(0)?, Context {workspace_id:r.get(1)?,session_id:r.get(2)?,run_id:r.get(3)?}, r.get(4)?, payload))
            })?.collect::<rusqlite::Result<Vec<_>>>()).map_err(|e| e.to_string())?
            .into_iter().map(|(sequence, context, kind, payload)| Ok(StoredEvent {sequence,context,kind,payload:serde_json::from_str(&payload).map_err(|e| e.to_string())?})).collect()
    }

    pub fn save_draft(&self, draft: &Draft) -> Result<()> {
        if let Some(id) = &draft.session_id {
            let valid: bool = self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND workspace_id=?2)",
                    params![id, draft.workspace_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !valid {
                return Err("черновик принадлежит другой сессии или пространству".into());
            }
        }
        self.connection.execute("INSERT INTO drafts(id,workspace_id,session_id,path,body,base_version) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET body=excluded.body,base_version=excluded.base_version WHERE drafts.workspace_id=excluded.workspace_id AND drafts.session_id IS excluded.session_id AND drafts.path IS excluded.path",params![draft.id,draft.workspace_id,draft.session_id,draft.path,draft.body,draft.base_version]).map_err(|e|e.to_string()).and_then(|n|if n==1 {Ok(())} else {Err("контекст черновика изменился".into())})
    }

    pub fn drafts(&self, workspace_id: &str) -> Result<Vec<Draft>> {
        self.connection.prepare("SELECT id,workspace_id,session_id,path,body,base_version FROM drafts WHERE workspace_id=?1 ORDER BY rowid").and_then(|mut q|q.query_map([workspace_id],|r|Ok(Draft {id:r.get(0)?,workspace_id:r.get(1)?,session_id:r.get(2)?,path:r.get(3)?,body:r.get(4)?,base_version:r.get(5)?}))?.collect()).map_err(|e|e.to_string())
    }

    pub fn save_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.connection.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        self.connection
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
    }
}

fn upgrade(connection: &mut Connection, path: &Path, migrations: &[&str]) -> Result<()> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > 0 && (version as usize) < migrations.len() {
        let directory = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let temporary = tempfile::NamedTempFile::new_in(directory)
            .map_err(|e| format!("не удалось подготовить резервную копию базы: {e}"))?;
        connection
            .backup(
                rusqlite::MAIN_DB,
                temporary.path(),
                rusqlite::backup::NO_PROGRESS,
            )
            .map_err(|e| format!("не удалось сохранить резервную копию базы: {e}"))?;
        let filename = path
            .file_name()
            .ok_or("неизвестное имя базы")?
            .to_string_lossy();
        let backup = directory.join(format!(
            "{filename}.before-v{version}-{}.bak",
            uuid::Uuid::new_v4()
        ));
        temporary
            .persist_noclobber(&backup)
            .map_err(|e| format!("не удалось сохранить резервную копию базы: {e}"))?;
        return migrate(connection, migrations).map_err(|e| {
            format!(
                "{e}; исходная база сохранена, резервная копия: {}",
                backup.display()
            )
        });
    }
    migrate(connection, migrations)
}

#[cfg(test)]
mod delivery_tests {
    use super::*;

    #[test]
    fn project_and_session_activity_migrations_restore_the_latest_known_history() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&mut connection, &MIGRATIONS[..6]).unwrap();
        connection.execute_batch("
            INSERT INTO projects(id,name,path,kind) VALUES('p1','Первый','/first','folder'),('p2','Второй','/second','folder'),('p3','Без истории','/third','folder');
            INSERT INTO workspaces(id,project_id,name,path,kind) VALUES('w1','p1','Первое','/first','folder'),('w2','p2','Второе','/second','folder');
            INSERT INTO sessions(id,workspace_id,executor,title,state) VALUES('s1','w1','codex','Разговор','completed'),('s2','w2','claude','Разговор','completed'),('s3','w1','codex','Без истории','ready');
            INSERT INTO runs(id,session_id,state) VALUES('r1','s1','completed'),('r2','s2','completed');
            INSERT INTO messages(session_id,run_id,role,body,created_at) VALUES('s1','r1','user','Раннее','2026-11-01 10:00:00'),('s2','r2','user','Позднее','2026-11-03 10:00:00');
            INSERT INTO events(run_id,kind,payload,created_at) VALUES('r1','progress','{}','2026-11-02 10:00:00'),('r2','progress','{}','2026-11-02 10:00:00');
        ").unwrap();
        migrate(&mut connection, MIGRATIONS).unwrap();
        let store = Store { connection };
        let projects = store.snapshot().unwrap().projects;
        let expected = |time: &str| {
            store.connection
                .query_row("SELECT unixepoch(?1) * 1000", [time], |row| row.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(projects[0].last_activity_at, expected("2026-11-02 10:00:00"));
        assert_eq!(projects[1].last_activity_at, expected("2026-11-03 10:00:00"));
        assert_eq!(projects[2].last_activity_at, 0);
        let sessions = store.snapshot().unwrap().sessions;
        assert_eq!(sessions[0].last_activity_at, expected("2026-11-02 10:00:00"));
        assert_eq!(sessions[1].last_activity_at, expected("2026-11-03 10:00:00"));
        assert_eq!(sessions[2].last_activity_at, 0);
    }

    #[test]
    fn manual_update_and_compatible_backup_preserve_the_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.sqlite3");
        let mut store = Store::open(&path).unwrap();
        store.create_group("Группа", Some(temp.path())).unwrap();
        let group = store.snapshot().unwrap().groups[0].id.clone();
        store
            .register_folder("Проект", temp.path(), Some(&group))
            .unwrap();
        let workspace = store.snapshot().unwrap().workspaces[0].id.clone();
        store
            .insert_session(&Session {
                id: "session".into(),
                workspace_id: workspace.clone(),
                executor: "claude".into(),
                external_id: Some("native".into()),
                title: "Разговор".into(),
                state: "completed".into(),
                last_activity_at: 0,
            })
            .unwrap();
        store
            .insert_run(&Run {
                id: "run".into(),
                session_id: "session".into(),
                state: "completed".into(),
            })
            .unwrap();
        let context = Context {
            workspace_id: workspace.clone(),
            session_id: "session".into(),
            run_id: "run".into(),
        };
        store
            .append_message(&context, "assistant", "История")
            .unwrap();
        for (id, file) in [("message", None), ("file", Some("main.rs".to_string()))] {
            store
                .save_draft(&Draft {
                    id: id.into(),
                    workspace_id: workspace.clone(),
                    session_id: file.is_none().then(|| "session".into()),
                    path: file.clone(),
                    body: "Черновик".into(),
                    base_version: file.map(|_| "Исходник".into()),
                })
                .unwrap();
        }
        store
            .save_setting("model", &serde_json::json!("chosen"))
            .unwrap();
        let snapshot = serde_json::to_value(store.snapshot().unwrap()).unwrap();
        let mut next = MIGRATIONS.to_vec();
        next.push("CREATE TABLE next_version(value TEXT);");
        upgrade(&mut store.connection, &path, &next).unwrap();
        assert_eq!(
            serde_json::to_value(store.snapshot().unwrap()).unwrap(),
            snapshot
        );
        assert_eq!(store.messages("session", 0).unwrap()[0].body, "История");
        assert_eq!(store.drafts(&workspace).unwrap().len(), 2);
        assert_eq!(
            store.setting("model").unwrap(),
            Some(serde_json::json!("chosen"))
        );
        drop(store);
        assert!(Store::open(&path).err().unwrap().contains("более новой"));
        let backup = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|file| file.extension().is_some_and(|extension| extension == "bak"))
            .unwrap();
        std::fs::copy(backup, &path).unwrap();
        let restored = Store::open(&path).unwrap();
        assert_eq!(
            serde_json::to_value(restored.snapshot().unwrap()).unwrap(),
            snapshot
        );
        assert_eq!(restored.messages("session", 0).unwrap()[0].body, "История");
        assert_eq!(restored.drafts(&workspace).unwrap().len(), 2);
        assert_eq!(
            restored.setting("model").unwrap(),
            Some(serde_json::json!("chosen"))
        );
    }

    #[test]
    fn upgrade_keeps_a_compatible_snapshot_including_wal_data() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.sqlite3");
        let mut connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let original =
            "CREATE TABLE original(value TEXT); INSERT INTO original VALUES('сохранено');";
        migrate(&mut connection, &[original]).unwrap();
        upgrade(
            &mut connection,
            &path,
            &[original, "ALTER TABLE original ADD COLUMN added TEXT;"],
        )
        .unwrap();
        let backup = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|file| file.extension().is_some_and(|extension| extension == "bak"))
            .unwrap();
        let mut compatible = Connection::open(&backup).unwrap();
        migrate(&mut compatible, &[original]).unwrap();
        assert_eq!(
            compatible
                .query_row("SELECT value FROM original", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "сохранено"
        );
        assert!(compatible.prepare("SELECT added FROM original").is_err());
        assert!(connection.prepare("SELECT added FROM original").is_ok());
        let before = std::fs::read(&backup).unwrap();
        assert!(upgrade(
            &mut connection,
            &path,
            &[
                original,
                "ALTER TABLE original ADD COLUMN added TEXT;",
                "UPDATE original SET value='потеряно'; INVALID SQL;"
            ]
        )
        .unwrap_err()
        .contains("резервная копия"));
        assert_eq!(
            connection
                .query_row("SELECT value FROM original", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "сохранено"
        );
        assert_eq!(std::fs::read(backup).unwrap(), before);
    }
}
