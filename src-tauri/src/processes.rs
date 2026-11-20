use crate::{
    model::Context,
    store::{Result, Store},
};
use std::{
    collections::HashMap,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, Sender, TryRecvError},
};

enum ProcessChild {
    Standard(Child),
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
}

impl ProcessChild {
    fn id(&self) -> u32 {
        match self {
            Self::Standard(child) => child.id(),
            Self::Pty(child) => child.process_id().expect("PTY без PID"),
        }
    }

    fn wait(&mut self) -> Result<()> {
        match self {
            Self::Standard(child) => child.wait().map(|_| ()),
            Self::Pty(child) => child.wait().map(|_| ()),
        }
        .map_err(|e| e.to_string())
    }
}

struct OwnedProcess {
    context: Option<Context>,
    workspace_id: String,
    child: ProcessChild,
    reaped: bool,
}

#[derive(Default)]
pub struct Processes {
    entries: HashMap<String, OwnedProcess>,
    pub(crate) terminals: HashMap<String, crate::terminal::Terminal>,
    pub(crate) codex: HashMap<String, crate::codex::Handle>,
    pub(crate) claude: HashMap<String, crate::claude::Handle>,
    pub(crate) git_operations: Vec<Receiver<()>>,
    pub(crate) closing: bool,
}

impl Processes {
    #[cfg(unix)]
    pub fn spawn(
        &mut self,
        store: &Store,
        context: &Context,
        command: &mut Command,
    ) -> Result<String> {
        store.validate_context(context)?;
        self.spawn_owned(
            store,
            &context.workspace_id,
            Some(context),
            command,
            false,
            Stdio::null(),
        )
    }

    #[cfg(unix)]
    pub fn spawn_preparation(
        &mut self,
        store: &Store,
        workspace_id: &str,
        command: &mut Command,
    ) -> Result<(String, ChildStdout, ChildStderr)> {
        command.env("PATH", crate::executors::search_path());
        let id = self.spawn_owned(store, workspace_id, None, command, true, Stdio::null())?;
        let owned = self.entries.get_mut(&id).ok_or("процесс отсутствует")?;
        let ProcessChild::Standard(child) = &mut owned.child else {
            return Err("процесс не является подготовкой".into());
        };
        let stdout = child.stdout.take().ok_or("вывод процесса недоступен")?;
        let stderr = child.stderr.take().ok_or("ошибки процесса недоступны")?;
        Ok((id, stdout, stderr))
    }

    #[cfg(unix)]
    pub fn spawn_stdio(
        &mut self,
        store: &Store,
        context: &Context,
        command: &mut Command,
    ) -> Result<(String, ChildStdin, ChildStdout)> {
        store.validate_context(context)?;
        let id = self.spawn_owned(
            store,
            &context.workspace_id,
            Some(context),
            command,
            true,
            Stdio::piped(),
        )?;
        self.stdio(&id)
    }

    pub(crate) fn spawn_background_stdio(
        &mut self,
        store: &Store,
        workspace_id: &str,
        command: &mut Command,
    ) -> Result<(String, ChildStdin, ChildStdout)> {
        let id = self.spawn_owned(store, workspace_id, None, command, true, Stdio::piped())?;
        self.stdio(&id)
    }

