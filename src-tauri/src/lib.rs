pub mod claude;
pub mod codex;
mod codex_rpc;
pub mod conversations;
pub mod core;
pub mod editor;
mod editor_themes;
pub mod executor_settings;
pub mod executors;
pub mod git;
mod languages;
pub mod lifecycle;
pub mod model;
mod notifications;
pub mod preparation;
pub mod processes;
mod session_titles;
pub mod store;
pub mod terminal;
mod terminal_observer;
mod terminal_shell;
mod workspace_code_trust;
pub mod workspaces;

use crate::{
    core::Core,
    model::*,
    store::{Result, Store},
    workspace_code_trust::WorkspaceCodeTrust,
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

#[derive(Default)]
struct ExitReady(AtomicBool);

#[tauri::command(async)]
fn import_editor_themes(path: String) -> Result<Vec<editor_themes::Theme>> {
    editor_themes::import(Path::new(&path))
}

#[tauri::command(async)]
fn has_active_work(core: State<'_, Arc<Mutex<Core>>>) -> Result<bool> {
    lifecycle::has_active_work(&*core.lock().map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn finish_exit(
    app: tauri::AppHandle,
    core: State<'_, Arc<Mutex<Core>>>,
    confirmed: bool,
) -> Result<()> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || lifecycle::shutdown(&core, confirmed))
        .await
        .map_err(|e| e.to_string())??;
    languages::stop_all(app.state::<Mutex<languages::Languages>>().inner());
    app.state::<ExitReady>().0.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[tauri::command(async)]
fn reconcile_processes(
    core: State<'_, Arc<Mutex<Core>>>,
) -> Result<Vec<lifecycle::RecoveredProcess>> {
    lifecycle::reconcile(&mut *core.lock().map_err(|e| e.to_string())?)
}

#[tauri::command(async)]
fn list_git_repositories(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
) -> Result<Vec<String>> {
    let core = core.lock().map_err(|e| e.to_string())?;
    core.processes.ensure_accepting()?;
    git::repositories(&core.store, &workspace_id)
}

#[tauri::command(async)]
fn git_status(core: State<'_, Arc<Mutex<Core>>>, target: git::Target) -> Result<git::Status> {
    git::with_target(&core, &target, false, git::status)
}

#[tauri::command(async)]
fn stage_git_files(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    paths: Vec<String>,
) -> Result<()> {
    git::with_target(&core, &target, true, |repository| {
        git::stage_files(repository, &paths)
    })
}

#[tauri::command(async)]
fn git_diff(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    path: String,
) -> Result<git::Diff> {
    git::with_target(&core, &target, false, |repository| {
        git::diff(repository, &path)
    })
}

#[tauri::command(async)]
fn stage_git_hunk(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    expected: git::Diff,
    hunk: usize,
) -> Result<()> {
    git::with_target(&core, &target, true, |repository| {
        git::stage_hunk(repository, &expected, hunk)
    })
}

#[tauri::command(async)]
fn commit_git(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    message: String,
) -> Result<String> {
    git::with_target(&core, &target, true, |repository| {
        git::commit(repository, &message)
    })
}

#[tauri::command(async)]
fn push_git(core: State<'_, Arc<Mutex<Core>>>, target: git::Target) -> Result<String> {
    git::with_target(&core, &target, true, git::push)
}

#[tauri::command(async)]
fn git_versions(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    path: String,
) -> Result<Vec<git::Version>> {
    git::with_target(&core, &target, false, |repository| {
        git::versions(repository, &path)
    })
}

#[tauri::command(async)]
fn git_branches(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
) -> Result<Vec<git::Branch>> {
    git::with_target(&core, &target, false, git::branches)
}

#[tauri::command(async)]
fn git_history(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    options: git::LogOptions,
) -> Result<git::History> {
    git::with_target(&core, &target, false, |repository| {
        git::history(repository, &options)
    })
}

#[tauri::command(async)]
fn git_commit_details(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    reference: String,
) -> Result<git::CommitDetails> {
    git::with_target(&core, &target, false, |repository| {
        git::commit_details(repository, &reference)
    })
}

#[tauri::command(async)]
fn git_compare_branches(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    base: String,
    reference: String,
) -> Result<git::CommitDetails> {
    git::with_target(&core, &target, false, |repository| {
        git::compare_branches(repository, &base, &reference)
    })
}

#[tauri::command(async)]
fn git_revision_versions(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    reference: String,
    path: String,
    base: Option<String>,
) -> Result<Vec<git::Version>> {
    git::with_target(&core, &target, false, |repository| {
        git::revision_versions(repository, &reference, &path, base.as_deref())
    })
}

#[tauri::command(async)]
fn unstage_git_files(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    paths: Vec<String>,
) -> Result<()> {
    git::with_target(&core, &target, true, |repository| {
        git::unstage_files(repository, &paths)
    })
}

#[tauri::command(async)]
fn discard_git_file(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    expected: git::Diff,
) -> Result<()> {
    git::with_target(&core, &target, true, |repository| {
        git::discard_file(repository, &expected)
    })
}

#[tauri::command(async)]
fn git_stashes(core: State<'_, Arc<Mutex<Core>>>, target: git::Target) -> Result<Vec<git::Stash>> {
    git::with_target(&core, &target, false, git::stashes)
}

#[tauri::command(async)]
fn git_action(
    core: State<'_, Arc<Mutex<Core>>>,
    target: git::Target,
    action: git::Action,
) -> Result<String> {
    git::with_target(&core, &target, true, |repository| {
        git::action(repository, &action)
    })
}

#[tauri::command(async)]
fn list_directory(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    path: String,
) -> Result<Vec<editor::Entry>> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    editor::directory(&root, &path)
}

#[tauri::command(async)]
fn search_files(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    query: String,
    options: Option<editor::SearchOptions>,
) -> Result<editor::SearchResults> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    editor::search_with_options(&root, &query, &options.unwrap_or_default())
}

