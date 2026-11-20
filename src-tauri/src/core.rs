use crate::{
    model::*,
    store::{Result, Store},
};

pub struct Core {
    pub store: Store,
    pub processes: crate::processes::Processes,
}

impl Core {
    pub fn save_view(&mut self, view: &View) -> Result<()> {
        self.processes.ensure_accepting()?;
        self.store.save_view(view)?;
        if let Some(tab) = view.tabs.iter().find(|tab| {
            view.workspace_id.as_ref() == Some(&tab.workspace_id)
                && view.active_tabs.get(&tab.workspace_id) == Some(&tab.id)
        }) {
            if let Some(terminal) = tab
                .id
                .strip_prefix("terminal:")
                .and_then(|id| self.processes.terminals.get_mut(id))
                .filter(|terminal| terminal.info.workspace_id == tab.workspace_id)
            {
                terminal.mark_used();
            }
        }
        Ok(())
    }

    pub fn ensure_workspace_idle(&self, workspace_id: &str) -> Result<()> {
        let workspace = self.store.workspace(workspace_id)?;
        if ["creating", "deleting"].contains(&workspace.operation_state.as_str())
            || ["pending", "running"].contains(&workspace.preparation_state.as_str())
        {
            return Err("сначала дождитесь завершения операции с пространством".into());
        }
        let active: bool = self.store.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE workspace_id=?1 AND state NOT IN ('ready','completed','failed','error','interrupted','stopped'))
             OR EXISTS(SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.workspace_id=?1 AND r.state NOT IN ('ready','completed','failed','error','interrupted','stopped'))
             OR EXISTS(SELECT 1 FROM processes WHERE workspace_id=?1 AND state IN ('running','needs_reconciliation'))",
            [workspace_id], |r| r.get(0)
        ).map_err(|e| e.to_string())?;
        if active || self.processes.has_workspace(workspace_id) {
            return Err("сначала остановите сессии и процессы пространства".into());
        }
        Ok(())
    }

    pub fn archive_workspace(&mut self, workspace_id: &str, archived: bool) -> Result<()> {
        self.store.workspace(workspace_id)?;
        if archived {
            self.ensure_workspace_idle(workspace_id)?;
        }
        self.store.set_archived(workspace_id, archived)
    }

    pub fn context_status(&self, context: &Context) -> Result<Run> {
        self.store.validate_context(context)?;
        self.store
            .runs(&context.session_id)?
            .into_iter()
            .find(|r| r.id == context.run_id)
            .ok_or("запуск отсутствует".into())
    }

    pub fn publish_event(
        &mut self,
        context: &Context,
        kind: &str,
        payload: serde_json::Value,
        publish: impl FnOnce(&StoredEvent) -> Result<()>,
    ) -> Result<StoredEvent> {
        let event = self.store.record_event(context, kind, payload)?;
        publish(&event)?;
        Ok(event)
    }
}
