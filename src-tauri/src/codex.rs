use crate::{
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
    collections::HashMap,
    path::Path,
    process::Command,
    sync::{mpsc, Arc, Mutex, Weak},
    time::Duration,
};

pub type Publish = Arc<dyn Fn(&StoredEvent) -> Result<()> + Send + Sync>;

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

struct Request {
    method: String,
    params: Value,
}

struct Worker {
    core: Weak<Mutex<Core>>,
    context: Context,
    process: String,
    rpc: Rpc,
    control: mpsc::Receiver<Control>,
    publish: Publish,
    params: Value,
    settings: executor_settings::Settings,
    input: Vec<Value>,
    draft: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    messages: HashMap<String, i64>,
    requests: HashMap<String, Request>,
    stopping: bool,
    stop_answer: Option<mpsc::SyncSender<Result<()>>>,
    title_command: Option<Command>,
}

pub fn create_session(core: &Mutex<Core>, workspace_id: &str, title: &str) -> Result<Session> {
    let core = core.lock().map_err(|e| e.to_string())?;
    Target {
        workspace_id: workspace_id.into(),
        session_id: None,
        executor: "codex".into(),
    }
    .validate(&core.store, false)?;
    if title.trim().is_empty() {
        return Err("укажите название разговора".into());
    }
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.into(),
        executor: "codex".into(),
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
    publish: Publish,
) -> Result<Context> {
    let workspace = Target {
        workspace_id: workspace_id.into(),
        session_id: Some(session_id.into()),
        executor: "codex".into(),
    }
    .validate(&core.lock().map_err(|e| e.to_string())?.store, true)?;
    let available = executors::discover("codex", Path::new(&workspace.path));
    if available.state != "ready" {
        return Err(format!("{} {}", available.reason, available.action));
    }
    let mut command = Command::new(available.path.ok_or("Codex не найден")?);
    command
        .arg("app-server")
        .env_clear()
        .envs(executors::environment("codex"));
    start_command(core, workspace_id, session_id, input, draft, &mut command, publish)
}

