use crate::{
    codex::Publish,
    codex_rpc::{Packet, Rpc},
    core::Core,
    executor_settings::{self, Target},
    executors,
    model::{Context, Session, StoredEvent},
    store::Result,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Command,
    sync::{mpsc, Arc, Mutex, Weak},
    time::Duration,
};

pub(crate) struct Handle {
    pub(crate) context: Context,
    control: mpsc::SyncSender<Control>,
}

enum Action {
    Reply { id: Value, result: Value },
    Interrupt,
    Stop,
}

struct Control {
    action: Action,
    answer: mpsc::SyncSender<Result<()>>,
}

struct Worker {
    core: Weak<Mutex<Core>>,
    context: Context,
    process: String,
    rpc: Rpc,
    control: mpsc::Receiver<Control>,
    publish: Publish,
    params: Value,
    draft: Option<String>,
    native_id: Option<String>,
    initialized: bool,
    current_message: Option<String>,
    completed_text: String,
    messages: HashMap<String, i64>,
    actions: HashSet<String>,
    requests: HashMap<String, Value>,
    commands: HashMap<u64, mpsc::SyncSender<Result<()>>>,
    stopping: bool,
    stop_answer: Option<mpsc::SyncSender<Result<()>>>,
    title_command: Option<Command>,
}

pub fn create_session(core: &Mutex<Core>, workspace_id: &str, title: &str) -> Result<Session> {
    let core = core.lock().map_err(|e| e.to_string())?;
    Target {
        workspace_id: workspace_id.into(),
        session_id: None,
        executor: "claude".into(),
    }
    .validate(&core.store, false)?;
    if title.trim().is_empty() {
        return Err("укажите название разговора".into());
    }
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.into(),
        executor: "claude".into(),
        external_id: None,
        title: title.trim().into(),
        state: "ready".into(),
        last_activity_at: 0,
    };
    core.store.insert_session(&session)?;
    crate::conversations::session(&core.store, &session.id)
}

pub fn start(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    session_id: &str,
    input: Vec<Value>,
    draft: Option<String>,
    approve: impl FnOnce(&Path) -> Result<bool>,
    publish: Publish,
) -> Result<Context> {
    let root = {
        let guard = core.lock().map_err(|e| e.to_string())?;
        Target {
            workspace_id: workspace_id.into(),
            session_id: Some(session_id.into()),
            executor: "claude".into(),
        }
        .validate(&guard.store, true)?;
        crate::editor::root(&guard.store, workspace_id)?
    };
    let available = executors::discover("claude", &root);
    if available.state != "ready" {
        return Err(format!("{} {}", available.reason, available.action));
    }
    if !approve(&root)? {
        return Err("доверие к пространству не подтверждено".into());
    }
    let mut command = executors::claude_command("claude-bridge.ts")?;
    command.env_clear().envs(executors::environment("claude"));
    start_command(
        core,
        workspace_id,
        session_id,
        input,
        draft,
        Some(&root),
        available.path.as_deref().ok_or("Claude Code не найден")?,
        &mut command,
        publish,
    )
}