#[tauri::command(async)]
fn list_source_files(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
) -> Result<Vec<String>> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    editor::source_files(&root)
}

#[tauri::command(async)]
fn apply_file_edits(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    edits: Vec<editor::FileEdit>,
) -> Result<Vec<editor::Document>> {
    editor::apply_edits(core.inner(), &workspace_id, &edits)
}

#[tauri::command(async)]
fn list_file_drafts(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
) -> Result<Vec<String>> {
    editor::drafts(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )
}

#[tauri::command(async)]
fn open_file(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    path: String,
) -> Result<editor::Document> {
    editor::open(core.inner(), &workspace_id, &path)
}

#[tauri::command(async)]
fn read_file_disk(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    path: String,
) -> Result<Option<String>> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    editor::disk(&root, &path)
}

#[tauri::command(async)]
fn save_file_draft(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    path: String,
    body: String,
    base: String,
) -> Result<()> {
    editor::save_draft(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
        &path,
        &body,
        &base,
    )
}

#[tauri::command(async)]
fn save_file(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    document: editor::Document,
    overwrite: bool,
) -> Result<editor::Document> {
    editor::save(core.inner(), &workspace_id, &document, overwrite)
}

#[tauri::command(async)]
fn read_git_file(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    path: String,
    revision: String,
) -> Result<String> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    editor::git_version(&root, &path, &revision)
}

#[tauri::command(async)]
fn read_conversation(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    before_message: Option<i64>,
    before_event: Option<i64>,
) -> Result<conversations::Conversation> {
    conversations::read(
        &*core.lock().map_err(|e| e.to_string())?,
        &session_id,
        before_message,
        before_event,
    )
}

#[tauri::command(async)]
fn prepare_conversation_input(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    text: String,
    paths: Vec<String>,
) -> Result<Vec<serde_json::Value>> {
    conversations::input(
        &core.lock().map_err(|e| e.to_string())?.store,
        &session_id,
        &text,
        &paths,
    )
}

#[tauri::command(async)]
fn save_conversation_draft(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    body: String,
) -> Result<()> {
    conversations::save_draft(
        &core.lock().map_err(|e| e.to_string())?.store,
        &session_id,
        &body,
    )
}

