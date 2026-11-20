use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub workspace_id: String,
    pub session_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub preparation_command: Option<String>,
    pub last_activity_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub project_id: Option<String>,
    pub group_id: Option<String>,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub source_ref: Option<String>,
    pub source_commit: Option<String>,
    pub git_ref: Option<String>,
    pub archived: bool,
    pub deleted: bool,
    pub operation_state: String,
    pub operation_error: Option<String>,
    pub preparation_command: Option<String>,
    pub preparation_state: String,
    pub preparation_output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWorktree {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    pub source_ref: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub executor: String,
    pub external_id: Option<String>,
    pub title: String,
    pub state: String,
    pub last_activity_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub session_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub sequence: i64,
    pub session_id: String,
    pub run_id: Option<String>,
    pub role: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub path: Option<String>,
    pub body: String,
    pub base_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletionCheck {
    pub workspace_id: String,
    pub path: String,
    pub kind: String,
    pub path_exists: bool,
    pub registered: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub drafts: Vec<Draft>,
    pub changes: String,
    pub unmerged: String,
}

impl DeletionCheck {
    pub fn has_work(&self) -> bool {
        !self.drafts.is_empty() || !self.changes.is_empty() || !self.unmerged.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub sequence: i64,
    pub context: Context,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub tabs: Vec<Tab>,
    pub active_tabs: std::collections::BTreeMap<String, String>,
    pub sidebar_width: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub workspace_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub screen_reader_enabled: bool,
    pub groups: Vec<Group>,
    pub projects: Vec<Project>,
    pub workspaces: Vec<Workspace>,
    pub sessions: Vec<Session>,
    pub terminals: Vec<crate::terminal::TerminalInfo>,
    pub view: View,
}