pub(crate) fn start_command(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    session_id: &str,
    input: Vec<Value>,
    draft: Option<String>,
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
        executor: "codex".into(),
    };
    let workspace = target.validate(&guard.store, true)?;
    if guard
        .processes
        .codex
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
    let title_command = crate::session_titles::command(command, "codex");
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
    processes.codex.insert(
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
        rpc: Rpc::new(stdin, stdout),
        control,
        publish,
        params: executor_settings::codex_params(Path::new(&workspace.path), &settings),
        settings,
        input,
        draft,
        thread_id: session.external_id,
        turn_id: None,
        messages: HashMap::new(),
        requests: HashMap::new(),
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
        let handle = core
            .processes
            .codex
            .get(&context.run_id)
            .filter(|h| h.context == *context)
            .ok_or("запрос этого запуска больше не актуален")?;
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
            .map_err(|e| format!("событие Codex не сохранено: {e}"))?;
        if state.is_some_and(|s| ["completed", "failed", "error", "interrupted"].contains(&s))
            && !core.processes.contains(&self.process)
        {
            core.processes.codex.remove(&self.context.run_id);
        }
        drop(core);
        (self.publish)(&event)
    }

    fn emit(&self, kind: &str, state: Option<&str>, payload: Value) -> Result<()> {
        self.record(kind, state, |_| Ok(payload))
    }

    fn run(mut self) {
        let result = self.drive();
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
                    json!({"message":(result.as_ref().err().into_iter().chain(cleanup.as_ref().err()).cloned().collect::<Vec<_>>().join("; "))}),
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
                    .send(Err("сначала завершите процесс Codex".into()));
            }
        }
    }

    fn drive(&mut self) -> Result<(String, Value)> {
        self.emit("state", Some("starting"), json!({"state":"starting"}))?;
        self.rpc.request(
            "initialize",
            json!({"clientInfo":{"name":"yade","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":self.settings.work_mode.is_some()}}),
        )?;
        loop {
            match self.control.try_recv() {
                Ok(control) => {
                    if matches!(control.action, Action::Stop) {
                        self.emit("state", Some("stopping"), json!({"state":"stopping"}))?;
                        self.stop_answer = Some(control.answer);
                        return Ok(("interrupted".into(), json!({"reason":"process_stopped"})));
                    }
                    let result = self.apply(control.action);
                    let _ = control.answer.send(result);
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
                Packet::Response { method, result, .. } => self.response(&method, result?)?,
                Packet::Event { method, params, id } => {
                    if let Some(outcome) = self.event(&method, params, id)? {
                        return Ok(outcome);
                    }
                }
            }
        }
    }

    fn response(&mut self, method: &str, result: Value) -> Result<()> {
        match method {
            "initialize" => {
                self.rpc.send(json!({"method":"initialized"}))?;
                self.rpc
                    .request("account/read", json!({"refreshToken":false}))?;
            }
            "account/read" => {
                if result["account"]["type"] != "chatgpt" {
                    return Err("Codex требует штатного входа через ChatGPT".into());
                }
                self.rpc.request(
                    "config/read",
                    json!({"cwd":self.params["cwd"],"includeLayers":true}),
                )?;
            }
            "config/read" => {
                if result["config"]["model_provider"]
                    .as_str()
                    .is_some_and(|p| p != "openai")
                {
                    return Err("в штатной конфигурации Codex выбран другой поставщик".into());
                }
                if let Some(layers) = result["layers"].as_array() {
                    for layer in layers {
                        if let Some(reason) = layer["disabledReason"].as_str() {
                            self.emit("warning", None, json!({"message":reason}))?;
                        }
                    }
                }
                let mut params = self.params.clone();
                let method = if let Some(id) = &self.thread_id {
                    params["threadId"] = json!(id);
                    params["excludeTurns"] = json!(true);
                    "thread/resume"
                } else {
                    "thread/start"
                };
                self.rpc.request(method, params)?;
            }
            "thread/start" | "thread/resume" => {
                let id = result["thread"]["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Codex не вернул идентификатор разговора")?;
                if self
                    .thread_id
                    .as_deref()
                    .is_some_and(|expected| expected != id)
                {
                    return Err("Codex вернул другой разговор при продолжении".into());
                }
                for (key, accepted) in [
                    ("model", result["model"].clone()),
                    ("approvalPolicy", result["approvalPolicy"].clone()),
                    ("sandbox", result["sandbox"]["type"].clone()),
                ] {
                    if let Some(expected) = self.params.get(key) {
                        let actual = if key == "sandbox" {
                            match accepted.as_str() {
                                Some("readOnly") => json!("read-only"),
                                Some("workspaceWrite") => json!("workspace-write"),
                                Some("dangerFullAccess") => json!("danger-full-access"),
                                _ => accepted,
                            }
                        } else {
                            accepted
                        };
                        if *expected != actual {
                            return Err(format!("Codex не применил параметр {key}"));
                        }
                    }
                }
                self.record("session_started", None, |tx| {
                    tx.execute(
                        "UPDATE sessions SET external_id=?2 WHERE id=?1",
                        params![self.context.session_id, id],
                    )
                    .map_err(|e| e.to_string())?;
                    crate::conversations::update_native_title(
                        tx,
                        &self.context.session_id,
                        &result["thread"]["name"],
                    )?;
                    Ok(json!({"threadId":id,"operation":method}))
                })?;
                self.thread_id = Some(id.into());
                self.record("message", None, |tx| {
                    crate::conversations::record_user_message(tx, &self.context, &self.input, self.draft.as_deref())
                })?;
                let mut params = executor_settings::codex_turn_params(&self.settings, &result)?;
                params["threadId"] = json!(id);
                params["input"] = json!(self.input);
                self.rpc.request("turn/start", params)?;
            }
            "turn/start" => {
                let id = result["turn"]["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Codex не вернул идентификатор выполнения")?;
                self.bind_turn(id)?;
                self.emit(
                    "state",
                    Some(self.active_state()),
                    json!({"state":self.active_state(),"turnId":id}),
                )?;
            }
            "turn/interrupt" => {}
            _ => return Err("неожиданный ответ Codex".into()),
        }
        Ok(())
    }

    fn bind_turn(&mut self, id: &str) -> Result<()> {
        if self
            .turn_id
            .as_deref()
            .is_some_and(|expected| expected != id)
        {
            return Err("Codex вернул другое выполнение".into());
        }
        self.turn_id = Some(id.into());
        Ok(())
    }

    fn active_state(&self) -> &str {
        if self.stopping {
            "stopping"
        } else if self
            .requests
            .values()
            .any(|r| r.method != "item/tool/requestUserInput" || r.params["isBlocking"] != false)
        {
            "waiting"
        } else {
            "running"
        }
    }

    fn message(
        &mut self,
        item: &str,
        text: &str,
        append: bool,
        questions: Option<&Value>,
    ) -> Result<()> {
        let mut sequence = self.messages.get(item).copied();
        self.record(if append {"message_delta"} else {"message_completed"}, None, |tx| {
            if let Some(sequence) = sequence {
                tx.execute(if append {"UPDATE messages SET body=body || ?2 WHERE sequence=?1"} else {"UPDATE messages SET body=?2 WHERE sequence=?1"}, params![sequence,text]).map_err(|e| e.to_string())?;
            } else {
                tx.execute("INSERT INTO messages(session_id,run_id,role,body) VALUES(?1,?2,'assistant',?3)", params![self.context.session_id,self.context.run_id,text]).map_err(|e| e.to_string())?;
                sequence = Some(tx.last_insert_rowid());
            }
            Ok(json!({"sequence":sequence,"itemId":item,"text":text,"questions":questions}))
        })?;
        self.messages.insert(item.into(), sequence.unwrap());
        Ok(())
    }

    fn event(
        &mut self,
        method: &str,
        params: Value,
        id: Option<Value>,
    ) -> Result<Option<(String, Value)>> {
        if let Some(id) = id {
            self.server_request(method, params, id)?;
            return Ok(None);
        }
        if params["threadId"].as_str() != self.thread_id.as_deref() || self.thread_id.is_none() {
            return Ok(None);
        }
        if method == "thread/name/updated" {
            self.record("session_title", None, |tx| {
                crate::conversations::update_native_title(
                    tx,
                    &self.context.session_id,
                    &params["threadName"],
                )?;
                Ok(json!({"title":params["threadName"]}))
            })?;
            return Ok(None);
        }
        if method == "serverRequest/resolved" {
            if self
                .requests
                .remove(&params["requestId"].to_string())
                .is_some()
            {
                self.emit(
                    "request_resolved",
                    Some(self.active_state()),
                    json!({"requestId":params["requestId"]}),
                )?;
            }
            return Ok(None);
        }
        if method == "turn/started" {
            let id = params["turn"]["id"]
                .as_str()
                .ok_or("событие Codex без выполнения")?;
            self.bind_turn(id)?;
            self.emit(
                "state",
                Some(self.active_state()),
                json!({"state":self.active_state(),"turnId":id}),
            )?;
            return Ok(None);
        }
        let turn_id = if method == "turn/completed" {
            params["turn"]["id"].as_str()
        } else {
            params["turnId"].as_str()
        };
        if turn_id != self.turn_id.as_deref() || self.turn_id.is_none() {
            return Ok(None);
        }
        match method {
            "turn/completed" => {
                let state = match params["turn"]["status"].as_str() {
                    Some("completed") if params["turn"]["error"].is_null() => "completed",
                    Some("completed" | "failed") => "failed",
                    Some("interrupted") => "interrupted",
                    _ => return Err("Codex сообщил неизвестный итог выполнения".into()),
                };
                self.requests.clear();
                return Ok(Some((state.into(), params["turn"].clone())));
            }
            "item/agentMessage/delta" => {
                let id = params["itemId"]
                    .as_str()
                    .ok_or("сообщение Codex без идентификатора")?;
                let text = params["delta"]
                    .as_str()
                    .ok_or("сообщение Codex без текста")?;
                self.message(id, text, true, None)?;
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let id = item["id"]
                    .as_str()
                    .ok_or("действие Codex без идентификатора")?;
                match item["type"].as_str() {
                    Some("agentMessage") => {
                        self.message(
                            id,
                            item["text"].as_str().ok_or("сообщение Codex без текста")?,
                            method == "item/started",
                            item.get("questions"),
                        )?;
                    }
                    Some("userMessage") => {}
                    Some(_) => self.emit(
                        if method == "item/started" {
                            "action_started"
                        } else {
                            "action_completed"
                        },
                        None,
                        item.clone(),
                    )?,
                    None => return Err("действие Codex без типа".into()),
                }
            }
            "error" => {
                self.emit("error", None, params.clone())?;
                if params["willRetry"] != true {
                    return Err(params["error"]["message"]
                        .as_str()
                        .unwrap_or("ошибка выполнения Codex")
                        .into());
                }
            }
            "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "item/mcpToolCall/progress"
            | "turn/plan/updated"
            | "turn/diff/updated"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta" => self.emit(
                "action_output",
                None,
                json!({"method":method,"params":params}),
            )?,
            _ => {}
        }
        Ok(None)
    }

    fn server_request(&mut self, method: &str, params: Value, id: Value) -> Result<()> {
        let supported = matches!(
            method,
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
                | "item/tool/requestUserInput"
                | "mcpServer/elicitation/request"
        );
        let matches = params["threadId"].as_str() == self.thread_id.as_deref()
            && self.thread_id.is_some()
            && ((method == "mcpServer/elicitation/request" && params["turnId"].is_null())
                || (self.turn_id.is_some()
                    && params["turnId"].as_str() == self.turn_id.as_deref()));
        if !supported || !matches || self.stopping {
            self.rpc.send(json!({"id":id,"error":{"code":-32601,"message":"запрос не поддерживается или больше не актуален"}}))?;
            return self.emit(
                "warning",
                None,
                json!({"message":"запрос Codex отклонён","method":method}),
            );
        }
        let key = id.to_string();
        if self.requests.contains_key(&key) {
            return Err("повторный запрос разрешения Codex".into());
        }
        self.requests.insert(
            key,
            Request {
                method: method.into(),
                params: params.clone(),
            },
        );
        self.emit(
            "request",
            Some(self.active_state()),
            json!({"requestId":id,"method":method,"params":params}),
        )
    }

    fn apply(&mut self, action: Action) -> Result<()> {
        match action {
            Action::Reply { id, result } => {
                if self.stopping {
                    return Err("запрос больше не актуален: идёт остановка".into());
                }
                let key = id.to_string();
                let request = self.requests.get(&key).ok_or("запрос больше не актуален")?;
                validate_reply(request, &result)?;
                self.emit(
                    "request_answer",
                    None,
                    json!({"requestId":id,"result":result}),
                )?;
                self.rpc.send(json!({"id":id,"result":result}))?;
                self.requests.remove(&key);
                self.emit(
                    "request_resolved",
                    Some(self.active_state()),
                    json!({"requestId":id}),
                )
            }
            Action::Interrupt => {
                if self.stopping {
                    return Err("остановка уже запрошена".into());
                }
                let id = self
                    .turn_id
                    .clone()
                    .ok_or("Codex ещё не начал выполнение; можно завершить процесс")?;
                self.emit("state", Some("stopping"), json!({"state":"stopping"}))?;
                self.stopping = true;
                self.requests.clear();
                self.rpc
                    .request(
                        "turn/interrupt",
                        json!({"threadId":self.thread_id,"turnId":id}),
                    )
                    .map(|_| ())
            }
            Action::Stop => unreachable!(),
        }
    }
}