#[tauri::command(async)]
fn rename_conversation(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    title: String,
) -> Result<()> {
    conversations::rename(
        &mut core.lock().map_err(|e| e.to_string())?.store,
        &session_id,
        &title,
    )
}

#[tauri::command(async)]
fn delete_conversation(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    confirmed: bool,
) -> Result<View> {
    conversations::delete(
        &mut *core.lock().map_err(|e| e.to_string())?,
        &session_id,
        confirmed,
    )
}

#[tauri::command(async)]
fn create_claude_session(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    title: String,
) -> Result<Session> {
    claude::create_session(core.inner(), &workspace_id, &title)
}

#[tauri::command(async)]
fn start_claude_turn(
    app: tauri::AppHandle,
    core: State<'_, Arc<Mutex<Core>>>,
    trust: State<'_, WorkspaceCodeTrust>,
    workspace_id: String,
    session_id: String,
    input: Vec<serde_json::Value>,
    draft: Option<String>,
) -> Result<Context> {
    let notifier = app.clone();
    claude::start(
        core.inner(),
        &workspace_id,
        &session_id,
        input,
        draft,
        |root| trust.check(&app, &workspace_id, root, true),
        Arc::new(move |event| notifications::publish_run_event(&notifier, "Claude Code", event)),
    )
}

#[tauri::command(async)]
fn reply_claude_request(
    core: State<'_, Arc<Mutex<Core>>>,
    context: Context,
    request_id: serde_json::Value,
    result: serde_json::Value,
) -> Result<()> {
    claude::reply(core.inner(), &context, request_id, result)
}

#[tauri::command(async)]
fn interrupt_claude_turn(core: State<'_, Arc<Mutex<Core>>>, context: Context) -> Result<()> {
    claude::interrupt(core.inner(), &context)
}

#[tauri::command(async)]
fn stop_claude_process(core: State<'_, Arc<Mutex<Core>>>, context: Context) -> Result<()> {
    claude::stop(core.inner(), &context)
}

#[tauri::command(async)]
fn create_codex_session(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    title: String,
) -> Result<Session> {
    codex::create_session(core.inner(), &workspace_id, &title)
}

#[tauri::command(async)]
fn start_codex_turn(
    app: tauri::AppHandle,
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    session_id: String,
    input: Vec<serde_json::Value>,
    draft: Option<String>,
) -> Result<Context> {
    codex::start(
        core.inner(),
        &workspace_id,
        &session_id,
        input,
        draft,
        Arc::new(move |event| notifications::publish_run_event(&app, "Codex", event)),
    )
}

#[tauri::command(async)]
fn reply_codex_request(
    core: State<'_, Arc<Mutex<Core>>>,
    context: Context,
    request_id: serde_json::Value,
    result: serde_json::Value,
) -> Result<()> {
    codex::reply(core.inner(), &context, request_id, result)
}

#[tauri::command(async)]
fn interrupt_codex_turn(core: State<'_, Arc<Mutex<Core>>>, context: Context) -> Result<()> {
    codex::interrupt(core.inner(), &context)
}

#[tauri::command(async)]
fn stop_codex_process(core: State<'_, Arc<Mutex<Core>>>, context: Context) -> Result<()> {
    codex::stop(core.inner(), &context)
}

#[tauri::command(async)]
fn session_messages(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    after: i64,
) -> Result<Vec<Message>> {
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .messages(&session_id, after)
}

#[tauri::command(async)]
fn session_events(
    core: State<'_, Arc<Mutex<Core>>>,
    session_id: String,
    after: i64,
) -> Result<Vec<StoredEvent>> {
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .events(&session_id, after)
}

#[tauri::command(async)]
fn executor_availability() -> Vec<executors::Availability> {
    let cwd = std::env::temp_dir();
    ["codex", "claude"]
        .iter()
        .map(|name| executors::discover(name, &cwd))
        .collect()
}