pub(crate) fn start_command(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    session_id: &str,
    input: Vec<Value>,
    draft: Option<String>,
    trusted_root: Option<&Path>,
    cli: &Path,
    command: &mut Command,
    publish: Publish,
) -> Result<Context> {
    if input.is_empty()
        || serde_json::to_vec(&input).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024
    {
        return Err("сообщение пустое или слишком большое".into());
    }
    let mut guard = core.lock().map_err(|e| e.to_string())?;
    guard.processes.ensure_accepting()?;
    crate::lifecycle::reconcile(&mut guard)?;
    let target = Target {
        workspace_id: workspace_id.into(),
        session_id: Some(session_id.into()),
        executor: "claude".into(),
    };
    let workspace = target.validate(&guard.store, true)?;
    if let Some(root) = trusted_root {
        if crate::editor::root(&guard.store, workspace_id)?.as_path() != root {
            return Err("путь пространства изменился".into());
        }
    }
    if guard
        .processes
        .claude
        .values()
        .any(|h| h.context.session_id == session_id)
    {
        return Err("предыдущий процесс сессии ещё не завершён".into());
    }
    let session = guard
        .store
        .snapshot()?
        .sessions
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or("сессия отсутствует")?;
    let settings = executor_settings::load(&guard.store, &target)?;
    let context = Context {
        workspace_id: workspace_id.into(),
        session_id: session_id.into(),
        run_id: uuid::Uuid::new_v4().to_string(),
    };
    {
        let tx = guard
            .store
            .connection
            .transaction()
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO runs(id,session_id,state) VALUES(?1,?2,'starting')",
            params![context.run_id, session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE sessions SET state='starting' WHERE id=?1",
            [session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let Core { store, processes } = &mut *guard;
    let title_command = crate::session_titles::command(command, "claude");
    let (process, stdin, stdout) = match processes.spawn_stdio(store, &context, command) {
        Ok(process) => process,
        Err(error) => {
            let tx = store.connection.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE runs SET state='error' WHERE id=?1",
                [&context.run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE sessions SET state='error' WHERE id=?1",
                [session_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO events(run_id,kind,payload) VALUES(?1,'error',?2)",
                params![context.run_id, json!({"message":error}).to_string()],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            return Err(error);
        }
    };
    let (sender, control) = mpsc::sync_channel(16);
    processes.claude.insert(
        context.run_id.clone(),
        Handle {
            context: context.clone(),
            control: sender,
        },
    );
    let worker = Worker {
        core: Arc::downgrade(core),
        context: context.clone(),
        process,
        rpc: Rpc::with_name("Claude Code", stdin, stdout),
        control,
        publish,
        params: json!({
            "context":context, "path":cli, "cwd":workspace.path, "settings":settings,
            "input":input, "resume":session.external_id, "loadProjectSettings":trusted_root.is_some(),
        }),
        draft,
        native_id: session.external_id,
        initialized: false,
        current_message: None,
        completed_text: String::new(),
        messages: HashMap::new(),
        actions: HashSet::new(),
        requests: HashMap::new(),
        commands: HashMap::new(),
        stopping: false,
        stop_answer: None,
        title_command: Some(title_command),
    };
    drop(guard);
    std::thread::spawn(move || worker.run());
    Ok(context)
}

pub fn reply(
    core: &Mutex<Core>,
    context: &Context,
    request_id: Value,
    result: Value,
) -> Result<()> {
    control(
        core,
        context,
        Action::Reply {
            id: request_id,
            result,
        },
    )
}

pub fn interrupt(core: &Mutex<Core>, context: &Context) -> Result<()> {
    control(core, context, Action::Interrupt)
}

pub fn stop(core: &Mutex<Core>, context: &Context) -> Result<()> {
    control(core, context, Action::Stop)
}

fn control(core: &Mutex<Core>, context: &Context, action: Action) -> Result<()> {
    let (answer, receiver) = mpsc::sync_channel(1);
    {
        let core = core.lock().map_err(|e| e.to_string())?;
        core.store.validate_context(context)?;
        let Some(handle) = core
            .processes
            .claude
            .get(&context.run_id)
            .filter(|h| h.context == *context)
        else {
            if matches!(action, Action::Stop)
                && !core.processes.has_run(&context.run_id)
                && ["completed", "failed", "error", "interrupted"]
                    .contains(&core.context_status(context)?.state.as_str())
            {
                return Ok(());
            }
            return Err("запрос этого запуска больше не актуален".into());
        };
        handle
            .control
            .try_send(Control { action, answer })
            .map_err(|_| "запуск завершён или очередь управления занята")?;
    }
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "запуск не подтвердил команду; проверьте его состояние")?
}

impl Worker {
    fn record(
        &self,
        kind: &str,
        state: Option<&str>,
        update: impl FnOnce(&Connection) -> Result<Value>,
    ) -> Result<()> {
        let shared = self.core.upgrade().ok_or("приложение завершено")?;
        let mut core = shared.lock().map_err(|e| e.to_string())?;
        core.store.validate_context(&self.context)?;
        let tx = core
            .store
            .connection
            .transaction()
            .map_err(|e| e.to_string())?;
        let payload = update(&tx)?;
        if let Some(state) = state {
            tx.execute(
                "UPDATE runs SET state=?2 WHERE id=?1",
                params![self.context.run_id, state],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE sessions SET state=?2 WHERE id=?1",
                params![self.context.session_id, state],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO events(run_id,kind,payload) VALUES(?1,?2,?3)",
            params![self.context.run_id, kind, payload.to_string()],
        )
        .map_err(|e| e.to_string())?;
        let event = StoredEvent {
            sequence: tx.last_insert_rowid(),
            context: self.context.clone(),
            kind: kind.into(),
            payload,
        };
        tx.commit()
            .map_err(|e| format!("событие Claude Code не сохранено: {e}"))?;
        if state.is_some_and(|s| ["completed", "failed", "error", "interrupted"].contains(&s))
            && !core.processes.contains(&self.process)
        {
            core.processes.claude.remove(&self.context.run_id);
        }
        drop(core);
        (self.publish)(&event)
    }

    fn emit(&self, kind: &str, state: Option<&str>, payload: Value) -> Result<()> {
        self.record(kind, state, |_| Ok(payload))
    }

    fn run(mut self) {
        let result = self.drive();
        for (_, answer) in self.commands.drain() {
            let _ = answer.send(Err("запуск завершён до подтверждения команды".into()));
        }
        let result = self.cancel_requests().and(result);
        let mut cleaned = false;
        loop {
            let cleanup = if cleaned {
                Ok(())
            } else {
                (|| {
                    let shared = self.core.upgrade().ok_or("приложение завершено")?;
                    let mut guard = shared.lock().map_err(|e| e.to_string())?;
                    let Core { store, processes } = &mut *guard;
                    processes.stop(store, &self.context, &self.process)
                })()
            };
            cleaned = cleanup.is_ok();
            let (state, payload) = match (&result, &cleanup) {
                (Ok(outcome), Ok(())) => outcome.clone(),
                (result, cleanup) => (
                    "error".into(),
                    json!({"message":result.as_ref().err().into_iter().chain(cleanup.as_ref().err()).cloned().collect::<Vec<_>>().join("; ")}),
                ),
            };
            let saved = self.emit(
                "state",
                Some(&state),
                json!({"state":state,"detail":payload}),
            );
            if let Err(error) = &saved {
                let _ = (self.publish)(&StoredEvent {
                    sequence: 0,
                    context: self.context.clone(),
                    kind: "save_error".into(),
                    payload: json!({"saved":false,"message":error}),
                });
            }
            let finished = cleanup.and(saved);
            if let Some(answer) = self.stop_answer.take() {
                let _ = answer.send(finished.clone());
            }
            if finished.is_ok() {
                if state == "completed" {
                    if let Some(command) = self.title_command.take() {
                        crate::session_titles::start(
                            self.core.clone(),
                            self.context.clone(),
                            command,
                            self.params.clone(),
                            self.publish.clone(),
                        );
                    }
                }
                return;
            }
            loop {
                let Ok(control) = self.control.recv() else {
                    return;
                };
                if matches!(control.action, Action::Stop) {
                    self.stop_answer = Some(control.answer);
                    break;
                }
                let _ = control
                    .answer
                    .send(Err("сначала завершите процесс Claude Code".into()));
            }
        }
    }

    fn drive(&mut self) -> Result<(String, Value)> {
        self.emit("state", Some("starting"), json!({"state":"starting"}))?;
        self.rpc.request("start", self.params.clone())?;
        let mut outcome = None;
        loop {
            match self.control.try_recv() {
                Ok(control) => {
                    if matches!(control.action, Action::Stop) {
                        self.emit("state", Some("stopping"), json!({"state":"stopping"}))?;
                        self.stop_answer = Some(control.answer);
                        return Ok(("interrupted".into(), json!({"reason":"process_stopped"})));
                    }
                    if outcome.is_some() {
                        let _ = control.answer.send(Err("запуск уже завершён".into()));
                    } else {
                        match self.apply(control.action) {
                            Ok(id) => {
                                self.commands.insert(id, control.answer);
                            }
                            Err(error) => {
                                let _ = control.answer.send(Err(error));
                            }
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("управление запуском закрыто".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            let Some(packet) = self.rpc.receive(Duration::from_millis(20))? else {
                continue;
            };
            match packet {
                Packet::Response { id, method, result } => {
                    if let Ok(value) = &result {
                        self.validate_context(value)?;
                    }
                    if method == "start" {
                        result?;
                    } else {
                        let answer = self
                            .commands
                            .remove(&id)
                            .ok_or("неожиданный ответ Claude Code")?;
                        if method == "interrupt" && result.is_err() {
                            self.stopping = false;
                            let state = self.active_state();
                            self.emit("state", Some(state), json!({"state":state}))?;
                        }
                        let _ = answer.send(result.map(|_| ()));
                    }
                }
                Packet::Event { method, params, id } => {
                    self.validate_context(&params)?;
                    if let Some(result) = self.event(&method, params, id)? {
                        outcome = Some(result);
                    }
                }
            }
            if self.commands.is_empty() {
                if let Some(outcome) = outcome.take() {
                    return Ok(outcome);
                }
            }
        }
    }

    fn validate_context(&self, params: &Value) -> Result<()> {
        if params["context"] != json!(self.context) {
            return Err("событие Claude Code принадлежит другому запуску".into());
        }
        Ok(())
    }

    fn active_state(&self) -> &str {
        if self.stopping {
            "stopping"
        } else if self.requests.is_empty() {
            "running"
        } else {
            "waiting"
        }
    }

    fn cancel_requests(&mut self) -> Result<()> {
        let requests: Vec<_> = self.requests.drain().map(|(id, _)| id).collect();
        for id in requests {
            self.emit(
                "request_resolved",
                None,
                json!({"requestId":id,"cancelled":true}),
            )?;
        }
        Ok(())
    }

    fn apply(&mut self, action: Action) -> Result<u64> {
        match action {
            Action::Reply { id, result } => {
                if self.stopping {
                    return Err("запрос больше не актуален: идёт остановка".into());
                }
                let key = id
                    .as_str()
                    .ok_or("некорректный идентификатор запроса Claude Code")?;
                let request = self.requests.get(key).ok_or("запрос больше не актуален")?;
                validate_reply(request, &result)?;
                self.emit(
                    "request_answer",
                    None,
                    json!({"requestId":id,"result":result}),
                )?;
                let command = self.rpc.request(
                    "reply",
                    json!({"context":self.context,"requestId":id,"result":result}),
                )?;
                self.requests.remove(key);
                self.emit(
                    "request_resolved",
                    Some(self.active_state()),
                    json!({"requestId":id}),
                )?;
                Ok(command)
            }
            Action::Interrupt => {
                if self.stopping {
                    return Err("остановка уже запрошена".into());
                }
                if self.native_id.is_none() {
                    return Err(
                        "Claude Code ещё не начал выполнение; можно завершить процесс".into(),
                    );
                }
                self.emit("state", Some("stopping"), json!({"state":"stopping"}))?;
                self.stopping = true;
                self.rpc
                    .request("interrupt", json!({"context":self.context}))
            }
            Action::Stop => unreachable!(),
        }
    }

    fn message(&mut self, id: &str, text: &str, append: bool) -> Result<()> {
        let mut sequence = self.messages.get(id).copied();
        self.record(if append { "message_delta" } else { "message_completed" }, None, |tx| {
            if let Some(sequence) = sequence {
                tx.execute(if append { "UPDATE messages SET body=body || ?2 WHERE sequence=?1" } else { "UPDATE messages SET body=?2 WHERE sequence=?1" }, params![sequence,text]).map_err(|e| e.to_string())?;
            } else {
                tx.execute("INSERT INTO messages(session_id,run_id,role,body) VALUES(?1,?2,'assistant',?3)", params![self.context.session_id,self.context.run_id,text]).map_err(|e| e.to_string())?;
                sequence = Some(tx.last_insert_rowid());
            }
            Ok(json!({"sequence":sequence,"itemId":id,"text":text}))
        })?;
        self.messages.insert(id.into(), sequence.unwrap());
        Ok(())
    }

    fn action(&mut self, block: &Value) -> Result<()> {
        let id = block["id"]
            .as_str()
            .ok_or("действие Claude Code без идентификатора")?;
        if self.actions.insert(id.into()) {
            self.emit("action_started", None, block.clone())?;
        } else {
            self.emit("action_output", None, block.clone())?;
        }
        Ok(())
    }

    fn event(
        &mut self,
        method: &str,
        params: Value,
        id: Option<Value>,
    ) -> Result<Option<(String, Value)>> {
        match method {
            "request" => {
                let id = id
                    .filter(Value::is_string)
                    .ok_or("запрос Claude Code без идентификатора")?;
                if !["permission", "question", "elicitation"]
                    .contains(&params["kind"].as_str().unwrap_or(""))
                {
                    return Err("неподдерживаемый или устаревший запрос Claude Code".into());
                }
                if self.stopping {
                    return Ok(None);
                }
                if self
                    .requests
                    .insert(id.as_str().unwrap().into(), params.clone())
                    .is_some()
                {
                    return Err("повторный запрос Claude Code".into());
                }
                self.emit(
                    "request",
                    Some(self.active_state()),
                    json!({"requestId":id,"method":params["kind"],"params":params}),
                )?;
            }
            "request_cancelled" => {
                if self
                    .requests
                    .remove(
                        params["requestId"]
                            .as_str()
                            .ok_or("отмена запроса Claude Code без идентификатора")?,
                    )
                    .is_some()
                {
                    self.emit(
                        "request_resolved",
                        Some(self.active_state()),
                        json!({"requestId":params["requestId"],"cancelled":true}),
                    )?;
                }
            }
            "failed" => {
                return Err(params["message"]
                    .as_str()
                    .unwrap_or("ошибка процесса Claude Code")
                    .into())
            }
            "session_title" => self.record("session_title", None, |tx| {
                crate::conversations::update_native_title(
                    tx,
                    &self.context.session_id,
                    &params["title"],
                )?;
                Ok(json!({"title":params["title"]}))
            })?,
            "message" => return self.sdk_message(&params["message"]),
            _ => return Err("неизвестное событие Claude Code".into()),
        }
        Ok(None)
    }

    fn sdk_message(&mut self, message: &Value) -> Result<Option<(String, Value)>> {
        if let Some(id) = message["session_id"].as_str().filter(|s| !s.is_empty()) {
            if self
                .native_id
                .as_deref()
                .is_some_and(|expected| expected != id)
            {
                return Err("Claude Code вернул другой разговор при продолжении".into());
            }
        }
        match message["type"].as_str() {
            Some("system") if message["subtype"] == "init" => {
                if self.initialized {
                    return Err("повторная инициализация разговора Claude Code".into());
                }
                let id = message["session_id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Claude Code не вернул идентификатор разговора")?;
                self.record("session_started", Some(self.active_state()), |tx| {
                    tx.execute(
                        "UPDATE sessions SET external_id=?2 WHERE id=?1",
                        params![self.context.session_id, id],
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(message.clone())
                })?;
                self.native_id = Some(id.into());
                self.initialized = true;
                self.record("message", None, |tx| {
                    crate::conversations::record_user_message(tx, &self.context, self.params["input"].as_array().unwrap(), self.draft.as_deref())
                })?;
            }
            Some("stream_event") => {
                let event = &message["event"];
                match event["type"].as_str() {
                    Some("message_start") => {
                        self.completed_text.clear();
                        self.current_message = Some(
                            event["message"]["id"]
                                .as_str()
                                .ok_or("сообщение Claude Code без идентификатора")?
                                .into(),
                        );
                    }
                    Some("content_block_start") if event["content_block"]["type"] == "tool_use" => {
                        self.action(&event["content_block"])?
                    }
                    Some("content_block_start") if event["content_block"]["type"] == "text" => {
                        let id = self
                            .current_message
                            .clone()
                            .ok_or("частичный ответ Claude Code без сообщения")?;
                        self.message(
                            &id,
                            event["content_block"]["text"]
                                .as_str()
                                .ok_or("частичный ответ Claude Code без текста")?,
                            true,
                        )?;
                    }
                    Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                        let id = self
                            .current_message
                            .clone()
                            .ok_or("частичный ответ Claude Code без сообщения")?;
                        self.message(
                            &id,
                            event["delta"]["text"]
                                .as_str()
                                .ok_or("частичный ответ Claude Code без текста")?,
                            true,
                        )?;
                    }
                    _ => self.emit("action_output", None, event.clone())?,
                }
            }
            Some("assistant") => {
                let id = message["message"]["id"]
                    .as_str()
                    .ok_or("сообщение Claude Code без идентификатора")?;
                let blocks = message["message"]["content"]
                    .as_array()
                    .ok_or("сообщение Claude Code без содержимого")?;
                if blocks.iter().any(|b| b["type"] == "text") {
                    let text = blocks
                        .iter()
                        .filter(|b| b["type"] == "text")
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("");
                    if self.current_message.as_deref() != Some(id) {
                        self.current_message = Some(id.into());
                        self.completed_text.clear();
                    }
                    let text = format!("{}{text}", self.completed_text);
                    self.message(id, &text, false)?;
                    self.completed_text = text;
                }
                for block in blocks.iter().filter(|b| b["type"] == "tool_use") {
                    self.action(block)?;
                }
                if !message["error"].is_null() {
                    self.emit("error", None, message.clone())?;
                }
            }
            Some("user") => {
                if let Some(blocks) = message["message"]["content"].as_array() {
                    for block in blocks.iter().filter(|b| b["type"] == "tool_result") {
                        self.emit("action_completed", None, block.clone())?;
                    }
                }
            }
            Some("result") => {
                if !self.initialized {
                    return Err("Claude Code завершился без идентификатора разговора".into());
                }
                let interrupted = matches!(
                    message["terminal_reason"].as_str(),
                    Some("aborted_streaming" | "aborted_tools")
                );
                let state = if message["subtype"] != "success" {
                    "failed"
                } else if interrupted {
                    "interrupted"
                } else if message["subtype"] == "success" && message["is_error"] == false {
                    "completed"
                } else {
                    "failed"
                };
                return Ok(Some((state.into(), message.clone())));
            }
            Some(_) => self.emit("action_output", None, message.clone())?,
            None => return Err("сообщение Claude Code без типа".into()),
        }
        Ok(None)
    }
}

fn validate_reply(request: &Value, result: &Value) -> Result<()> {
    let valid = if request["kind"] == "elicitation" {
        result["action"]
            .as_str()
            .is_some_and(|s| ["accept", "decline", "cancel"].contains(&s))
            && (result["content"].is_null() || result["content"].is_object())
    } else {
        result.as_object().is_some_and(|r| {
            r.keys()
                .all(|k| ["behavior", "answers"].contains(&k.as_str()))
        }) && match result["behavior"].as_str() {
            Some("deny") => result.get("answers").is_none(),
            Some("allow") if request["kind"] == "question" => request["input"]["questions"]
                .as_array()
                .zip(result["answers"].as_object())
                .is_some_and(|(qs, answers)| {
                    qs.len() == answers.len()
                        && qs.iter().all(|q| {
                            q["question"]
                                .as_str()
                                .and_then(|q| answers.get(q))
                                .and_then(Value::as_str)
                                .is_some_and(|a| !a.trim().is_empty())
                        })
                }),
            Some("allow") => result.get("answers").is_none(),
            _ => false,
        }
    };
    if valid {
        Ok(())
    } else {
        Err("ответ не соответствует запросу Claude Code".into())
    }
}
