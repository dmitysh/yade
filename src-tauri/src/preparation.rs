use crate::{core::Core, store::Result};
use std::{
    io::Read,
    process::Command,
    sync::{
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};

#[cfg(unix)]
pub fn start(core: Arc<Mutex<Core>>, workspace_id: &str) -> Result<()> {
    let workspace_id = workspace_id.to_string();
    let (id, stdout, stderr) = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let workspace = core.store.workspace(&workspace_id)?;
        if workspace.preparation_state != "pending" {
            return Ok(());
        }
        let command = workspace
            .preparation_command
            .ok_or("команда подготовки отсутствует")?;
        core.store
            .preparation_output(&workspace_id, "", "running")?;
        let Core { store, processes } = &mut *core;
        match processes.spawn_preparation(
            store,
            &workspace_id,
            Command::new("/bin/sh").args(["-c", &command]),
        ) {
            Ok(process) => process,
            Err(error) => {
                store.preparation_output(&workspace_id, &error, "failed")?;
                return Ok(());
            }
        }
    };
    let (sender, receiver) = sync_channel(16);
    let errors = sender.clone();
    std::thread::spawn(move || pump(stdout, sender));
    std::thread::spawn(move || pump(stderr, errors));
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let mut read_error = None;
            for part in receiver {
                let text = match part {
                    Ok(text) => text,
                    Err(error) => {
                        read_error = Some(error.clone());
                        error
                    }
                };
                core.lock()
                    .map_err(|e| e.to_string())?
                    .store
                    .preparation_output(&workspace_id, &text, "running")?;
            }
            loop {
                {
                    let mut core = core.lock().map_err(|e| e.to_string())?;
                    let Core { store, processes } = &mut *core;
                    if let Some(status) = processes.preparation_exit(store, &id)? {
                        let state = if status.success() && read_error.is_none() {
                            "completed"
                        } else {
                            "failed"
                        };
                        store.preparation_output(
                            &workspace_id,
                            &format!("\nРезультат: {status}\n"),
                            state,
                        )?;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(())
        })();
        if let Err(error) = result {
            if let Ok(core) = core.lock() {
                let _ = core
                    .store
                    .preparation_output(&workspace_id, &error, "failed");
            }
            eprintln!("{error}");
        }
    });
    Ok(())
}

fn pump(mut reader: impl Read, sender: SyncSender<Result<String>>) {
    let mut buffer = [0; 4096];
    let mut pending = Vec::new();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                if !pending.is_empty() {
                    let _ = sender.send(Ok(String::from_utf8_lossy(&pending).into()));
                }
                break;
            }
            Ok(size) => {
                pending.extend_from_slice(&buffer[..size]);
                let end = match std::str::from_utf8(&pending) {
                    Err(error) if error.error_len().is_none() => error.valid_up_to(),
                    _ => pending.len(),
                };
                if end > 0
                    && sender
                        .send(Ok(String::from_utf8_lossy(&pending[..end]).into()))
                        .is_err()
                {
                    break;
                }
                pending.drain(..end);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = sender.send(Err(format!("ошибка чтения вывода: {error}")));
                break;
            }
        }
    }
}

#[test]
fn output_preserves_characters_split_between_reads() {
    let expected = format!("{}ы🙂", "a".repeat(4095));
    let (sender, receiver) = sync_channel(16);
    pump(std::io::Cursor::new(expected.as_bytes()), sender);
    let actual: String = receiver.into_iter().map(|part| part.unwrap()).collect();
    assert_eq!(actual, expected);
}

#[cfg(not(unix))]
pub fn start(_core: Arc<Mutex<Core>>, _workspace_id: &str) -> Result<()> {
    Err("подготовка пока поддерживается на Unix".into())
}