#[tauri::command(async)]
fn load_executor_settings(
    core: State<'_, Arc<Mutex<Core>>>,
    target: executor_settings::Target,
) -> Result<executor_settings::Settings> {
    executor_settings::load(&core.lock().map_err(|e| e.to_string())?.store, &target)
}

#[tauri::command(async)]
fn inspect_executor_settings(
    core: State<'_, Arc<Mutex<Core>>>,
    target: executor_settings::Target,
) -> Result<executor_settings::Catalog> {
    let workspace = {
        let core = core.lock().map_err(|e| e.to_string())?;
        target.validate(&core.store, false)?
    };
    executor_settings::inspect(&target, &workspace, &executor_settings::Settings::default())
}

#[tauri::command(async)]
fn save_executor_settings(
    core: State<'_, Arc<Mutex<Core>>>,
    target: executor_settings::Target,
    settings: executor_settings::Settings,
) -> Result<()> {
    let workspace = target.validate(&core.lock().map_err(|e| e.to_string())?.store, true)?;
    executor_settings::inspect(&target, &workspace, &settings)?;
    executor_settings::save(
        &core.lock().map_err(|e| e.to_string())?.store,
        &target,
        &settings,
    )
}

#[tauri::command(async)]
fn start_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    cols: u16,
    rows: u16,
    source_id: Option<String>,
) -> Result<terminal::TerminalInfo> {
    terminal::start_from(
        core.inner(),
        &workspace_id,
        cols,
        rows,
        source_id.as_deref(),
    )
}

#[tauri::command(async)]
fn terminal_shell_context(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
) -> Result<terminal_shell::Context> {
    terminal::shell_context(core.inner(), &workspace_id, &id)
}

#[tauri::command]
async fn edit_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
    command: String,
    cursor: usize,
    request: u64,
    action: String,
) -> Result<terminal_shell::Editor> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        terminal::edit(
            &core,
            &workspace_id,
            &id,
            &command,
            cursor,
            request,
            &action,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restore_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
    command: String,
) -> Result<()> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        terminal::restore(&core, &workspace_id, &id, &command)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn submit_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
    command: String,
) -> Result<()> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        terminal::submit(&core, &workspace_id, &id, &command)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
fn list_terminals(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
) -> Result<Vec<terminal::TerminalInfo>> {
    terminal::list(core.inner(), &workspace_id)
}

#[tauri::command(async)]
fn read_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
) -> Result<terminal::TerminalFrame> {
    terminal::read(core.inner(), &workspace_id, &id)
}

#[tauri::command]
async fn wait_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
) -> Result<()> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || terminal::wait(&core, &workspace_id, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
    data: String,
) -> Result<()> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || terminal::write(&core, &workspace_id, &id, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
fn interrupt_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
) -> Result<terminal::InterruptResult> {
    terminal::interrupt(core.inner(), &workspace_id, &id)
}

#[tauri::command(async)]
fn resize_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    terminal::resize(core.inner(), &workspace_id, &id, cols, rows)
}

#[tauri::command(async)]
fn stop_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
) -> Result<()> {
    terminal::stop(core.inner(), &workspace_id, &id)
}

#[tauri::command(async)]
fn delete_terminal(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    id: String,
    replacement_id: Option<String>,
    confirmed: bool,
) -> Result<View> {
    terminal::delete(
        core.inner(),
        &workspace_id,
        &id,
        replacement_id.as_deref(),
        confirmed,
    )
}

#[tauri::command(async)]
fn snapshot(core: State<'_, Arc<Mutex<Core>>>) -> Result<Snapshot> {
    let snapshot = workspaces::snapshot(core.inner())?;
    #[cfg(target_os = "macos")]
    let snapshot = Snapshot {
        screen_reader_enabled: objc2_app_kit::NSWorkspace::sharedWorkspace().isVoiceOverEnabled(),
        ..snapshot
    };
    Ok(snapshot)
}

#[tauri::command(async)]
fn save_view(core: State<'_, Arc<Mutex<Core>>>, view: View) -> Result<()> {
    core.lock().map_err(|e| e.to_string())?.save_view(&view)
}