    fn stdio(&mut self, id: &str) -> Result<(String, ChildStdin, ChildStdout)> {
        let owned = self.entries.get_mut(id).ok_or("процесс отсутствует")?;
        let ProcessChild::Standard(child) = &mut owned.child else {
            return Err("процесс не поддерживает stdio".into());
        };
        let input = child.stdin.take().ok_or("ввод процесса недоступен")?;
        let output = child.stdout.take().ok_or("вывод процесса недоступен")?;
        let mut errors = child.stderr.take().ok_or("ошибки процесса недоступны")?;
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut errors, &mut std::io::sink());
        });
        Ok((id.into(), input, output))
    }

    #[cfg(unix)]
    fn spawn_owned(
        &mut self,
        store: &Store,
        workspace_id: &str,
        context: Option<&Context>,
        command: &mut Command,
        capture: bool,
        input: Stdio,
    ) -> Result<String> {
        use std::os::unix::process::CommandExt;
        self.ensure_accepting()?;
        let workspace = store.workspace(workspace_id)?;
        if workspace.operation_state != "ready" || workspace.archived {
            return Err("пространство недоступно для запуска".into());
        }
        let child = command
            .current_dir(workspace.path)
            .process_group(0)
            .stdin(input)
            .stdout(if capture {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(if capture {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .spawn()
            .map_err(|e| format!("не удалось запустить процесс: {e}"))?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut owned = OwnedProcess {
            context: context.cloned(),
            workspace_id: workspace_id.into(),
            child: ProcessChild::Standard(child),
            reaped: false,
        };
        let saved = (|| {
            let identity = crate::lifecycle::process_identity(owned.child.id())?;
            store.connection.execute("INSERT INTO processes(id,run_id,workspace_id,pid,process_group,state,identity) VALUES(?1,?2,?3,?4,?4,'running',?5)",rusqlite::params![id,context.map(|c| &c.run_id),workspace_id,owned.child.id(),identity]).map_err(|e| e.to_string())
        })();
        if let Err(error) = saved {
            if let Err(stop_error) = terminate(&mut owned) {
                self.entries.insert(id, owned);
                return Err(format!(
                    "не удалось сохранить процесс: {error}; {stop_error}"
                ));
            }
            return Err(format!(
                "процесс остановлен: не удалось сохранить запуск: {error}"
            ));
        }
        self.entries.insert(id.clone(), owned);
        Ok(id)
    }

    pub fn stop(&mut self, store: &Store, context: &Context, id: &str) -> Result<()> {
        store.validate_context(context)?;
        let owned = self
            .entries
            .get_mut(id)
            .ok_or("процесс не принадлежит этому запуску приложения")?;
        if owned.context.as_ref() != Some(context) {
            return Err("процесс принадлежит другому запуску".into());
        }
        terminate(owned)?;
        store
            .connection
            .execute("UPDATE processes SET state='stopped' WHERE id=?1", [id])
            .map_err(|e| format!("процесс остановлен, но состояние не сохранено: {e}"))?;
        self.entries.remove(id);
        Ok(())
    }

    pub fn preparation_exit(&mut self, store: &Store, id: &str) -> Result<Option<ExitStatus>> {
        let owned = self.entries.get_mut(id).ok_or("процесс отсутствует")?;
        if owned.context.is_some() {
            return Err("процесс не является подготовкой".into());
        }
        #[cfg(unix)]
        if !preparation_tree_exited(owned.child.id())? {
            return Ok(None);
        }
        let ProcessChild::Standard(child) = &mut owned.child else {
            return Err("процесс не является подготовкой".into());
        };
        let status = child.try_wait().map_err(|e| e.to_string())?;
        if status.is_some() {
            store
                .connection
                .execute("UPDATE processes SET state='exited' WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            self.entries.remove(id);
        }
        Ok(status)
    }

    pub(crate) fn stop_background(
        &mut self,
        store: &Store,
        workspace_id: &str,
        id: &str,
    ) -> Result<()> {
        let owned = self.entries.get_mut(id).ok_or("процесс отсутствует")?;
        if owned.context.is_some() || owned.workspace_id != workspace_id {
            return Err("процесс принадлежит другому запуску".into());
        }
        terminate(owned)?;
        store
            .connection
            .execute("UPDATE processes SET state='stopped' WHERE id=?1", [id])
            .map_err(|e| format!("процесс остановлен, но состояние не сохранено: {e}"))?;
        self.entries.remove(id);
        Ok(())
    }

    pub fn spawn_terminal(
        &mut self,
        store: &Store,
        workspace_id: &str,
        command: portable_pty::CommandBuilder,
        size: portable_pty::PtySize,
    ) -> Result<crate::terminal::TerminalInfo> {
        self.ensure_accepting()?;
        let workspace = store.workspace(workspace_id)?;
        if workspace.operation_state != "ready" || workspace.archived {
            return Err("пространство недоступно для запуска".into());
        }
        let (terminal, child) = crate::terminal::Terminal::spawn(workspace, command, size)?;
        let info = terminal.info.clone();
        let mut owned = OwnedProcess {
            context: None,
            workspace_id: workspace_id.into(),
            child: ProcessChild::Pty(child),
            reaped: false,
        };
        let saved = (|| {
            let identity = crate::lifecycle::process_identity(owned.child.id())?;
            store.connection.execute(
                "INSERT INTO processes(id,workspace_id,pid,process_group,state,identity) VALUES(?1,?2,?3,?3,'running',?4)",
                rusqlite::params![info.id, workspace_id, owned.child.id(), identity],
            ).map_err(|e| e.to_string())
        })();
        if let Err(error) = saved {
            if let Err(stop_error) = terminate(&mut owned) {
                self.entries.insert(info.id.clone(), owned);
                self.terminals.insert(info.id, terminal);
                return Err(format!(
                    "не удалось сохранить процесс: {error}; {stop_error}"
                ));
            }
            return Err(format!(
                "процесс остановлен: не удалось сохранить запуск: {error}"
            ));
        }
        self.entries.insert(info.id.clone(), owned);
        self.terminals.insert(info.id.clone(), terminal);
        Ok(info)
    }

    pub fn terminal_exit(&mut self, store: &Store, id: &str) -> Result<bool> {
        let Some(owned) = self.entries.get_mut(id) else {
            if self.terminals.contains_key(id) {
                self.save_terminal_state(store, id)?;
            }
            return Ok(true);
        };
        #[cfg(unix)]
        {
            let mut status = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    owned.child.id(),
                    &mut status,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Ok(false);
                }
                return Err(format!("не удалось проверить завершение оболочки: {error}"));
            }
            if unsafe { status.si_pid() } == 0 || !preparation_tree_exited(owned.child.id())? {
                return Ok(false);
            }
        }
        let ProcessChild::Pty(child) = &mut owned.child else {
            return Err("процесс не является терминалом".into());
        };
        let Some(status) = child.try_wait().map_err(|e| e.to_string())? else {
            return Ok(false);
        };
        let terminal = self.terminals.get_mut(id).ok_or("терминал отсутствует")?;
        terminal.close();
        terminal.info.state = if status.success() && terminal.info.error.is_none() {
            "completed"
        } else {
            "failed"
        }
        .into();
        terminal.info.exit_code = Some(status.exit_code());
        self.entries.remove(id);
        self.save_terminal_state(store, id)?;
        Ok(true)
    }

    pub fn stop_terminal(&mut self, store: &Store, workspace_id: &str, id: &str) -> Result<()> {
        self.terminal(store, workspace_id, id)?;
        if let Some(owned) = self.entries.get_mut(id) {
            terminate(owned)?;
            self.entries.remove(id);
            let terminal = self.terminals.get_mut(id).unwrap();
            terminal.close();
            terminal.info.state = "stopped".into();
        }
        self.save_terminal_state(store, id)
    }

    fn save_terminal_state(&self, store: &Store, id: &str) -> Result<()> {
        let terminal = self.terminals.get(id).ok_or("терминал отсутствует")?;
        let state = if terminal.info.state == "stopped" {
            "stopped"
        } else {
            "exited"
        };
        store
            .connection
            .execute(
                "UPDATE processes SET state=?2 WHERE id=?1",
                rusqlite::params![id, state],
            )
            .map_err(|e| format!("терминал завершён, но состояние не сохранено: {e}"))?;
        Ok(())
    }

    pub(crate) fn terminal(
        &mut self,
        store: &Store,
        workspace_id: &str,
        id: &str,
    ) -> Result<&mut crate::terminal::Terminal> {
        let exists: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?1 AND deleted=0)",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("пространство отсутствует".into());
        }
        let terminal = self
            .terminals
            .get_mut(id)
            .ok_or("терминал этого запуска приложения недоступен; откройте новый")?;
        if terminal.info.workspace_id != workspace_id {
            return Err("терминал принадлежит другому пространству".into());
        }
        Ok(terminal)
    }

    pub fn has_workspace(&self, workspace_id: &str) -> bool {
        self.entries
            .values()
            .any(|p| p.workspace_id == workspace_id)
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn has_run(&self, id: &str) -> bool {
        self.entries
            .values()
            .any(|p| p.context.as_ref().is_some_and(|c| c.run_id == id))
            || self.codex.contains_key(id)
            || self.claude.contains_key(id)
    }

    pub(crate) fn has_session(&self, id: &str) -> bool {
        self.entries
            .values()
            .any(|p| p.context.as_ref().is_some_and(|c| c.session_id == id))
            || self.codex.values().any(|h| h.context.session_id == id)
            || self.claude.values().any(|h| h.context.session_id == id)
    }

    pub(crate) fn ensure_accepting(&self) -> Result<()> {
        if self.closing {
            return Err("приложение завершает работу".into());
        }
        Ok(())
    }

    pub(crate) fn track_git(&mut self) -> Result<Sender<()>> {
        self.ensure_accepting()?;
        self.git_operations
            .retain(|done| matches!(done.try_recv(), Err(TryRecvError::Empty)));
        let (running, done) = mpsc::channel();
        self.git_operations.push(done);
        Ok(running)
    }

    pub(crate) fn has_git_operations(&self) -> bool {
        self.git_operations
            .iter()
            .any(|done| matches!(done.try_recv(), Err(TryRecvError::Empty)))
    }

    pub(crate) fn stop_all(&mut self, store: &Store) -> Result<()> {
        for id in self.entries.keys().cloned().collect::<Vec<_>>() {
            terminate(self.entries.get_mut(&id).unwrap())?;
            store
                .connection
                .execute("UPDATE processes SET state='stopped' WHERE id=?1", [&id])
                .map_err(|e| format!("процесс остановлен, но состояние не сохранено: {e}"))?;
            if let Some(terminal) = self.terminals.get_mut(&id) {
                terminal.close();
                terminal.info.state = "stopped".into();
            }
            self.entries.remove(&id);
        }
        Ok(())
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
}

#[cfg(unix)]
fn preparation_tree_exited(root: u32) -> Result<bool> {
    let output = Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,pgid=,stat="])
        .output()
        .map_err(|e| format!("не удалось проверить процессы подготовки: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "не удалось проверить процессы подготовки: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let mut root_exited = false;
    let mut descendants_running = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut columns = line.split_whitespace();
        let pid = columns
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or("не удалось определить процесс подготовки")?;
        let group = columns
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or("не удалось определить группу подготовки")?;
        let state = columns
            .next()
            .and_then(|s| s.chars().next())
            .ok_or("не удалось определить состояние подготовки")?;
        if pid == root {
            root_exited = state == 'Z';
        } else if group == root && state != 'Z' {
            descendants_running = true;
        }
    }
    // До проверки всей группы дескриптор лидера удерживает его PID от повторного использования.
    Ok(root_exited && !descendants_running)
}

#[cfg(unix)]
fn terminate(owned: &mut OwnedProcess) -> Result<()> {
    if owned.reaped {
        return Ok(());
    }
    if preparation_tree_exited(owned.child.id())? {
        owned.child.wait()?;
        owned.reaped = true;
        return Ok(());
    }
    let group = owned.child.id() as i32;
    let mut frozen = Vec::new();
    let result = (|| {
        // shortcut: осиротевшие до обхода потомки вне группы не видны; для них нужен постоянный учёт.
        freeze_tree(group, unsafe { libc::getpid() }, &mut frozen)?;
        while let Some(&(pid, parent)) = frozen.last() {
            if pid == group {
                break;
            }
            let table = process_table()?;
            if let Some(&(actual_parent, _)) = table.get(&pid) {
                if actual_parent != parent {
                    frozen.pop();
                    return Err("принадлежность дочернего процесса изменилась".into());
                }
                signal_process(pid, libc::SIGKILL)?;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    let table = process_table()?;
                    if !table.get(&pid).is_some_and(|&(_, state)| state != 'Z') {
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err("дочерний процесс не завершился".into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            frozen.pop();
        }
        if let Err(error) = signal_process(-group, libc::SIGKILL) {
            // Лидер мог завершиться между обходом дерева и сигналом группе.
            if !preparation_tree_exited(owned.child.id())? {
                return Err(error);
            }
        }
        frozen.clear();
        owned.child.wait()?;
        owned.reaped = true;
        Ok(())
    })();
    if result.is_err() {
        for &(pid, _) in frozen.iter().rev() {
            let _ = signal_process(pid, libc::SIGCONT);
        }
    }
    result
}

#[cfg(unix)]
fn freeze_tree(pid: i32, parent: i32, frozen: &mut Vec<(i32, i32)>) -> Result<()> {
    let table = process_table()?;
    let Some(&(actual_parent, state)) = table.get(&pid) else {
        return Ok(());
    };
    if actual_parent != parent {
        return Err("принадлежность дочернего процесса изменилась".into());
    }
    if state == 'Z' {
        return Ok(());
    }
    signal_process(pid, libc::SIGSTOP)?;
    frozen.push((pid, parent));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let table = loop {
        let table = process_table()?;
        match table.get(&pid) {
            None | Some((_, 'Z')) => return Ok(()),
            Some((_, 'T')) => break table,
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            return Err("не удалось приостановить дочерний процесс".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    // Приостановленный родитель не создаёт потомков и не освобождает их PID до обхода.
    for (child, (child_parent, _)) in table {
        if child_parent == pid {
            freeze_tree(child, pid, frozen)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_table() -> Result<HashMap<i32, (i32, char)>> {
    let output = Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,ppid=,stat="])
        .output()
        .map_err(|e| format!("не удалось прочитать дерево процессов: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "не удалось прочитать дерево процессов: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    text.lines()
        .map(|line| {
            let mut columns = line.split_whitespace();
            let pid = columns.next().and_then(|s| s.parse::<i32>().ok());
            let parent = columns.next().and_then(|s| s.parse::<i32>().ok());
            let state = columns.next().and_then(|s| s.chars().next());
            match (pid, parent, state) {
                (Some(pid), Some(parent), Some(state)) if pid > 0 && parent >= 0 => {
                    Ok((pid, (parent, state)))
                }
                _ => Err("не удалось разобрать дерево процессов".into()),
            }
        })
        .collect()
}

#[cfg(unix)]
fn signal_process(pid: i32, signal: i32) -> Result<()> {
    if unsafe { libc::kill(pid, signal) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(format!(
                "не удалось отправить сигнал {signal} процессу {pid}: {error}"
            ));
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate(_owned: &mut OwnedProcess) -> Result<()> {
    Err("управление деревьями процессов пока поддерживается на Unix".into())
}

impl Drop for Processes {
    fn drop(&mut self) {
        for owned in self.entries.values_mut() {
            if let Err(error) = terminate(owned) {
                eprintln!("{error}");
            }
        }
    }
}
