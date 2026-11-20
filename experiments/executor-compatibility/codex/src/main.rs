use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use std::{env, thread};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

struct Connection {
    child: Child,
    input: ChildStdin,
    output: Receiver<std::result::Result<Value, String>>,
    next_id: u64,
    thread_id: Option<String>,
    turn_id: Option<String>,
    decision: String,
    completed: Option<Value>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Connection {
    fn open(cwd: &str, decision: String) -> Result<Self> {
        let executable = env::var("YADE_CODEX_BIN").unwrap_or_else(|_| "codex".into());
        let mut child = Command::new(executable)
            .arg("app-server")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("spawn_failed: {error}"))?;
        let input = child.stdin.take().ok_or("stdin_unavailable")?;
        let stdout = child.stdout.take().ok_or("stdout_unavailable")?;
        let (sender, output) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let packet = line
                    .map_err(|error| format!("read_failed: {error}"))
                    .and_then(|line| {
                        serde_json::from_str(&line)
                            .map_err(|error| format!("invalid_packet: {error}"))
                    });
                let failed = packet.is_err();
                if sender.send(packet).is_err() || failed {
                    return;
                }
            }
        });
        Ok(Self {
            child,
            input,
            output,
            next_id: 0,
            thread_id: None,
            turn_id: None,
            decision,
            completed: None,
        })
    }

    fn send(&mut self, packet: Value) -> Result<()> {
        serde_json::to_writer(&mut self.input, &packet)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if Instant::now() >= deadline {
                return Err(format!("request_timeout: {method}").into());
            }
            if let Some(packet) = self.receive()? {
                if packet.get("method").is_none() && packet["id"] == id {
                    if let Some(error) = packet.get("error") {
                        return Err(format!("rpc_failed: {method}: {error}").into());
                    }
                    return Ok(packet["result"].clone());
                }
                self.event(&packet)?;
            }
        }
    }

    fn receive(&self) -> Result<Option<Value>> {
        match self.output.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(packet)) => Ok(Some(packet)),
            Ok(Err(error)) => Err(error.into()),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("connection_closed".into()),
        }
    }

    fn event(&mut self, packet: &Value) -> Result<()> {
        println!("{packet}");
        if packet["method"] == "turn/completed" {
            self.completed = Some(packet.clone());
        }
        if packet.get("method").is_some() && packet.get("id").is_some() {
            let response = approval_response(
                packet,
                self.thread_id.as_deref(),
                self.turn_id.as_deref(),
                &self.decision,
            );
            self.send(response)?;
        }
        Ok(())
    }
}