#[tauri::command(async)]
fn register_folder(
    core: State<'_, Arc<Mutex<Core>>>,
    name: String,
    path: String,
    group_id: Option<String>,
) -> Result<()> {
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .register_folder(&name, Path::new(&path), group_id.as_deref())
}

#[tauri::command(async)]
fn create_group(
    core: State<'_, Arc<Mutex<Core>>>,
    name: String,
    path: Option<String>,
) -> Result<()> {
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .create_group(&name, path.as_deref().map(Path::new))
}

#[tauri::command(async)]
fn project_branches(core: State<'_, Arc<Mutex<Core>>>, project_id: String) -> Result<Vec<String>> {
    workspaces::project_branches(core.inner(), &project_id)
}

#[tauri::command(async)]
fn create_worktree(core: State<'_, Arc<Mutex<Core>>>, request: NewWorktree) -> Result<Workspace> {
    let workspace = workspaces::create_worktree(core.inner(), &request)?;
    preparation::start(core.inner().clone(), &workspace.id)?;
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .workspace(&workspace.id)
}

#[tauri::command(async)]
fn open_group_folder(core: State<'_, Arc<Mutex<Core>>>, group_id: String) -> Result<Workspace> {
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .open_group_folder(&group_id)
}

#[tauri::command(async)]
fn set_preparation_command(
    core: State<'_, Arc<Mutex<Core>>>,
    project_id: String,
    command: String,
) -> Result<()> {
    core.lock()
        .map_err(|e| e.to_string())?
        .store
        .set_preparation_command(&project_id, &command)
}

#[tauri::command(async)]
fn archive_workspace(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    archived: bool,
) -> Result<()> {
    core.lock()
        .map_err(|e| e.to_string())?
        .archive_workspace(&workspace_id, archived)
}

#[tauri::command(async)]
fn inspect_workspace_deletion(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
) -> Result<DeletionCheck> {
    workspaces::inspect_deletion(core.inner(), &workspace_id)
}

#[tauri::command(async)]
fn delete_workspace(
    core: State<'_, Arc<Mutex<Core>>>,
    expected: DeletionCheck,
    confirmed: bool,
    discard_work: bool,
) -> Result<()> {
    workspaces::delete_workspace(core.inner(), &expected, confirmed, discard_work)
}

#[tauri::command(async)]
fn delete_workspace_branch(
    core: State<'_, Arc<Mutex<Core>>>,
    workspace_id: String,
    branch: String,
    head: String,
    confirmed: bool,
) -> Result<()> {
    workspaces::delete_workspace_branch(core.inner(), &workspace_id, &branch, &head, confirmed)
}

#[tauri::command(async)]
fn context_status(core: State<'_, Arc<Mutex<Core>>>, context: Context) -> Result<Run> {
    core.lock()
        .map_err(|e| e.to_string())?
        .context_status(&context)
}

