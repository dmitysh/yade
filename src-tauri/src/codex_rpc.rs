use crate::store::Result;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    time::{Duration, Instant},
};

const MAX_PACKET: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum Packet {
    Response {
        id: u64,
        method: String,
        result: Result<Value>,
    },
    Event {
        method: String,
        params: Value,
        id: Option<Value>,
    },
}

pub(crate) struct Rpc {
    name: &'static str,
    input: SyncSender<Vec<u8>>,
    output: Receiver<Result<Value>>,
    pending: HashMap<u64, (String, Instant)>,
    next_id: u64,
    write_failed: bool,
}

impl Rpc {
    pub fn new(input: impl Write + Send + 'static, output: impl Read + Send + 'static) -> Self {
        Self::with_name("Codex", input, output)
    }

    pub fn with_name(
        name: &'static str,
        input: impl Write + Send + 'static,
        output: impl Read + Send + 'static,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (input_sender, input_receiver) = mpsc::sync_channel::<Vec<u8>>(16);
        let errors = sender.clone();
        std::thread::spawn(move || {
            let mut input = input;
            while let Ok(bytes) = input_receiver.recv() {
                if let Err(error) = input.write_all(&bytes).and_then(|_| input.flush()) {
                    let _ = errors.send(Err(format!("ошибка записи {name}: {error}")));
                    return;
                }
            }
        });
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                let packet = match (&mut reader)
                    .take(MAX_PACKET + 1)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => Err(format!("соединение {name} закрыто")),
                    Ok(_) if bytes.len() as u64 > MAX_PACKET => {
                        Err(format!("слишком большой пакет {name}"))
                    }
                    Ok(_) if bytes.last() != Some(&b'\n') => {
                        Err(format!("поток {name} закрыт посреди пакета"))
                    }
                    Ok(_) => serde_json::from_slice(&bytes)
                        .map_err(|_| format!("повреждённый пакет {name}")),
                    Err(e) => Err(format!("ошибка чтения {name}: {e}")),
                };
                let failed = packet.is_err();
                if sender.send(packet).is_err() || failed {
                    return;
                }
            }
        });
        Self {
            name,
            input: input_sender,
            output: receiver,
            pending: HashMap::new(),
            next_id: 0,
            write_failed: false,
        }
    }

    pub fn send(&mut self, packet: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
        if bytes.len() as u64 >= MAX_PACKET {
            return Err(format!("слишком большой пакет {}", self.name));
        }
        bytes.push(b'\n');
        let result = self.input.try_send(bytes).map_err(|error| match error {
            TrySendError::Full(_) => format!("очередь записи {} занята", self.name),
            TrySendError::Disconnected(_) => format!("поток ввода {} закрыт", self.name),
        });
        self.write_failed |= result.is_err();
        result
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id": id, "method": method, "params": params}))?;
        self.pending.insert(id, (method.into(), Instant::now()));
        Ok(id)
    }

    pub fn receive(&mut self, timeout: Duration) -> Result<Option<Packet>> {
        if self.write_failed {
            return Err(format!("поток ввода {} закрыт", self.name));
        }
        if let Some((method, _)) = self
            .pending
            .values()
            .find(|(_, start)| start.elapsed() >= Duration::from_secs(30))
        {
            return Err(format!("{} не подтвердил {method} вовремя", self.name));
        }
        let value = match self.output.recv_timeout(timeout) {
            Ok(packet) => packet?,
            Err(RecvTimeoutError::Timeout) => return Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!("соединение {} закрыто", self.name))
            }
        };
        if !value.is_object() {
            return Err(format!("некорректный пакет {}", self.name));
        }
        if let Some(method) = value.get("method") {
            let method = method
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("некорректный метод {}", self.name))?;
            if value.get("result").is_some() || value.get("error").is_some() {
                return Err(format!("некорректное событие {}", self.name));
            }
            let id = value.get("id").cloned();
            if id
                .as_ref()
                .is_some_and(|id| !id.is_string() && !id.is_i64())
            {
                return Err(format!("некорректный идентификатор запроса {}", self.name));
            }
            return Ok(Some(Packet::Event {
                method: method.into(),
                params: value["params"].clone(),
                id,
            }));
        }
        let id = value["id"]
            .as_u64()
            .ok_or_else(|| format!("ответ {} без идентификатора", self.name))?;
        let (method, _) = self
            .pending
            .remove(&id)
            .ok_or_else(|| format!("ответ {} на неизвестный запрос", self.name))?;
        let result = match (value.get("result"), value.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) if error["code"].is_i64() && error["message"].is_string() => {
                Err(format!(
                    "{} отклонил {method}: {}",
                    self.name,
                    error["message"].as_str().unwrap()
                ))
            }
            _ => {
                return Err(format!(
                    "ответ {} не содержит результат или ошибку",
                    self.name
                ))
            }
        };
        Ok(Some(Packet::Response { id, method, result }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn responses_are_correlated_even_when_reordered() {
        let mut rpc = Rpc::new(Vec::new(), Cursor::new(b"{\"id\":2,\"result\":\"second\"}\n{\"method\":\"progress\",\"params\":{}}\n{\"id\":1,\"error\":{\"code\":-1,\"message\":\"denied\"}}\n"));
        rpc.request("first", json!({})).unwrap();
        rpc.request("second", json!({})).unwrap();
        assert!(
            matches!(rpc.receive(Duration::from_secs(1)).unwrap(), Some(Packet::Response {id: 2,method,result: Ok(value)}) if method=="second" && value=="second")
        );
        assert!(
            matches!(rpc.receive(Duration::from_secs(1)).unwrap(), Some(Packet::Event {method,..}) if method=="progress")
        );
        assert!(
            matches!(rpc.receive(Duration::from_secs(1)).unwrap(), Some(Packet::Response {id: 1,method,result: Err(error)}) if method=="first" && error.contains("denied"))
        );
        assert!(rpc
            .receive(Duration::from_secs(1))
            .unwrap_err()
            .contains("закрыто"));
    }

    #[cfg(unix)]
    #[test]
    fn split_utf8_and_multiple_packets_are_framed_by_newlines() {
        let (output, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut rpc = Rpc::new(Vec::new(), output);
        let text = "{\"method\":\"текст\"}\n{\"method\":\"next\"}\n".as_bytes();
        for byte in &text[..15] {
            server.write_all(&[*byte]).unwrap();
        }
        assert!(rpc.receive(Duration::from_millis(20)).unwrap().is_none());
        server.write_all(&text[15..]).unwrap();
        assert!(
            matches!(rpc.receive(Duration::from_secs(1)).unwrap(), Some(Packet::Event {method,..}) if method=="текст")
        );
        assert!(
            matches!(rpc.receive(Duration::from_secs(1)).unwrap(), Some(Packet::Event {method,..}) if method=="next")
        );
    }

    #[test]
    fn invalid_packets_and_truncated_stream_are_errors() {
        for text in [
            "not json\n",
            "[]\n",
            "{\"id\":9,\"result\":{}}\n",
            "{\"method\":2}\n",
            "{\"method\":\"event\",\"id\":null}\n",
            "{\"method\":\"event\"}",
        ] {
            let mut rpc = Rpc::new(Vec::new(), Cursor::new(text.as_bytes().to_vec()));
            assert!(rpc.receive(Duration::from_secs(1)).is_err(), "{text}");
        }
        let mut rpc = Rpc::new(Vec::new(), Cursor::new(vec![b'x'; MAX_PACKET as usize + 1]));
        assert!(rpc
            .receive(Duration::from_secs(1))
            .unwrap_err()
            .contains("большой"));
    }

    #[cfg(unix)]
    #[test]
    fn closed_input_and_unanswered_rpc_are_errors() {
        let (input, server) = std::os::unix::net::UnixStream::pair().unwrap();
        drop(server);
        let (output, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut rpc = Rpc::new(input, output);
        rpc.send(json!({"method":"initialized"})).unwrap();
        assert!(rpc
            .receive(Duration::from_secs(1))
            .unwrap_err()
            .contains("ошибка записи"));
        let mut rpc = Rpc::new(Vec::new(), Cursor::new(Vec::new()));
        rpc.request("initialize", json!({})).unwrap();
        rpc.pending.get_mut(&1).unwrap().1 = Instant::now() - Duration::from_secs(31);
        assert!(rpc
            .receive(Duration::ZERO)
            .unwrap_err()
            .contains("initialize вовремя"));
    }

    #[cfg(unix)]
    #[test]
    fn blocked_writer_has_a_bounded_nonblocking_queue() {
        let (input, server) = std::os::unix::net::UnixStream::pair().unwrap();
        let (output, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut rpc = Rpc::new(input, output);
        rpc.send(json!({"text":"x".repeat(1024 * 1024)})).unwrap();
        let started = Instant::now();
        let error = (0..32)
            .find_map(|_| rpc.send(json!({"method":"queued"})).err())
            .expect("очередь заблокированной записи должна заполниться");
        assert!(error.contains("очередь записи"));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(rpc.receive(Duration::ZERO).is_err());
        drop(server);
    }

    #[cfg(unix)]
    #[test]
    fn stdio_process_is_registered_with_its_run_and_workspace() {
        use crate::{model::*, processes::Processes, store::Store};
        let temp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&temp.path().join("state.db")).unwrap();
        store.register_folder("Проект", temp.path(), None).unwrap();
        let context = Context {
            workspace_id: store.snapshot().unwrap().workspaces[0].id.clone(),
            session_id: "session".into(),
            run_id: "run".into(),
        };
        store
            .insert_session(&Session {
                id: context.session_id.clone(),
                workspace_id: context.workspace_id.clone(),
                executor: "codex".into(),
                external_id: None,
                title: "Разговор".into(),
                state: "running".into(),
                last_activity_at: 0,
            })
            .unwrap();
        store
            .insert_run(&Run {
                id: context.run_id.clone(),
                session_id: context.session_id.clone(),
                state: "running".into(),
            })
            .unwrap();
        let mut processes = Processes::default();
        let (id, input, output) = processes
            .spawn_stdio(
                &store,
                &context,
                &mut std::process::Command::new("/bin/cat"),
            )
            .unwrap();
        assert_eq!(processes.count(), 1);
        let mut rpc = Rpc::new(input, output);
        rpc.send(json!({"method":"echo","params":{"text":"stdio"}}))
            .unwrap();
        assert!(
            matches!(rpc.receive(Duration::from_secs(1)).unwrap(), Some(Packet::Event {params,..}) if params["text"]=="stdio")
        );
        processes.stop(&store, &context, &id).unwrap();
        assert_eq!(processes.count(), 0);
        assert!(rpc.receive(Duration::from_secs(1)).is_err());
        let state: String = store
            .connection
            .query_row("SELECT state FROM processes WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(state, "stopped");
    }
}
