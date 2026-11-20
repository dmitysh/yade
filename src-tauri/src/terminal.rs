use crate::{
    core::Core,
    model::{View, Workspace},
    store::Result,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Condvar, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const OUTPUT_CHUNKS: usize = 16;
const CHUNK_BYTES: usize = 4096;

#[cfg(unix)]
struct TerminalReader {
    reader: Box<dyn Read + Send>,
    fd: std::os::fd::OwnedFd,
}

#[cfg(unix)]
impl Read for TerminalReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        loop {
            match self.reader.read(buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    let mut fd = libc::pollfd {
                        fd: self.fd.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    if unsafe { libc::poll(&mut fd, 1, -1) } < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if fd.revents & libc::POLLNVAL != 0 {
                        return Err(std::io::Error::from_raw_os_error(libc::EBADF));
                    }
                }
                result => return result,
            }
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InterruptResult {
    Raw,
    Flushed,
    Signalled,
}

struct TerminalInput {
    writer: Mutex<Box<dyn Write + Send>>,
    order: Mutex<()>,
    interrupted: AtomicUsize,
    #[cfg(unix)]
    fd: std::os::fd::OwnedFd,
}

impl TerminalInput {
    fn new(master: &dyn MasterPty) -> Result<Self> {
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let fd = {
            use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
            let raw = master.as_raw_fd().ok_or("дескриптор PTY недоступен")?;
            let duplicate = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let fd = unsafe { OwnedFd::from_raw_fd(duplicate) };
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
            if flags < 0
                || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                    < 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            fd
        };
        Ok(Self {
            writer: Mutex::new(writer),
            order: Mutex::new(()),
            interrupted: AtomicUsize::new(0),
            #[cfg(unix)]
            fd,
        })
    }

    fn reader(&self, master: &dyn MasterPty) -> Result<Box<dyn Read + Send>> {
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let reader = Box::new(TerminalReader {
            reader,
            fd: self.fd.try_clone().map_err(|e| e.to_string())?,
        });
        Ok(reader)
    }

    fn write(&self, data: &[u8]) -> Result<()> {
        let _order = self.order.lock().map_err(|e| e.to_string())?;
        let generation = self.interrupted.load(Ordering::SeqCst);
        let mut remaining = data;
        while !remaining.is_empty() {
            let result = {
                let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
                if generation != self.interrupted.load(Ordering::SeqCst) {
                    return Ok(());
                }
                writer.write(&remaining[..remaining.len().min(CHUNK_BYTES)])
            };
            match result {
                Ok(0) => return Err("PTY не принимает ввод".into()),
                Ok(count) => remaining = &remaining[count..],
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(format!("не удалось передать ввод терминалу: {error}")),
            }
        }
        Ok(())
    }

    #[cfg(unix)]
    fn interrupt(&self) -> Result<InterruptResult> {
        use std::os::fd::AsRawFd;
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        let fd = self.fd.as_raw_fd();
        let mut attrs = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(fd, &mut attrs) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if attrs.c_lflag & libc::ISIG == 0 || attrs.c_cc[libc::VINTR] != 3 {
            return Ok(InterruptResult::Raw);
        }
        if attrs.c_lflag & libc::NOFLSH == 0 {
            if unsafe { libc::tcflush(fd, libc::TCIFLUSH) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            writer.write_all(&[3]).map_err(|e| e.to_string())?;
            self.interrupted.fetch_add(1, Ordering::SeqCst);
            Ok(InterruptResult::Flushed)
        } else {
            // NOFLSH сохраняет заполненную очередь, поэтому байт не сможет попасть в PTY.
            let group = unsafe { libc::tcgetpgrp(fd) };
            if group <= 0 || unsafe { libc::kill(-group, libc::SIGINT) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(InterruptResult::Signalled)
        }
    }

    #[cfg(not(unix))]
    fn interrupt(&self) -> Result<InterruptResult> {
        Ok(InterruptResult::Raw)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub workspace_id: String,
    pub state: String,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
    pub last_activity_at: i64,
    #[serde(default)]
    pub execution: Option<crate::terminal_observer::Execution>,
    #[serde(default)]
    pub shell_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFrame {
    pub info: TerminalInfo,
    pub data: Vec<u8>,
    pub output_done: bool,
    pub shell_started: bool,
}

pub(crate) struct Terminal {
    pub info: TerminalInfo,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Arc<TerminalInput>>,
    output: Receiver<Result<Vec<u8>>>,
    output_ready: Arc<(Mutex<bool>, Condvar)>,
    observer: Arc<Mutex<crate::terminal_observer::Observer>>,
    process_scope: Option<crate::terminal_observer::ProcessScope>,
    shell: Option<Arc<crate::terminal_shell::Shell>>,
    shell_started: bool,
}

impl Terminal {
    pub fn spawn(
        workspace: Workspace,
        mut command: CommandBuilder,
        size: PtySize,
    ) -> Result<(Self, Box<dyn portable_pty::Child + Send + Sync>)> {
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("не удалось открыть PTY: {e}"))?;
        let writer = TerminalInput::new(pair.master.as_ref())?;
        let reader = writer.reader(pair.master.as_ref())?;
        if command.get_cwd().is_none() {
            command.cwd(workspace.path);
        }
        let shell = crate::terminal_shell::Shell::configure(&mut command)?.map(Arc::new);
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("не удалось запустить оболочку: {e}"))?;
        drop(pair.slave);
        let Some(pid) = child.process_id() else {
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
            return Err("оболочка не предоставила идентификатор процесса".into());
        };
        let observer = Arc::new(Mutex::new(crate::terminal_observer::Observer::new(
            pid, size.rows, size.cols,
        )));
        #[cfg(unix)]
        let process_scope = crate::terminal_observer::ProcessScope::register(
            pid,
            pair.master.tty_name().as_deref(),
        );
        #[cfg(not(unix))]
        let process_scope = None;
        let (sender, output) = sync_channel(OUTPUT_CHUNKS);
        let output_ready = Arc::default();
        let ready = Arc::clone(&output_ready);
        let observed = observer.clone();
        std::thread::spawn(move || pump(reader, sender, Some(observed), ready));
        Ok((
            Self {
                info: TerminalInfo {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace.id,
                    state: "running".into(),
                    exit_code: None,
                    error: None,
                    last_activity_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64,
                    execution: None,
                    shell_token: shell.as_ref().map(|shell| shell.token.clone()),
                },
                master: Some(pair.master),
                writer: Some(Arc::new(writer)),
                output,
                output_ready,
                observer,
                process_scope,
                shell_started: shell.is_none(),
                shell,
            },
            child,
        ))
    }

    pub fn close(&mut self) {
        self.process_scope.take();
        self.writer.take();
        self.master.take();
        notify_output(&self.output_ready);
    }

    fn refresh_execution(
        &mut self,
        processes: Option<&[crate::terminal_observer::Process]>,
    ) -> (
        Option<crate::terminal_observer::TitleRequest>,
        Option<(crate::notifications::Kind, &'static str)>,
    ) {
        let Ok(mut observer) = self.observer.lock() else {
            return (None, None);
        };
        let (changed, notification) = observer.refresh(processes, &mut self.info.execution);
        let request = self
            .info
            .execution
            .as_ref()
            .and_then(|e| observer.take_title_request(e));
        drop(observer);
        if changed {
            self.mark_used();
        }
        (request, notification)
    }

    pub(crate) fn set_title(
        &mut self,
        request: &crate::terminal_observer::TitleRequest,
        title: String,
    ) {
        if let Ok(observer) = self.observer.lock() {
            observer.set_title(
                request.pid,
                &request.executor,
                &mut self.info.execution,
                title,
            );
        }
        notify_output(&self.output_ready);
    }

    pub(crate) fn mark_used(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        self.info.last_activity_at = self.info.last_activity_at.max(now);
    }

    fn read(&mut self) -> TerminalFrame {
        let mut data = Vec::new();
        let mut output_done = false;
        for _ in 0..OUTPUT_CHUNKS {
            match self.output.try_recv() {
                Ok(Ok(chunk)) => data.extend(chunk),
                Ok(Err(error)) => {
                    self.info.error = Some(error);
                    if self.info.state == "completed" {
                        self.info.state = "failed".into();
                    }
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    output_done = true;
                    break;
                }
            }
        }
        if !self.shell_started {
            self.shell_started = self
                .shell
                .as_ref()
                .is_some_and(|shell| shell.directory.path().join("started").exists());
        }
        TerminalFrame {
            info: self.info.clone(),
            data,
            output_done,
            shell_started: self.shell_started,
        }
    }
}

fn pump(
    mut reader: impl Read,
    sender: SyncSender<Result<Vec<u8>>>,
    observer: Option<Arc<Mutex<crate::terminal_observer::Observer>>>,
    ready: Arc<(Mutex<bool>, Condvar)>,
) {
    let mut buffer = [0; CHUNK_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                if let Some(observer) = &observer {
                    if let Ok(mut observer) = observer.lock() {
                        observer.feed(&buffer[..size]);
                    }
                }
                // Следующее чтение PTY ждёт места в ограниченной очереди.
                match sender.try_send(Ok(buffer[..size].to_vec())) {
                    Ok(()) => {}
                    Err(TrySendError::Disconnected(_)) => break,
                    Err(TrySendError::Full(data)) => {
                        // shortcut: при отсутствии интерфейса ограниченная очередь приостанавливает чтение; для отдельного фонового запуска нужно другое хранение вывода.
                        if let Some(observer) = &observer {
                            if let Ok(mut observer) = observer.lock() {
                                observer.backpressured = true;
                            }
                        }
                        if sender.send(data).is_err() {
                            break;
                        }
                        if let Some(observer) = &observer {
                            if let Ok(mut observer) = observer.lock() {
                                observer.backpressured = false;
                            }
                        }
                    }
                }
                notify_output(&ready);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            #[cfg(not(unix))]
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            #[cfg(unix)]
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => {
                let _ = sender.send(Err(format!("ошибка чтения терминала: {error}")));
                break;
            }
        }
    }
    drop(sender);
    notify_output(&ready);
}

fn notify_output(ready: &(Mutex<bool>, Condvar)) {
    if let Ok(mut pending) = ready.0.lock() {
        *pending = true;
        ready.1.notify_all();
    }
}

pub fn size(cols: u16, rows: u16) -> Result<PtySize> {
    if cols == 0 || rows == 0 {
        return Err("размер терминала должен быть положительным".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

pub fn start(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo> {
    start_from(core, workspace_id, cols, rows, None)
}

pub fn start_from(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    cols: u16,
    rows: u16,
    source_id: Option<&str>,
) -> Result<TerminalInfo> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut command = CommandBuilder::new(shell);
    command.args(["-l", "-i"]);
    if let Some(id) = source_id {
        let mut guard = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *guard;
        let source = processes.terminal(store, workspace_id, id)?;
        if let Some(shell) = &source.shell {
            let cwd = shell.context()?.cwd;
            if !cwd.is_empty() {
                command.cwd(cwd);
            }
        }
    }
    start_command(core, workspace_id, command, size(cols, rows)?)
}

pub fn shell_context(
    core: &Mutex<Core>,
    workspace_id: &str,
    id: &str,
) -> Result<crate::terminal_shell::Context> {
    let shell = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        processes
            .terminal(store, workspace_id, id)?
            .shell
            .clone()
            .ok_or("интеграция с оболочкой недоступна")?
    };
    shell.context()
}

pub fn submit(core: &Arc<Mutex<Core>>, workspace_id: &str, id: &str, command: &str) -> Result<()> {
    set_input(core, workspace_id, id, command, true)
}

pub fn restore(core: &Arc<Mutex<Core>>, workspace_id: &str, id: &str, command: &str) -> Result<()> {
    set_input(core, workspace_id, id, command, false)
}

pub fn edit(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    id: &str,
    command: &str,
    cursor: usize,
    request: u64,
    action: &str,
) -> Result<crate::terminal_shell::Editor> {
    validate_command(command)?;
    if cursor > command.chars().count()
        || !matches!(
            action,
            "change" | "complete" | "previous" | "next" | "accept"
        )
    {
        return Err("некорректный запрос редактора команды".into());
    }
    let (shell, writer) = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        let terminal = processes.terminal(store, workspace_id, id)?;
        terminal.mark_used();
        (
            terminal
                .shell
                .clone()
                .ok_or("интеграция с оболочкой недоступна")?,
            terminal.writer.clone().ok_or("терминал завершён")?,
        )
    };
    let _guard = shell.editor_lock.lock().map_err(|e| e.to_string())?;
    if !shell.directory.path().join("ready").exists() {
        return Err("оболочка ещё выполняет команду".into());
    }
    std::fs::write(shell.directory.path().join("draft"), command).map_err(|e| e.to_string())?;
    std::fs::write(
        shell.directory.path().join("edit-request"),
        format!("{request}\n{cursor}\n{action}"),
    )
    .map_err(|e| e.to_string())?;
    writer.write(b"\x1b[97~")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(editor) = shell.editor()? {
            if editor.request == request {
                return Ok(editor);
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("оболочка не ответила редактору команды".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

fn validate_command(command: &str) -> Result<()> {
    if command.len() > 1024 * 1024
        || command
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("команда содержит недопустимые символы или слишком длинная".into());
    }
    Ok(())
}

fn set_input(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    id: &str,
    command: &str,
    execute: bool,
) -> Result<()> {
    validate_command(command)?;
    let writer = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        let terminal = processes.terminal(store, workspace_id, id)?;
        if terminal.info.state != "running" {
            return Err("оболочка уже завершена".into());
        }
        let shell = terminal
            .shell
            .as_ref()
            .ok_or("интеграция с оболочкой недоступна")?;
        if !shell.directory.path().join("ready").exists() {
            return Err("оболочка ещё выполняет команду".into());
        }
        std::fs::write(shell.directory.path().join("input"), command).map_err(|e| e.to_string())?;
        if execute {
            std::fs::remove_file(shell.directory.path().join("ready"))
                .map_err(|_| "оболочка ещё выполняет команду")?;
            if let Ok(mut observer) = terminal.observer.lock() {
                observer.command();
            }
        }
        terminal.mark_used();
        terminal.writer.clone().ok_or("терминал завершён")?
    };
    writer.write(if execute { b"\x1b[99~" } else { b"\x1b[98~" })
}

pub(crate) fn start_command(
    core: &Arc<Mutex<Core>>,
    workspace_id: &str,
    command: CommandBuilder,
    size: PtySize,
) -> Result<TerminalInfo> {
    let info = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        processes.spawn_terminal(store, workspace_id, command, size)?
    };
    let weak = Arc::downgrade(core);
    let id = info.id.clone();
    let workspace_id = info.workspace_id.clone();
    std::thread::spawn(move || loop {
        let Some(core) = weak.upgrade() else {
            break;
        };
        let sample = crate::terminal_observer::sample();
        let notification = {
            let Ok(mut core) = core.lock() else {
                break;
            };
            let Core { store, processes } = &mut *core;
            let (request, notification) = processes
                .terminals
                .get_mut(&id)
                .map(|terminal| terminal.refresh_execution(sample.as_deref().map(Vec::as_slice)))
                .unwrap_or_default();
            if let Some(request) = request {
                crate::session_titles::start_terminal(weak.clone(), id.clone(), request);
            }
            match processes.terminal_exit(store, &id) {
                Ok(true) => break,
                Ok(false) => {}
                Err(error) => {
                    if let Some(terminal) = processes.terminals.get_mut(&id) {
                        terminal.info.error = Some(error);
                    }
                }
            }
            notification
        };
        if let Some((kind, executor)) = notification {
            crate::notifications::terminal_notification(&core, kind, executor, &workspace_id);
        }
        drop(core);
        std::thread::sleep(Duration::from_millis(50));
    });
    Ok(info)
}

pub fn list(core: &Mutex<Core>, workspace_id: &str) -> Result<Vec<TerminalInfo>> {
    let core = core.lock().map_err(|e| e.to_string())?;
    core.store.workspace(workspace_id)?;
    Ok(core
        .processes
        .terminals
        .values()
        .filter(|t| t.info.workspace_id == workspace_id)
        .map(|t| t.info.clone())
        .collect())
}

pub fn read(core: &Mutex<Core>, workspace_id: &str, id: &str) -> Result<TerminalFrame> {
    let mut core = core.lock().map_err(|e| e.to_string())?;
    let Core { store, processes } = &mut *core;
    let terminal = processes.terminal(store, workspace_id, id)?;
    *terminal.output_ready.0.lock().map_err(|e| e.to_string())? = false;
    Ok(terminal.read())
}

pub fn wait(core: &Mutex<Core>, workspace_id: &str, id: &str) -> Result<()> {
    let ready = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        processes
            .terminal(store, workspace_id, id)?
            .output_ready
            .clone()
    };
    let pending = ready.0.lock().map_err(|e| e.to_string())?;
    // Таймаут обновляет состояние тихой оболочки и ограничивает ожидание закрытой панели.
    drop(
        ready
            .1
            .wait_timeout_while(pending, Duration::from_millis(500), |pending| !*pending)
            .map_err(|e| e.to_string())?,
    );
    Ok(())
}

pub fn write(core: &Mutex<Core>, workspace_id: &str, id: &str, data: &str) -> Result<()> {
    let writer = input(core, workspace_id, id)?;
    if !data.is_empty() {
        mark_used(core, workspace_id, id, data)?;
    }
    writer.write(data.as_bytes())
}

pub fn interrupt(core: &Mutex<Core>, workspace_id: &str, id: &str) -> Result<InterruptResult> {
    let writer = input(core, workspace_id, id)?;
    mark_used(core, workspace_id, id, "\u{3}")?;
    writer.interrupt()
}

fn mark_used(core: &Mutex<Core>, workspace_id: &str, id: &str, data: &str) -> Result<()> {
    let mut core = core.lock().map_err(|e| e.to_string())?;
    let Core { store, processes } = &mut *core;
    let terminal = processes.terminal(store, workspace_id, id)?;
    terminal.mark_used();
    if let Ok(mut observer) = terminal.observer.lock() {
        observer.input(data);
    }
    Ok(())
}

fn input(core: &Mutex<Core>, workspace_id: &str, id: &str) -> Result<Arc<TerminalInput>> {
    let writer = {
        let mut core = core.lock().map_err(|e| e.to_string())?;
        let Core { store, processes } = &mut *core;
        let terminal = processes.terminal(store, workspace_id, id)?;
        if terminal.info.state != "running" {
            return Err("оболочка уже завершена".into());
        }
        terminal.writer.clone().ok_or("оболочка уже завершена")?
    };
    Ok(writer)
}

pub fn resize(
    core: &Mutex<Core>,
    workspace_id: &str,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let size = size(cols, rows)?;
    let mut core = core.lock().map_err(|e| e.to_string())?;
    let Core { store, processes } = &mut *core;
    let terminal = processes.terminal(store, workspace_id, id)?;
    if let Some(master) = &terminal.master {
        master
            .resize(size)
            .map_err(|e| format!("не удалось изменить размер терминала: {e}"))?;
        terminal
            .observer
            .lock()
            .map_err(|e| e.to_string())?
            .resize(rows, cols);
    }
    Ok(())
}

pub fn stop(core: &Mutex<Core>, workspace_id: &str, id: &str) -> Result<()> {
    let mut core = core.lock().map_err(|e| e.to_string())?;
    let Core { store, processes } = &mut *core;
    processes.stop_terminal(store, workspace_id, id)
}

pub fn delete(
    core: &Mutex<Core>,
    workspace_id: &str,
    id: &str,
    replacement_id: Option<&str>,
    confirmed: bool,
) -> Result<View> {
    let mut core = core.lock().map_err(|e| e.to_string())?;
    let Core { store, processes } = &mut *core;
    let terminal = processes.terminal(store, workspace_id, id)?;
    if !confirmed && (terminal.info.state != "completed" || terminal.info.error.is_some()) {
        return Err("автоматически удаляется только успешно завершённый терминал".into());
    }
    let replacement = if let Some(replacement_id) = replacement_id.filter(|&other| other != id) {
        processes.terminal(store, workspace_id, replacement_id)?;
        Some(format!("terminal:{replacement_id}"))
    } else {
        None
    };
    let mut view = store.snapshot()?.view;
    let tab_id = format!("terminal:{id}");
    if let Some(index) = view
        .tabs
        .iter()
        .position(|tab| tab.id == tab_id && tab.workspace_id == workspace_id)
    {
        if let Some(other) = replacement
            .as_ref()
            .filter(|other| !view.tabs.iter().any(|tab| &tab.id == *other))
        {
            view.tabs[index].id = other.clone();
        } else {
            view.tabs.remove(index);
        }
        if view.active_tabs.get(workspace_id) == Some(&tab_id) {
            if let Some(next) = replacement.or_else(|| {
                view.tabs
                    .iter()
                    .find(|tab| tab.workspace_id == workspace_id)
                    .map(|tab| tab.id.clone())
            }) {
                view.active_tabs.insert(workspace_id.into(), next);
            } else {
                view.active_tabs.remove(workspace_id);
            }
        }
    }
    if confirmed && processes.contains(id) {
        processes.stop_terminal(store, workspace_id, id)?;
    }
    let tx = store.connection.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM processes WHERE id=?1 AND workspace_id=?2 AND run_id IS NULL",
        rusqlite::params![id, workspace_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE view_state SET value=?1 WHERE id=1",
        [serde_json::to_string(&view).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    processes.terminals.remove(id);
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn read_batches_output_without_losing_bytes_errors_or_queue_limit() {
        let (sender, output) = sync_channel(OUTPUT_CHUNKS + 1);
        let mut terminal = Terminal {
            info: TerminalInfo {
                id: "terminal".into(),
                workspace_id: "workspace".into(),
                state: "running".into(),
                exit_code: None,
                error: None,
                last_activity_at: 0,
                execution: None,
                shell_token: None,
            },
            master: None,
            writer: None,
            output,
            output_ready: Arc::default(),
            observer: Arc::new(Mutex::new(crate::terminal_observer::Observer::new(
                1, 24, 80,
            ))),
            process_scope: None,
            shell: None,
            shell_started: true,
        };
        let expected: Vec<u8> = "ы🙂\x1b[?2026hтекст\x1b[?2026l"
            .as_bytes()
            .iter()
            .copied()
            .cycle()
            .take(CHUNK_BYTES * OUTPUT_CHUNKS)
            .collect();
        for chunk in expected.chunks(CHUNK_BYTES) {
            sender.send(Ok(chunk.to_vec())).unwrap();
        }
        sender.send(Ok(b"tail".to_vec())).unwrap();
        let frame = terminal.read();
        assert_eq!(frame.data, expected);
        assert!(!frame.output_done);
        assert_eq!(terminal.read().data, b"tail");
        let empty = terminal.read();
        assert!(empty.data.is_empty());
        assert!(!empty.output_done);

        terminal.info.state = "completed".into();
        sender.send(Ok(b"last".to_vec())).unwrap();
        sender.send(Err("ошибка чтения".into())).unwrap();
        drop(sender);
        let frame = terminal.read();
        assert_eq!(frame.data, b"last");
        assert_eq!(frame.info.state, "failed");
        assert_eq!(frame.info.error.as_deref(), Some("ошибка чтения"));
        assert!(!frame.output_done);
        assert!(terminal.read().output_done);
    }

    #[cfg(unix)]
    struct InputFixture {
        input: Arc<TerminalInput>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        output: Receiver<Result<Vec<u8>>>,
        _master: Box<dyn MasterPty + Send>,
    }

    #[cfg(unix)]
    impl InputFixture {
        fn new(script: &str) -> Self {
            let pair = native_pty_system().openpty(size(80, 24).unwrap()).unwrap();
            let input = Arc::new(TerminalInput::new(pair.master.as_ref()).unwrap());
            let reader = input.reader(pair.master.as_ref()).unwrap();
            let mut command = CommandBuilder::new("/bin/sh");
            command.args(["-c", script]);
            let child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let (sender, output) = sync_channel(OUTPUT_CHUNKS);
            std::thread::spawn(move || pump(reader, sender, None, Arc::default()));
            let fixture = Self {
                input,
                child,
                output,
                _master: pair.master,
            };
            fixture.until("ready");
            fixture
        }

        fn until(&self, expected: &str) -> String {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut bytes = Vec::new();
            loop {
                let part = self
                    .output
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .unwrap()
                    .unwrap();
                bytes.extend(part);
                let text = String::from_utf8_lossy(&bytes);
                if text.contains(expected) {
                    return text.into();
                }
            }
        }
    }

    #[cfg(unix)]
    impl Drop for InputFixture {
        fn drop(&mut self) {
            if let Some(pid) = self.child.process_id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = self.child.wait();
        }
    }

    #[cfg(unix)]
    #[test]
    fn small_output_writes_do_not_accumulate_read_delays() {
        let fixture = InputFixture::new(
            "stty raw -echo; printf ready; dd bs=1 count=1 >/dev/null 2>&1; i=0; while [ \"$i\" -lt 60000 ]; do printf '\\033[38;2;137;180;250m'; printf 'текст🙂'; printf '\\033[0m'; printf '\\033[1C'; i=$((i+1)); done",
        );
        fixture.input.write(b"x").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut actual = Vec::new();
        loop {
            match fixture
                .output
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            {
                Ok(part) => actual.extend(part.unwrap()),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(error) => panic!("вывод PTY задержался: {error}"),
            }
        }
        assert_eq!(
            actual,
            "\x1b[38;2;137;180;250mтекст🙂\x1b[0m\x1b[1C"
                .repeat(60000)
                .as_bytes()
        );
    }

    #[cfg(unix)]
    #[test]
    fn interrupt_reaches_a_full_pty_and_cancels_the_remaining_paste() {
        let fixture = InputFixture::new(
            "stty -icanon -echo; trap 'printf interrupted' INT; printf ready; sleep 300",
        );
        let input = fixture.input.clone();
        let (sender, finished) = sync_channel(1);
        let paste =
            std::thread::spawn(move || sender.send(input.write(&vec![b'x'; 1024 * 1024])).unwrap());
        std::thread::sleep(Duration::from_millis(150));
        assert!(matches!(finished.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(fixture.input.interrupt().unwrap(), InterruptResult::Flushed);
        finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        paste.join().unwrap();
        fixture.until("interrupted");
    }

    #[cfg(unix)]
    #[test]
    fn raw_mode_keeps_ctrl_c_as_an_ordered_byte() {
        let fixture = InputFixture::new(
            "stty raw -echo; printf ready; dd bs=1 count=4 2>/dev/null | od -An -tu1",
        );
        fixture.input.write(b"a").unwrap();
        assert_eq!(fixture.input.interrupt().unwrap(), InterruptResult::Raw);
        fixture.input.write(b"\x03bc").unwrap();
        let output = fixture.until("\n");
        assert_eq!(
            output
                .split_whitespace()
                .map(|s| s.parse::<u8>().unwrap())
                .collect::<Vec<_>>(),
            [97, 3, 98, 99]
        );
    }

    #[cfg(unix)]
    #[test]
    fn noflsh_interrupt_preserves_the_full_pending_input() {
        let fixture = InputFixture::new(
            "stty -icanon -echo noflsh; trap ':' INT; printf ready; sleep 300; dd bs=1 count=4096 2>/dev/null | wc -c",
        );
        let input = fixture.input.clone();
        let (sender, finished) = sync_channel(1);
        let paste =
            std::thread::spawn(move || sender.send(input.write(&vec![b'x'; 4096])).unwrap());
        std::thread::sleep(Duration::from_millis(150));
        assert!(matches!(finished.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(
            fixture.input.interrupt().unwrap(),
            InterruptResult::Signalled
        );
        finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        paste.join().unwrap();
        fixture.until("4096");
    }

    #[test]
    fn slow_consumer_bounds_reads_and_preserves_bytes() {
        struct Reader {
            bytes: std::io::Cursor<Vec<u8>>,
            reads: Arc<AtomicUsize>,
        }
        impl Read for Reader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                self.bytes.read(buffer)
            }
        }
        let expected = "ы🙂".repeat(CHUNK_BYTES * OUTPUT_CHUNKS);
        let reads = Arc::new(AtomicUsize::new(0));
        let reader = Reader {
            bytes: std::io::Cursor::new(expected.as_bytes().to_vec()),
            reads: reads.clone(),
        };
        let (sender, receiver) = sync_channel(OUTPUT_CHUNKS);
        let observer = Arc::new(Mutex::new(crate::terminal_observer::Observer::new(
            1, 24, 80,
        )));
        let observed = observer.clone();
        let producer =
            std::thread::spawn(move || pump(reader, sender, Some(observed), Arc::default()));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while reads.load(Ordering::SeqCst) < OUTPUT_CHUNKS + 1 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(reads.load(Ordering::SeqCst), OUTPUT_CHUNKS + 1);
        assert!(observer.lock().unwrap().backpressured);
        let actual: Vec<u8> = receiver
            .into_iter()
            .flat_map(|part| part.unwrap())
            .collect();
        producer.join().unwrap();
        assert_eq!(actual, expected.as_bytes());
        assert!(!observer.lock().unwrap().backpressured);
        assert!(reads.load(Ordering::SeqCst) > OUTPUT_CHUNKS + 1);
    }
}