fn validate_reply(request: &Request, result: &Value) -> Result<()> {
    if (matches!(
        request.method.as_str(),
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
    ) && result["decision"] == "acceptForSession")
        || (request.method == "item/permissions/requestApproval" && result["scope"] == "session")
    {
        return Err(
            "разрешение на всю сессию не поддерживается: процесс завершается после каждого хода"
                .into(),
        );
    }
    let valid = match request.method.as_str() {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            result.as_object().is_some_and(|v| v.len() == 1)
                && result["decision"]
                    .as_str()
                    .is_some_and(|s| ["accept", "decline", "cancel"].contains(&s))
        }
        "item/permissions/requestApproval" => {
            result["permissions"].is_object()
                && subset(&result["permissions"], &request.params["permissions"])
                && (result["scope"].is_null() || result["scope"] == "turn")
                && result.as_object().is_some_and(|v| {
                    v.keys()
                        .all(|k| ["permissions", "scope"].contains(&k.as_str()))
                })
        }
        "item/tool/requestUserInput" => result["answers"].as_object().is_some_and(|answers| {
            answers.iter().all(|(key, answer)| {
                request.params["questions"]
                    .as_array()
                    .is_some_and(|q| q.iter().any(|q| q["id"] == *key))
                    && answer["answers"]
                        .as_array()
                        .is_some_and(|values| values.iter().all(Value::is_string))
            })
        }),
        "mcpServer/elicitation/request" => {
            result["action"]
                .as_str()
                .is_some_and(|s| ["accept", "decline", "cancel"].contains(&s))
                && (result["content"].is_null() || result["content"].is_object())
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("ответ не соответствует запросу Codex".into())
    }
}