fn approval_response(
    packet: &Value,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    decision: &str,
) -> Value {
    let params = &packet["params"];
    let same_context = params["threadId"].as_str() == thread_id
        && params["turnId"].as_str() == turn_id
        && thread_id.is_some()
        && turn_id.is_some();
    match packet["method"].as_str() {
        Some("item/commandExecution/requestApproval" | "item/fileChange/requestApproval") => {
            json!({"id": packet["id"], "result": {
                "decision": if same_context { decision } else { "decline" }
            }})
        }
        Some("item/permissions/requestApproval") => {
            json!({"id": packet["id"], "result": {"permissions": {}, "scope": "turn"}})
        }
        _ => json!({"id": packet["id"], "error": {
            "code": -32601, "message": "unsupported_request"
        }}),
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        return Err(
            "Использование: codex-compatibility <папка> <сообщение> [идентификатор разговора]"
                .into(),
        );
    }
    let cwd = std::fs::canonicalize(&args[0])?;
    if !cwd.is_dir() {
        return Err("Рабочая папка отсутствует".into());
    }
    let cwd = cwd.to_str().ok_or("invalid_cwd")?;
    let decision = env::var("YADE_APPROVAL").unwrap_or_else(|_| "decline".into());
    if decision != "accept" && decision != "decline" {
        return Err("YADE_APPROVAL: ожидается accept или decline".into());
    }
    let interrupt_after = env::var("YADE_INTERRUPT_AFTER_MS")
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()?
        .map(Duration::from_millis);
    let mut connection = Connection::open(cwd, decision)?;
    connection.request(
        "initialize",
        json!({"clientInfo": {
            "name": "yade_compatibility", "version": "0.1.0"
        }}),
    )?;
    connection.send(json!({"method": "initialized"}))?;
    let account = connection.request("account/read", json!({"refreshToken": false}))?;
    println!("{}", json!({"accountType": account["account"]["type"]}));
    if account["account"]["type"] != "chatgpt" {
        return Err("subscription_login_required".into());
    }
    let config = connection.request("config/read", json!({"cwd": cwd, "includeLayers": true}))?;
    let sources: Vec<&Value> = config["layers"]
        .as_array()
        .ok_or("missing_config_layers")?
        .iter()
        .filter(|layer| layer["disabledReason"].is_null())
        .map(|layer| &layer["name"])
        .collect();
    let disabled_sources: Vec<Value> = config["layers"]
        .as_array()
        .ok_or("missing_config_layers")?
        .iter()
        .filter(|layer| !layer["disabledReason"].is_null())
        .map(|layer| json!({"source": layer["name"], "reason": layer["disabledReason"]}))
        .collect();
    println!(
        "{}",
        json!({"configSources": sources, "disabledConfigSources": disabled_sources})
    );
    let mut params = json!({"cwd": cwd});
    if let Ok(policy) = env::var("YADE_APPROVAL_POLICY") {
        params["approvalPolicy"] = json!(policy);
        params["approvalsReviewer"] = json!("user");
        params["sandbox"] = json!("read-only");
    }
    let method = if let Some(id) = args.get(2) {
        params["threadId"] = json!(id);
        params["excludeTurns"] = json!(true);
        "thread/resume"
    } else {
        "thread/start"
    };
    let result = connection.request(method, params)?;
    let thread_id = result["thread"]["id"].as_str().ok_or("missing_thread_id")?;
    if args.get(2).is_some_and(|expected| expected != thread_id) {
        return Err("resume_thread_mismatch".into());
    }
    connection.thread_id = Some(thread_id.into());
    println!(
        "{}",
        json!({
            "threadId": thread_id, "operation": method,
            "model": result["model"], "reasoningEffort": result["reasoningEffort"],
            "instructionSources": result["instructionSources"]
        })
    );
    let input = if let Ok(input) = env::var("YADE_INPUT_JSON") {
        serde_json::from_str::<Value>(&input)?
    } else {
        json!([{"type": "text", "text": args[1]}])
    };
    let result = connection.request(
        "turn/start",
        json!({
            "threadId": thread_id, "input": input
        }),
    )?;
    connection.turn_id = Some(
        result["turn"]["id"]
            .as_str()
            .ok_or("missing_turn_id")?
            .into(),
    );
    let started = Instant::now();
    let mut interrupted = false;
    loop {
        if let Some(packet) = connection.completed.take() {
            if packet["params"]["threadId"].as_str() != connection.thread_id.as_deref()
                || packet["params"]["turn"]["id"].as_str() != connection.turn_id.as_deref()
            {
                return Err("turn_context_mismatch".into());
            }
            let status = &packet["params"]["turn"]["status"];
            return if status == "completed" || (interrupted && status == "interrupted") {
                Ok(())
            } else {
                Err(format!("turn_failed: {}", packet["params"]["turn"]).into())
            };
        }
        if started.elapsed() > Duration::from_secs(120) {
            return Err("turn_timeout".into());
        }
        if !interrupted && interrupt_after.is_some_and(|after| started.elapsed() >= after) {
            connection.request(
                "turn/interrupt",
                json!({
                    "threadId": connection.thread_id, "turnId": connection.turn_id
                }),
            )?;
            interrupted = true;
        }
        if let Some(packet) = connection.receive()? {
            connection.event(&packet)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_cannot_authorize_another_turn() {
        let packet = json!({"id": 17, "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "first", "turnId": "old"}});
        let response = approval_response(&packet, Some("first"), Some("new"), "accept");
        assert_eq!(response["id"], 17);
        assert_eq!(response["result"]["decision"], "decline");
        let response = approval_response(&packet, Some("first"), Some("old"), "accept");
        assert_eq!(response["result"]["decision"], "accept");
    }
}
