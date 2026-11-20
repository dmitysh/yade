use crate::store::Result;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
pub(crate) struct WorkspaceCodeTrust(Mutex<HashSet<(String, PathBuf)>>);

impl WorkspaceCodeTrust {
    pub(crate) fn check(
        &self,
        app: &tauri::AppHandle,
        workspace_id: &str,
        root: &Path,
        ask: bool,
    ) -> Result<bool> {
        self.confirm(workspace_id, root, || {
            ask && app
                .dialog()
                .message(format!(
                    "TypeScript и Claude могут автоматически запускать код из этого пространства с вашими правами. Доверие действует до выхода из Yade.\n\n{root:?}"
                ))
                .title("Доверять коду пространства?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Доверять".into(),
                    "Отмена".into(),
                ))
                .blocking_show()
        })
    }

    fn confirm(
        &self,
        workspace_id: &str,
        root: &Path,
        approve: impl FnOnce() -> bool,
    ) -> Result<bool> {
        let key = (workspace_id.to_owned(), root.to_owned());
        if self.0.lock().map_err(|e| e.to_string())?.contains(&key) {
            return Ok(true);
        }
        if !approve() {
            return Ok(false);
        }
        self.0.lock().map_err(|e| e.to_string())?.insert(key);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_only_applies_to_the_approved_workspace_and_path() {
        let trust = WorkspaceCodeTrust::default();
        let root = Path::new("/project");
        assert!(!trust.confirm("first", root, || false).unwrap());
        assert!(trust.confirm("first", root, || true).unwrap());
        assert!(trust.confirm("first", root, || unreachable!()).unwrap());
        assert!(!trust.confirm("second", root, || false).unwrap());
        assert!(!trust
            .confirm("first", Path::new("/other"), || false)
            .unwrap());
        assert!(!WorkspaceCodeTrust::default()
            .confirm("first", root, || false)
            .unwrap());
    }
}
