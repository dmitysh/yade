use crate::{core::Core, model::View, store::Result};
use rusqlite::params;
use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
pub(crate) fn process_identity(pid: u32) -> Result<Option<String>> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("некорректный идентификатор процесса".into());
    }
    let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read != size {
        let error = std::io::Error::last_os_error();
        if [Some(libc::ESRCH), Some(libc::ENOENT)].contains(&error.raw_os_error()) {
            return Ok(None);
        }
        return Err(format!("не удалось проверить процесс {pid}: {error}"));
    }
    if info.pbi_status == 5 {
        return Ok(None);
    } // Завершённый процесс ещё может ожидать wait.
    Ok(Some(format!(
        "macos:{}:{}:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec, info.pbi_uid, info.pbi_pgid
    )))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_identity(pid: u32) -> Result<Option<String>> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("некорректный идентификатор процесса".into());
    }
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("не удалось проверить процесс {pid}: {e}")),
    };
    let (_, fields) = stat
        .rsplit_once(')')
        .ok_or("не удалось прочитать состояние процесса")?;
    let fields: Vec<_> = fields.split_whitespace().collect();
    if fields.first() == Some(&"Z") {
        return Ok(None);
    }
    let start = fields.get(19).ok_or("время создания процесса недоступно")?;
    let boot =
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|e| e.to_string())?;
    Ok(Some(format!("linux:{}:{start}", boot.trim())))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn process_identity(_pid: u32) -> Result<Option<String>> {
    Err("проверка прежних процессов не поддерживается на этой платформе".into())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredProcess {
    pub id: String,
    pub workspace_id: String,
    pub pid: u32,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn group_has_survivors(group: u32, root: u32) -> Result<bool> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,pgid=,stat="])
        .output()
        .map_err(|e| format!("не удалось сверить группу процессов: {e}"))?;
    if !output.status.success() {
        return Err("не удалось сверить группу процессов".into());
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 3 {
            return Err("не удалось прочитать группу процессов".into());
        }
        let pid = fields[0].parse::<u32>().map_err(|e| e.to_string())?;
        let pgid = fields[1].parse::<u32>().map_err(|e| e.to_string())?;
        if pid != root && pgid == group && !fields[2].starts_with('Z') {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn recover(core: &mut Core) -> Result<Vec<RecoveredProcess>> {
    reconcile_previous(core, true)
}

pub fn reconcile(core: &mut Core) -> Result<Vec<RecoveredProcess>> {
    reconcile_previous(core, false)
}

fn clear_terminal_tabs(tx: &rusqlite::Transaction<'_>, mut view: View) -> Result<()> {
    let count = view.tabs.len();
    view.tabs.retain(|tab| !tab.id.starts_with("terminal:"));
    if view.tabs.len() == count {
        return Ok(());
    }
    view.active_tabs.retain(|workspace, active| {
        if !active.starts_with("terminal:") {
            return true;
        }
        if let Some(tab) = view.tabs.iter().find(|tab| &tab.workspace_id == workspace) {
            active.clone_from(&tab.id);
            return true;
        }
        false
    });
    let value = serde_json::to_string(&view).map_err(|e| e.to_string())?;
    tx.execute("UPDATE view_state SET value=?1 WHERE id=1", [value])
        .map_err(|e| format!("расположение вкладок не сохранено: {e}"))?;
    Ok(())
}

fn reconcile_previous(core: &mut Core, recovering: bool) -> Result<Vec<RecoveredProcess>> {
    let records = core.store.connection.prepare("SELECT id,workspace_id,pid,run_id,process_group,identity FROM processes WHERE state IN ('running','needs_reconciliation')")
        .and_then(|mut q| q.query_map([], |r| Ok((RecoveredProcess { id: r.get(0)?, workspace_id: r.get(1)?, pid: r.get(2)?, verified: false, error: None }, r.get::<_, Option<String>>(3)?, r.get::<_, u32>(4)?, r.get::<_, Option<String>>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| e.to_string())?;
    let mut recovered = Vec::new();
    let mut states = Vec::new();
    for (mut process, run, group, identity) in records {
        if core.processes.contains(&process.id)
            || core.processes.terminals.contains_key(&process.id)
            || run.as_ref().is_some_and(|id| core.processes.has_run(id))
        {
            continue;
        }
        let actual = match process_identity(process.pid) {
            Ok(actual) => actual,
            Err(error) => {
                process.error = Some(error);
                None
            }
        };
        process.verified = identity.is_some() && identity == actual;
        let alive = process.verified
            || (identity.is_none() && actual.is_some())
            || process.error.is_some()
            || match group_has_survivors(group, process.pid) {
                Ok(alive) => alive,
                Err(error) => {
                    process.error = Some(error);
                    true
                }
            };
        states.push((
            process.id.clone(),
            if alive {
                "needs_reconciliation"
            } else {
                "exited"
            },
        ));
        if alive {
            recovered.push(process);
        }
    }
    let snapshot = core.store.snapshot()?;
    let tx = core
        .store
        .connection
        .transaction()
        .map_err(|e| e.to_string())?;
    for (id, state) in states {
        tx.execute(
            "UPDATE processes SET state=?2 WHERE id=?1",
            params![id, state],
        )
        .map_err(|e| e.to_string())?;
    }
    let runs = tx.prepare("SELECT id,session_id,state FROM runs WHERE state NOT IN ('ready','completed','failed','error','interrupted','stopped') OR id IN (SELECT run_id FROM processes WHERE state='needs_reconciliation')")
        .and_then(|mut q| q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()).map_err(|e| e.to_string())?;
    let mut affected_sessions = std::collections::HashSet::new();
    for (id, session, previous) in runs {
        if core.processes.has_run(&id) {
            continue;
        }
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM processes WHERE run_id=?1 AND state='needs_reconciliation')", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let state = if pending {
            "needs_reconciliation"
        } else {
            "interrupted"
        };
        tx.execute("UPDATE runs SET state=?2 WHERE id=?1", params![id, state])
            .map_err(|e| e.to_string())?;
        affected_sessions.insert(session);
        if previous != state {
            tx.execute("INSERT INTO events(run_id,kind,payload) VALUES(?1,'state',?2)", params![id, json!({"state":state,"detail":{"message":"прежний запуск проверен после перезапуска; команды не повторялись"}}).to_string()]).map_err(|e| e.to_string())?;
        }
    }
    for session in snapshot.sessions {
        if core.processes.has_session(&session.id) {
            continue;
        }
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=?1 AND state='needs_reconciliation')", [&session.id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if pending
            || affected_sessions.contains(&session.id)
            || crate::conversations::active(&session.state)
        {
            tx.execute(
                "UPDATE sessions SET state=?2 WHERE id=?1",
                params![
                    session.id,
                    if pending {
                        "needs_reconciliation"
                    } else {
                        "interrupted"
                    }
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    for workspace in snapshot.workspaces {
        if core.processes.has_workspace(&workspace.id) {
            continue;
        }
        if workspace.preparation_state == "needs_reconciliation"
            || (recovering
                && ["pending", "running"].contains(&workspace.preparation_state.as_str()))
        {
            let pending = recovered.iter().any(|p| p.workspace_id == workspace.id);
            tx.execute(
                "UPDATE workspaces SET preparation_state=?2 WHERE id=?1",
                params![
                    workspace.id,
                    if pending {
                        "needs_reconciliation"
                    } else {
                        "failed"
                    }
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        if recovering && ["creating", "deleting"].contains(&workspace.operation_state.as_str()) {
            tx.execute("UPDATE workspaces SET operation_state='error',operation_error='операция прервана; проверьте состояние папки и Git' WHERE id=?1", [&workspace.id]).map_err(|e| e.to_string())?;
        }
    }
    if recovering {
        clear_terminal_tabs(&tx, snapshot.view)?;
    }
    tx.commit()
        .map_err(|e| format!("результат сверки не сохранён: {e}"))?;
    Ok(recovered)
}

pub fn has_active_work(core: &Core) -> Result<bool> {
    if core.processes.count() > 0
        || !core.processes.codex.is_empty()
        || !core.processes.claude.is_empty()
        || core.processes.has_git_operations()
    {
        return Ok(true);
    }
    core.store.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE state NOT IN ('ready','completed','failed','error','interrupted','stopped'))
         OR EXISTS(SELECT 1 FROM runs WHERE state NOT IN ('ready','completed','failed','error','interrupted','stopped'))
         OR EXISTS(SELECT 1 FROM processes WHERE state IN ('running','needs_reconciliation'))
         OR EXISTS(SELECT 1 FROM workspaces WHERE operation_state IN ('creating','deleting') OR preparation_state IN ('pending','running','needs_reconciliation'))",
        [], |r| r.get(0),
    ).map_err(|e| e.to_string())
}

pub fn shutdown(core: &Mutex<Core>, confirmed: bool) -> Result<()> {
    let (codex, claude) = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        core.processes.ensure_accepting()?;
        if has_active_work(&core)? && !confirmed {
            return Err("подтвердите завершение активной работы".into());
        }
        core.processes.closing = true;
        (
            core.processes
                .codex
                .values()
                .map(|h| h.context.clone())
                .collect::<Vec<_>>(),
            core.processes
                .claude
                .values()
                .map(|h| h.context.clone())
                .collect::<Vec<_>>(),
        )
    };
    let result = (|| {
        for context in codex {
            crate::codex::stop(core, &context)?;
        }
        for context in claude {
            crate::claude::stop(core, &context)?;
        }
        let git = std::mem::take(
            &mut core.lock().map_err(|e| e.to_string())?.processes.git_operations,
        );
        for done in git {
            // Канал закрывается после завершения Git, в том числе при ошибке.
            let _ = done.recv();
        }
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        let view = store.snapshot()?.view;
        processes.stop_all(store)?;
        let tx = store.connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "UPDATE runs SET state='interrupted' WHERE state NOT IN ('ready','completed','failed','error','interrupted','stopped','needs_reconciliation');
             UPDATE sessions SET state='interrupted' WHERE state NOT IN ('ready','completed','failed','error','interrupted','stopped','needs_reconciliation');
             UPDATE workspaces SET preparation_state='failed' WHERE preparation_state IN ('pending','running');"
        ).map_err(|e| e.to_string())?;
        clear_terminal_tabs(&tx, view)?;
        tx.commit()
            .map_err(|e| format!("состояние перед выходом не сохранено: {e}"))?;
        processes.terminals.clear();
        Ok(())
    })();
    if result.is_err() {
        core.lock().map_err(|e| e.to_string())?.processes.closing = false;
    }
    result
}