#[tauri::command(async)]
fn save_message_draft(
    app: tauri::AppHandle,
    core: State<'_, Arc<Mutex<Core>>>,
    context: Context,
    body: String,
) -> Result<StoredEvent> {
    use tauri::Emitter;
    let mut core = core.lock().map_err(|e| e.to_string())?;
    core.store.validate_context(&context)?;
    core.store.save_draft(&Draft {
        id: format!("message:{}", context.session_id),
        workspace_id: context.workspace_id.clone(),
        session_id: Some(context.session_id.clone()),
        path: None,
        body,
        base_version: None,
    })?;
    core.publish_event(&context, "draft_saved", serde_json::Value::Null, |event| {
        app.emit("run-event", event)
            .map_err(|e| format!("черновик сохранён, но событие не доставлено: {e}"))
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExitReady::default())
        .manage(WorkspaceCodeTrust::default())
        .manage(Mutex::new(languages::Languages::default()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                // ⌘W обрабатывается интерфейсом как закрытие вкладки, а не окна.
                let application = SubmenuBuilder::new(app, "Yade")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .separator()
                    .quit()
                    .build()?;
                let edit = SubmenuBuilder::new(app, "Правка")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window = SubmenuBuilder::new(app, "Окно")
                    .minimize()
                    .maximize()
                    .fullscreen()
                    .build()?;
                app.set_menu(
                    MenuBuilder::new(app)
                        .items(&[&application, &edit, &window])
                        .build()?,
                )?;
            }
            executors::initialize(&app.path().resource_dir()?);
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let store = Store::open(&directory.join("state.sqlite3")).map_err(|error| {
                #[cfg(target_os = "macos")]
                let _ = std::process::Command::new("/usr/bin/osascript")
                    .args([
                        "-e",
                        "on run argv\n display alert \"Не удалось открыть данные Yade\" message (item 1 of argv) as critical buttons {\"Закрыть\"}\nend run",
                        &error,
                    ])
                    .status();
                std::io::Error::other(error)
            })?;
            let mut core = Core {
                store,
                processes: Default::default(),
            };
            lifecycle::recover(&mut core).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            notifications::prepare(&core.store);
            app.manage(Arc::new(Mutex::new(core)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notifications::load_notification_settings,
            notifications::set_notification_enabled,
            has_active_work,
            finish_exit,
            reconcile_processes,
            list_git_repositories,
            git_status,
            stage_git_files,
            git_diff,
            stage_git_hunk,
            commit_git,
            push_git,
            git_versions,
            git_branches,
            git_history,
            git_commit_details,
            git_compare_branches,
            git_revision_versions,
            unstage_git_files,
            discard_git_file,
            git_stashes,
            git_action,
            list_directory,
            import_editor_themes,
            search_files,
            list_source_files,
            apply_file_edits,
            languages::language_tools,
            languages::install_language_tool,
            languages::start_language_server,
            languages::send_language_message,
            languages::stop_language_server,
            languages::read_language_file,
            list_file_drafts,
            open_file,
            read_file_disk,
            save_file_draft,
            save_file,
            read_git_file,
            read_conversation,
            prepare_conversation_input,
            save_conversation_draft,
            rename_conversation,
            delete_conversation,
            create_claude_session,
            start_claude_turn,
            reply_claude_request,
            interrupt_claude_turn,
            stop_claude_process,
            create_codex_session,
            start_codex_turn,
            reply_codex_request,
            interrupt_codex_turn,
            stop_codex_process,
            session_messages,
            session_events,
            executor_availability,
            load_executor_settings,
            inspect_executor_settings,
            save_executor_settings,
            start_terminal,
            terminal_shell_context,
            edit_terminal,
            restore_terminal,
            submit_terminal,
            list_terminals,
            read_terminal,
            wait_terminal,
            write_terminal,
            interrupt_terminal,
            resize_terminal,
            stop_terminal,
            delete_terminal,
            snapshot,
            save_view,
            register_folder,
            create_group,
            project_branches,
            create_worktree,
            open_group_folder,
            set_preparation_command,
            archive_workspace,
            inspect_workspace_deletion,
            delete_workspace,
            delete_workspace_branch,
            context_status,
            save_message_draft
        ])
        .build(tauri::generate_context!())
        .expect("не удалось запустить приложение")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !app.state::<ExitReady>().0.load(Ordering::SeqCst) {
                    use tauri::Emitter;
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show().and_then(|_| window.set_focus());
                    }
                    if let Err(error) = app.emit("app-exit-requested", ()) {
                        eprintln!("запрос выхода не доставлен: {error}");
                    }
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                api.prevent_close();
                if let Some(window) = app.get_webview_window(&label) {
                    if let Err(error) = window.hide() {
                        eprintln!("не удалось скрыть окно: {error}");
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                        eprintln!("не удалось открыть окно: {error}");
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod workspace_tests;

#[cfg(all(test, unix))]
mod lifecycle_tests;

#[cfg(all(test, unix))]
mod terminal_tests;

#[cfg(all(test, unix))]
mod codex_tests;

#[cfg(all(test, unix))]
mod claude_tests;

#[cfg(all(test, unix))]
mod claude_local_tests;
