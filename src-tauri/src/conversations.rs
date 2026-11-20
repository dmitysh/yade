use crate::{
    core::Core,
    executor_settings::Target,
    model::*,
    store::{Result, Store},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub session: Session,
    pub context: Option<Context>,
    pub can_stop: bool,
    pub messages: Vec<Message>,
    pub message_events: BTreeMap<i64, i64>,
    pub events: Vec<StoredEvent>,
    pub requests: Vec<StoredEvent>,
    pub older_messages: bool,
    pub older_events: bool,
    pub draft: String,
}

pub(crate) fn session(store: &Store, id: &str) -> Result<Session> {
    store
        .connection
        .query_row(
            "SELECT id,workspace_id,executor,external_id,title,state,last_activity_at FROM sessions WHERE id=?1",
            [id],
            |r| {
                Ok(Session {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    executor: r.get(2)?,
                    external_id: r.get(3)?,
                    title: r.get(4)?,
                    state: r.get(5)?,
                    last_activity_at: r.get(6)?,
                })
            },
        )
        .map_err(|e| format!("разговор недоступен: {e}"))
}

pub(crate) fn update_native_title(connection: &Connection, id: &str, title: &Value) -> Result<()> {
    if let Some(title) = title.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        connection
            .execute(
                "UPDATE sessions SET title=?2 WHERE id=?1 AND title='Новый чат'
                 AND NOT EXISTS(SELECT 1 FROM settings WHERE key='manual-session-title:' || sessions.id)",
                params![id, title],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn rename(store: &mut Store, id: &str, title: &str) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err("укажите название разговора".into());
    }
    session(store, id)?;
    let tx = store.connection.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE sessions SET title=?2 WHERE id=?1",
        params![id, title],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO settings(key,value) VALUES(?1,'true') ON CONFLICT(key) DO NOTHING",
        [format!("manual-session-title:{id}")],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn active(state: &str) -> bool {
    ![
        "ready",
        "completed",
        "failed",
        "error",
        "interrupted",
        "stopped",
    ]
    .contains(&state)
}

fn events(
    store: &Store,
    session: &Session,
    run: Option<&str>,
    before: Option<i64>,
) -> Result<Vec<StoredEvent>> {
    let filter = if run.is_some() {
        "AND e.run_id=?2 AND e.kind='request'
         AND NOT EXISTS(SELECT 1 FROM events resolved WHERE resolved.run_id=e.run_id
           AND resolved.sequence>e.sequence AND resolved.kind IN ('request_resolved','request_answer')
           AND json_extract(resolved.payload,'$.requestId') IS json_extract(e.payload,'$.requestId'))"
    } else {
        "AND e.sequence<?2 AND (e.kind NOT IN ('message','message_delta','message_completed','draft_saved')
         OR (e.kind='message_completed' AND json_array_length(e.payload,'$.questions')>0)) ORDER BY e.sequence DESC LIMIT 101"
    };
    let sql = format!("SELECT e.sequence,e.run_id,e.kind,e.payload FROM events e JOIN runs r ON r.id=e.run_id WHERE r.session_id=?1 {filter}");
    let cursor = before.unwrap_or(i64::MAX);
    let run_id = run.unwrap_or_default();
    let value: &dyn rusqlite::ToSql = if run.is_some() { &run_id } else { &cursor };
    let rows = store
        .connection
        .prepare(&sql)
        .and_then(|mut q| {
            q.query_map(params![session.id, value], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?))
            })?
            .collect::<rusqlite::Result<Vec<(i64, String, String, String)>>>()
        })
        .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|(sequence, run_id, kind, payload)| {
            Ok(StoredEvent {
                sequence,
                context: Context {
                    workspace_id: session.workspace_id.clone(),
                    session_id: session.id.clone(),
                    run_id,
                },
                kind,
                payload: serde_json::from_str(&payload).map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

pub fn read(
    core: &Core,
    id: &str,
    before_message: Option<i64>,
    before_event: Option<i64>,
) -> Result<Conversation> {
    let store = &core.store;
    let session = session(store, id)?;
    let run = store
        .connection
        .query_row(
            "SELECT id FROM runs WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
            [id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let context = run.as_ref().map(|id| Context {
        workspace_id: session.workspace_id.clone(),
        session_id: session.id.clone(),
        run_id: id.clone(),
    });
    let can_stop = run.as_ref().is_some_and(|id| {
        core.processes.codex.contains_key(id) || core.processes.claude.contains_key(id)
    });
    let mut messages = store.connection.prepare("SELECT sequence,session_id,run_id,role,body FROM messages WHERE session_id=?1 AND sequence<?2 ORDER BY sequence DESC LIMIT 101")
        .and_then(|mut q| q.query_map(params![id,before_message.unwrap_or(i64::MAX)], |r| Ok(Message {sequence:r.get(0)?,session_id:r.get(1)?,run_id:r.get(2)?,role:r.get(3)?,body:r.get(4)?}))?.collect::<rusqlite::Result<Vec<_>>>()).map_err(|e|e.to_string())?;
    let older_messages = messages.len() > 100;
    messages.truncate(100);
    messages.reverse();
    let message_events = store.connection.prepare(
        "SELECT m.sequence,MIN(e.sequence) FROM messages m JOIN events e ON e.run_id=m.run_id
         AND e.kind IN ('message','message_delta','message_completed') AND json_extract(e.payload,'$.sequence')=m.sequence
         WHERE m.session_id=?1 AND m.sequence>=?2 AND m.sequence<=?3 GROUP BY m.sequence",
    ).and_then(|mut q| q.query_map(params![id,messages.first().map(|m|m.sequence).unwrap_or(0),before_message.unwrap_or(i64::MAX)],
        |r| Ok((r.get::<_, i64>(0)?,r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<BTreeMap<_, _>>>()).map_err(|e|e.to_string())?;
    let mut events = events(store, &session, None, before_event)?;
    let older_events = events.len() > 100;
    events.truncate(100);
    events.reverse();
    let requests = if active(&session.state)
        && !["stopping", "needs_reconciliation"].contains(&session.state.as_str())
    {
        if let Some(run) = run.as_deref() {
            self::events(store, &session, Some(run), None)?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let draft = store
        .connection
        .query_row(
            "SELECT body FROM drafts WHERE id=?1 AND session_id=?2",
            params![format!("message:{id}"), id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(Conversation {
        session,
        context,
        can_stop,
        messages,
        message_events,
        events,
        requests,
        older_messages,
        older_events,
        draft,
    })
}

pub fn save_draft(store: &Store, id: &str, body: &str) -> Result<()> {
    let session = session(store, id)?;
    store.save_draft(&Draft {
        id: format!("message:{id}"),
        workspace_id: session.workspace_id,
        session_id: Some(id.into()),
        path: None,
        body: body.into(),
        base_version: None,
    })
}

pub(crate) fn record_user_message(
    tx: &rusqlite::Connection,
    context: &Context,
    input: &[Value],
    draft: Option<&str>,
) -> Result<Value> {
    let body = input
        .iter()
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    tx.execute(
        "INSERT INTO messages(session_id,run_id,role,body) VALUES(?1,?2,'user',?3)",
        params![context.session_id, context.run_id, body],
    )
    .map_err(|e| e.to_string())?;
    let sequence = tx.last_insert_rowid();
    tx.execute(
        "DELETE FROM drafts WHERE id=?1 AND session_id=?2 AND body=?3",
        params![
            format!("message:{}", context.session_id),
            context.session_id,
            draft
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"sequence":sequence,"role":"user","body":body,"input":input}))
}

pub fn input(store: &Store, id: &str, text: &str, paths: &[String]) -> Result<Vec<Value>> {
    let session = session(store, id)?;
    Target {
        workspace_id: session.workspace_id,
        session_id: Some(id.into()),
        executor: session.executor.clone(),
    }
    .validate(store, true)?;
    let mut input = Vec::new();
    let mut text = text.to_owned();
    for path in paths {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err("для вложения нужен абсолютный путь".into());
        }
        let path = path
            .canonicalize()
            .map_err(|e| format!("вложение {} недоступно: {e}", path.display()))?;
        if !path.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("вложение должно быть файлом".into());
        }
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("вложение {} не прочитано: {e}", path.display()))?;
        let extension = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ["png", "jpg", "jpeg", "gif", "webp"].contains(&extension.as_str()) {
            let mut bytes = Vec::new();
            file.take(if session.executor == "codex" {
                16
            } else {
                3 * 1024 * 1024 + 1
            })
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
            if bytes.len() > 3 * 1024 * 1024 {
                return Err("изображение Claude Code превышает 3 МиБ".into());
            }
            let media = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else if bytes.starts_with(b"\xff\xd8\xff") {
                "image/jpeg"
            } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
                "image/gif"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else {
                return Err("неподдерживаемое или повреждённое изображение".into());
            };
            input.push(if session.executor == "codex" { json!({"type":"localImage","path":path}) }
                else { json!({"type":"image","source":{"type":"base64","media_type":media,"data":STANDARD.encode(bytes)}}) });
        } else {
            let path = path.to_str().ok_or("путь вложения не поддерживает UTF-8")?;
            let reference = if path.chars().any(char::is_whitespace) {
                serde_json::to_string(path).map_err(|e| e.to_string())?
            } else {
                path.into()
            };
            text.push_str(&format!("\n\n@{reference}"));
        }
        if serde_json::to_vec(&input).map_err(|e| e.to_string())?.len() + text.len()
            > 4 * 1024 * 1024
        {
            return Err("сообщение превышает 4 МиБ".into());
        }
    }
    if !text.trim().is_empty() {
        input.push(json!({"type":"text","text":text}));
    }
    if input.is_empty()
        || serde_json::to_vec(&input).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024
    {
        return Err("сообщение пустое или превышает 4 МиБ".into());
    }
    Ok(input)
}

pub fn delete(core: &mut Core, id: &str, confirmed: bool) -> Result<View> {
    if !confirmed {
        return Err("подтвердите удаление выбранной истории".into());
    }
    let session = session(&core.store, id)?;
    let processes: bool = core.store.connection.query_row("SELECT EXISTS(SELECT 1 FROM processes p JOIN runs r ON r.id=p.run_id WHERE r.session_id=?1 AND p.state IN ('running','needs_reconciliation'))", [id], |r| r.get(0)).map_err(|e|e.to_string())?;
    if active(&session.state)
        || processes
        || core.store.runs(id)?.iter().any(|r| {
            active(&r.state)
                || core.processes.codex.contains_key(&r.id)
                || core.processes.claude.contains_key(&r.id)
        })
    {
        return Err("сначала остановите выбранный разговор и его процессы".into());
    }
    let mut view = core.store.snapshot()?.view;
    view.tabs.retain(|t| t.session_id.as_deref() != Some(id));
    view.active_tabs
        .retain(|_, id| view.tabs.iter().any(|t| t.id == *id));
    let tx = core
        .store
        .connection
        .transaction()
        .map_err(|e| e.to_string())?;
    for sql in [
        "DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE session_id=?1)",
        "DELETE FROM messages WHERE session_id=?1",
        "DELETE FROM drafts WHERE session_id=?1",
        "DELETE FROM processes WHERE run_id IN (SELECT id FROM runs WHERE session_id=?1)",
        "DELETE FROM runs WHERE session_id=?1",
        "DELETE FROM sessions WHERE id=?1",
    ] {
        tx.execute(sql, [id]).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "DELETE FROM settings WHERE key IN (?1,?2)",
        params![
            format!("session-settings:{id}"),
            format!("manual-session-title:{id}")
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO view_state(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [serde_json::to_string(&view).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(view)
}

#[cfg(test)]
mod tests;