fn subset(granted: &Value, requested: &Value) -> bool {
    match granted {
        Value::Object(values) => values.iter().all(|(key, value)| {
            value.is_null() || requested.get(key).is_some_and(|r| subset(value, r))
        }),
        Value::Array(values) => requested
            .as_array()
            .is_some_and(|r| values.iter().all(|v| r.contains(v))),
        Value::Null => true,
        _ => granted == requested,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_permissions_are_rejected_without_resolving_the_request() {
        for (method, response) in [
            (
                "item/commandExecution/requestApproval",
                json!({"decision":"acceptForSession"}),
            ),
            (
                "item/fileChange/requestApproval",
                json!({"decision":"acceptForSession"}),
            ),
            (
                "item/permissions/requestApproval",
                json!({"permissions":{},"scope":"session"}),
            ),
        ] {
            let (_, control) = mpsc::sync_channel(1);
            let mut worker = Worker {
                core: Weak::new(),
                context: Context {
                    workspace_id: "workspace".into(),
                    session_id: "session".into(),
                    run_id: "run".into(),
                },
                process: "process".into(),
                rpc: Rpc::new(Vec::new(), std::io::Cursor::new(Vec::new())),
                control,
                publish: Arc::new(|_| Ok(())),
                params: json!({}),
                settings: executor_settings::Settings::default(),
                input: Vec::new(),
                draft: None,
                thread_id: Some("thread".into()),
                turn_id: Some("turn".into()),
                messages: HashMap::new(),
                requests: HashMap::from([(
                    json!("approval").to_string(),
                    Request {
                        method: method.into(),
                        params: json!({"permissions":{}}),
                    },
                )]),
                stopping: false,
                stop_answer: None,
                title_command: None,
            };
            assert!(worker
                .apply(Action::Reply {
                    id: json!("approval"),
                    result: response,
                })
                .unwrap_err()
                .contains("разрешение на всю сессию не поддерживается"));
            let request = &worker.requests[&json!("approval").to_string()];
            if method == "item/permissions/requestApproval" {
                for response in [
                    json!({"permissions":{}}),
                    json!({"permissions":{},"scope":"turn"}),
                ] {
                    assert!(validate_reply(request, &response).is_ok());
                }
            } else {
                for decision in ["accept", "decline", "cancel"] {
                    assert!(validate_reply(request, &json!({"decision":decision})).is_ok());
                }
            }
        }
    }

    #[test]
    fn permission_grants_cannot_expand_the_requested_access() {
        let request = Request {
            method: "item/permissions/requestApproval".into(),
            params: json!({"permissions":{"network":{"enabled":true},"fileSystem":{"write":["/tmp/allowed"]}}}),
        };
        assert!(validate_reply(&request, &json!({"permissions":{},"scope":"turn"})).is_ok());
        assert!(validate_reply(
            &request,
            &json!({"permissions":{"fileSystem":{"write":["/tmp/allowed"]}},"scope":"turn"})
        )
        .is_ok());
        assert!(validate_reply(
            &request,
            &json!({"permissions":{"fileSystem":{"write":["/private"]}}})
        )
        .is_err());
        assert!(validate_reply(
            &request,
            &json!({"permissions":{"network":{"enabled":true}},"scope":"forever"})
        )
        .is_err());
        assert!(validate_reply(&request, &json!({"permissions":{"unknown":true}})).is_err());
        let request = Request {
            method: "item/tool/requestUserInput".into(),
            params: json!({"questions":[{"id":"q"}]}),
        };
        assert!(validate_reply(&request, &json!({"answers":{"q":{"answers":["ответ"]}}})).is_ok());
        assert!(validate_reply(
            &request,
            &json!({"answers":{"foreign":{"answers":["ответ"]}}})
        )
        .is_err());
        assert!(validate_reply(&request, &json!({"answers":{"q":{"answers":[true]}}})).is_err());
    }
}
