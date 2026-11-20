use crate::notifications::Kind;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "macos"))]
use std::process::Command;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
#[path = "terminal_observer_macos.rs"]
mod macos;

const QUIET: Duration = Duration::from_secs(1);
const PROCESS_INTERVAL: Duration = Duration::from_secs(3);
const MAX_ROWS: u16 = 300;
const MAX_COLS: u16 = 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Execution {
    pub executor: String,
    pub state: String,
    #[serde(default)]
    pub title: Option<String>,
}

pub(crate) struct TitleRequest {
    pub pid: u32,
    pub executor: String,
    pub input: String,
    pub answer: String,
}

#[derive(Default)]
struct TerminalSignals {
    version: u64,
    title: String,
    title_version: u64,
    program_status: Option<(u64, &'static str)>,
}

impl vt100::Callbacks for TerminalSignals {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.version += 1;
        self.title = String::from_utf8_lossy(title).chars().take(512).collect();
        self.title_version = self.version;
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        let [b"7501", payload] = params else {
            return;
        };
        if *payload == b"state=clear" {
            self.program_status = None;
            return;
        }
        let mut fields = payload.split(|&byte| byte == b':');
        let state = fields.next();
        if fields.next() != Some(b"app=codex") {
            return;
        }
        let status = match state {
            Some(b"state=idle" | b"state=done") => "ready",
            Some(b"state=working") => "running",
            Some(b"state=blocked") => "waiting",
            Some(b"state=error") => "failed",
            _ => return,
        };
        self.version += 1;
        self.program_status = Some((self.version, status));
    }
}

pub(crate) struct Observer {
    pub root_pid: u32,
    parser: vt100::Parser<TerminalSignals>,
    process: Option<(u32, &'static str)>,
    body: String,
    screen_dirty: bool,
    screen_state: &'static str,
    changed_at: Instant,
    title_floor: u64,
    program_status_floor: u64,
    output_version: u64,
    observed_version: u64,
    input_version: Option<u64>,
    launch_version: Option<(u64, u64)>,
    unknown_since: Option<Instant>,
    pub backpressured: bool,
    oversized: bool,
    title_input: Option<String>,
    title_started: bool,
    title_requested: bool,
    notification_state: String,
}

impl Observer {
    pub fn new(root_pid: u32, rows: u16, cols: u16) -> Self {
        Self {
            root_pid,
            parser: vt100::Parser::new_with_callbacks(
                rows.clamp(1, MAX_ROWS).try_into().unwrap(),
                cols.clamp(1, MAX_COLS).try_into().unwrap(),
                0,
                TerminalSignals::default(),
            ),
            process: None,
            body: String::new(),
            screen_dirty: true,
            screen_state: "unknown",
            changed_at: Instant::now(),
            title_floor: 0,
            program_status_floor: 0,
            output_version: 0,
            observed_version: 0,
            input_version: None,
            launch_version: None,
            unknown_since: None,
            backpressured: false,
            oversized: rows > MAX_ROWS || cols > MAX_COLS,
            title_input: None,
            title_started: false,
            title_requested: false,
            notification_state: String::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
        self.output_version += 1;
        self.screen_dirty = true;
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.set_size(
            rows.clamp(1, MAX_ROWS).try_into().unwrap(),
            cols.clamp(1, MAX_COLS).try_into().unwrap(),
        );
        self.oversized = rows > MAX_ROWS || cols > MAX_COLS;
        self.changed_at = Instant::now();
        self.screen_dirty = true;
    }

    pub fn input(&mut self, data: &str) {
        self.changed_at = Instant::now();
        if data.contains('\u{3}')
            && matches!(self.notification_state.as_str(), "running" | "waiting")
        {
            "interrupted".clone_into(&mut self.notification_state);
        }
        if self.process.is_none() && data.contains(['\r', '\n']) {
            self.command();
        }
        if matches!(data, "\r" | "\n") && self.title_input.is_none() && !self.title_requested {
            if let Some((_, executor)) = self.process {
                let body = self.parser.screen().contents();
                let prefix = if executor == "codex" { '›' } else { '❯' };
                // shortcut: видимая строка ввода; для полного сообщения нужен протокол CLI.
                let input = body
                    .lines()
                    .rev()
                    .find(|line| line.trim_start().starts_with(prefix))
                    .and_then(|line| {
                        let text = line.trim().strip_prefix(prefix)?.trim();
                        (!text.is_empty() && text != "Ask Codex to do anything")
                            .then(|| text.chars().take(6000).collect())
                    });
                if !matches!(screen_status(executor, &body, ""), "running" | "waiting") {
                    self.title_input = input;
                }
            }
        }
        if data.contains(['\r', '\n', '\u{3}']) || data == "\u{1b}" {
            self.title_floor = self.parser.callbacks().version;
            self.input_version = Some(self.output_version);
            self.screen_dirty = true;
        }
    }

    pub fn command(&mut self) {
        self.launch_version = Some((self.output_version, self.parser.callbacks().version));
    }

    pub fn refresh(
        &mut self,
        processes: Option<&[Process]>,
        execution: &mut Option<Execution>,
    ) -> (bool, Option<(Kind, &'static str)>) {
        let previous = execution.clone();
        let Some(processes) = processes else {
            if let Some(execution) = execution.as_mut().filter(|_| self.process.is_some()) {
                execution.state = "unknown".into();
            }
            return (previous != *execution, None);
        };
        let Some(root) = processes.iter().find(|p| p.pid == self.root_pid) else {
            if let Some(execution) = execution.as_mut().filter(|_| self.process.is_some()) {
                execution.state = "unknown".into();
            }
            return (previous != *execution, None);
        };
        let current = processes
            .iter()
            .filter(|p| p.live() && p.tty == root.tty && p.tty != "??" && p.tty != "?")
            .filter_map(|p| Some((p, p.executor()?, depth(processes, p.pid, root.pid)?)))
            .max_by_key(|(p, _, depth)| (p.group == root.foreground, *depth));
        let Some((process, executor, _)) = current else {
            if self.process.take().is_some() {
                self.title_floor = self.parser.callbacks().version;
                self.input_version = Some(self.output_version);
                if let Some(execution) = execution {
                    execution.state = "completed".into();
                }
            }
            return (previous != *execution, None);
        };
        let identity = (process.pid, executor);
        let same_process = self.process == Some(identity);
        if !same_process {
            // Вывод запуска может прийти раньше обновления списка процессов.
            let (output, signals) = self
                .launch_version
                .take()
                .unwrap_or((self.output_version, self.parser.callbacks().version));
            self.title_floor = signals;
            self.program_status_floor = signals;
            self.input_version = Some(output);
            self.screen_dirty = true;
            self.unknown_since = None;
            self.title_input = None;
            self.title_started = false;
            self.title_requested = false;
            self.notification_state.clear();
        }
        self.process = Some(identity);
        let mut changed = false;
        if self.screen_dirty {
            let body = self.parser.screen().contents();
            changed = body != self.body;
            if changed {
                self.body = body;
                self.changed_at = Instant::now();
                self.unknown_since = None;
            }
            let signals = self.parser.callbacks();
            self.screen_state = screen_status(
                executor,
                &self.body,
                if signals.title_version > self.title_floor {
                    &signals.title
                } else {
                    ""
                },
            );
            self.screen_dirty = false;
        }
        let output_changed = self.output_version != self.observed_version;
        self.observed_version = self.output_version;
        let confirmed = previous
            .as_ref()
            .filter(|execution| {
                same_process && matches!(execution.state.as_str(), "running" | "waiting" | "ready")
            })
            .map_or("unknown", |execution| execution.state.as_str());
        let program_status = self
            .parser
            .callbacks()
            .program_status
            .filter(|(version, _)| executor == "codex" && *version > self.program_status_floor)
            .map(|(_, status)| status);
        let observed = if self.backpressured {
            "unknown"
        } else if let Some(status) = program_status {
            status
        } else if self
            .input_version
            .is_some_and(|version| self.output_version <= version)
        {
            "unknown"
        } else {
            self.screen_state
        };
        let state =
            if self.oversized || process.group != root.foreground || process.state.starts_with('T')
            {
                self.unknown_since = None;
                "unknown"
            } else if observed == "unknown" {
                let since = self.unknown_since.get_or_insert_with(Instant::now);
                if since.elapsed() < PROCESS_INTERVAL {
                    confirmed
                } else {
                    "unknown"
                }
            } else if program_status.is_none()
                && observed == "ready"
                && self.changed_at.elapsed() < QUIET
            {
                self.unknown_since = None;
                confirmed
            } else {
                self.unknown_since = None;
                observed
            };
        *execution = Some(Execution {
            executor: executor.into(),
            state: state.into(),
            title: previous
                .as_ref()
                .filter(|_| same_process)
                .and_then(|e| e.title.clone()),
        });
        if state == "running" && self.title_input.is_some() {
            self.title_started = true;
        }
        // shortcut: запасной статус определяется по экрану, точное событие требует протокола исполнителя.
        let notification = match (self.notification_state.as_str(), state) {
            (_, "unknown") | ("interrupted", "running" | "waiting") => None,
            (previous, state) if previous == state => None,
            (previous, state) => {
                let notification = match (previous, state) {
                    (_, "waiting") => Some(Kind::Input),
                    ("running" | "waiting", "ready") => Some(Kind::Completion),
                    _ => None,
                };
                state.clone_into(&mut self.notification_state);
                notification
            }
        };
        (
            previous != *execution || (output_changed && (changed || state == "running")),
            notification.map(|kind| (kind, executor)),
        )
    }

    pub fn take_title_request(&mut self, execution: &Execution) -> Option<TitleRequest> {
        // shortcut: завершение определяется по экрану; для точного события нужен протокол CLI.
        if execution.state != "ready"
            || execution.title.is_some()
            || self.title_requested
            || !self.title_started
        {
            return None;
        }
        let (pid, executor) = self.process?;
        let input = self.title_input.as_ref()?;
        let prefix = if executor == "codex" { '›' } else { '❯' };
        let body = self
            .body
            .split_once(&format!("{prefix} {input}"))
            .map_or(self.body.as_str(), |(_, answer)| answer);
        let marker = if executor == "codex" { "•" } else { "⏺" };
        let answer = body.lines().collect::<Vec<_>>();
        let start = answer
            .iter()
            .position(|line| line.trim_start().starts_with(marker))?;
        let answer = answer[start..].join("\n");
        let input = self.title_input.take()?;
        self.title_requested = true;
        Some(TitleRequest {
            pid,
            executor: executor.into(),
            input,
            answer: answer.chars().take(6000).collect(),
        })
    }

    pub fn set_title(
        &self,
        pid: u32,
        executor: &str,
        execution: &mut Option<Execution>,
        title: String,
    ) {
        if self.process == Some((pid, executor)) {
            if let Some(execution) = execution.as_mut().filter(|e| e.title.is_none()) {
                execution.title = Some(title);
            }
        }
    }
}

fn screen_status(executor: &str, body: &str, title: &str) -> &'static str {
    let lines: Vec<_> = body.lines().map(str::trim).collect();
    let composer = lines
        .iter()
        .enumerate()
        .rposition(|(index, line)| match executor {
            "codex" => {
                *line == "› Ask Codex to do anything"
                    || *line == "›"
                    || (line.starts_with("› ") && lines[index + 1..].contains(&"? for shortcuts"))
            }
            "claude" => *line == "❯",
            _ => false,
        });
    // Старые вопросы выше нового поля ввода уже не требуют ответа.
    let tail = lines[composer.map_or(lines.len().saturating_sub(12), |i| i + 1)..]
        .join("\n")
        .to_lowercase();
    let selection = tail.contains("enter to confirm")
        || tail.contains("enter to select")
        || tail.contains("enter select");
    let choices = tail.contains("1.") && tail.contains("2.");
    let question = [
        "would you like to run",
        "would you like to make",
        "do you want to proceed",
        "do you trust",
        "trust this folder",
        "trust the files",
        "implement this plan?",
        "permission required",
        "requires permission",
    ]
    .iter()
    .any(|text| tail.contains(text));
    if (question && (selection || choices)) || (selection && choices) {
        return "waiting";
    }
    let above = &lines[..composer.unwrap_or(lines.len())];
    // shortcut: нижняя панель ограничена 12 строками; при расширении очереди нужны новые правила.
    let footer: Vec<_> = above
        .iter()
        .rev()
        .filter(|line| !line.is_empty())
        .take(if executor == "codex" { 12 } else { 2 })
        .copied()
        .collect();
    if executor == "codex"
        && footer.iter().any(|line| line.ends_with("to answer"))
        && footer.iter().any(|line| {
            line.strip_prefix("? ").is_some_and(|text| {
                text.strip_suffix(" question")
                    .or_else(|| text.strip_suffix(" questions"))
                    .is_some_and(|count| count.parse::<usize>().is_ok_and(|n| n > 0))
            })
        })
    {
        return "waiting";
    }
    let queued = executor == "codex"
        && footer
            .iter()
            .any(|line| *line == "• Queued follow-up inputs");
    let busy = footer
        .iter()
        .take(if queued { 12 } else { 2 })
        .any(|line| line.contains("to interrupt") || line.contains("esc to cancel"));
    let spinner = title.starts_with(|c: char| {
        ('\u{2801}'..='\u{28ff}').contains(&c) || matches!(c, '◐' | '◓' | '◑' | '◒')
    });
    if busy || spinner || (executor == "claude" && title.starts_with(". ")) {
        return "running";
    }
    let claude_idle = executor == "claude" && (title.starts_with('✳') || title.starts_with("* "));
    let loading = lines.iter().take(6).any(|line| {
        *line == "loading" || line.contains("model: loading") || line.contains("directory: loading")
    });
    let ready =
        composer.is_some() && !loading && (executor == "codex" || body.contains("? for shortcuts"));
    if claude_idle || ready {
        "ready"
    } else {
        "unknown"
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Process {
    pid: u32,
    parent: u32,
    group: i32,
    foreground: i32,
    tty: String,
    state: String,
    command: String,
    args: String,
}

impl Process {
    fn live(&self) -> bool {
        !self.state.starts_with(['Z', 'X'])
    }

    fn executor(&self) -> Option<&'static str> {
        let name = Path::new(&self.command).file_name()?.to_str()?;
        if name == "codex" || name.starts_with("codex-") {
            return Some("codex");
        }
        if name == "claude" || self.command.contains("/.local/share/claude/versions/") {
            return Some("claude");
        }
        if name == "node" || name == "nodejs" || name == "bun" {
            let mut args = self.args.split_whitespace();
            match args.next()? {
                "codex" => return Some("codex"),
                "claude" => return Some("claude"),
                _ => {}
            }
            let entry = args.find(|arg| !arg.starts_with('-'))?;
            let entry_name = Path::new(entry).file_name()?.to_str()?;
            if entry_name == "codex" || entry.ends_with("/@openai/codex/bin/codex.js") {
                return Some("codex");
            }
            if entry_name == "claude" || entry.ends_with("/@anthropic-ai/claude-code/cli.js") {
                return Some("claude");
            }
        }
        None
    }
}

fn depth(processes: &[Process], mut pid: u32, root: u32) -> Option<usize> {
    for depth in 0..=processes.len() {
        if pid == root {
            return Some(depth);
        }
        pid = processes.iter().find(|p| p.pid == pid)?.parent;
        if pid == 0 {
            break;
        }
    }
    None
}

type Sample = Option<Arc<Vec<Process>>>;

struct ProcessCache {
    terminals: BTreeMap<u32, String>,
    sample: Option<(Instant, Sample)>,
}

static PROCESS_CACHE: Mutex<ProcessCache> = Mutex::new(ProcessCache {
    terminals: BTreeMap::new(),
    sample: None,
});

pub(crate) struct ProcessScope(u32);

impl ProcessScope {
    pub fn register(pid: u32, tty: Option<&Path>) -> Option<Self> {
        let tty = tty?.strip_prefix("/dev/").ok()?.to_str()?;
        if tty.is_empty() {
            return None;
        }
        let mut cache = PROCESS_CACHE.lock().ok()?;
        cache.terminals.insert(pid, tty.into());
        cache.sample = None;
        Some(Self(pid))
    }
}

impl Drop for ProcessScope {
    fn drop(&mut self) {
        if let Ok(mut cache) = PROCESS_CACHE.lock() {
            cache.terminals.remove(&self.0);
            cache.sample = None;
        }
    }
}

pub(crate) fn sample() -> Sample {
    let mut cache = PROCESS_CACHE.lock().ok()?;
    if cache.terminals.is_empty() {
        return None;
    }
    if let Some((time, rows)) = &cache.sample {
        if time.elapsed() < PROCESS_INTERVAL {
            return rows.clone();
        }
    }
    let terminals: Vec<_> = cache.terminals.values().cloned().collect();
    let rows = read_processes(&terminals).map(Arc::new);
    cache.sample = Some((Instant::now(), rows.clone()));
    rows
}

#[cfg(target_os = "macos")]
fn read_processes(terminals: &[String]) -> Option<Vec<Process>> {
    macos::read(terminals)
}

#[cfg(not(target_os = "macos"))]
fn read_processes(terminals: &[String]) -> Option<Vec<Process>> {
    if terminals.is_empty() {
        return None;
    }
    let output = Command::new("/bin/ps")
        .args([
            "-ww",
            "-t",
            &terminals.join(","),
            "-o",
            "pid=,ppid=,pgid=,tpgid=,tty=,stat=,comm=",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut rows: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some(Process {
                pid: fields.next()?.parse().ok()?,
                parent: fields.next()?.parse().ok()?,
                group: fields.next()?.parse().ok()?,
                foreground: fields.next()?.parse().ok()?,
                tty: fields.next()?.into(),
                state: fields.next()?.into(),
                command: fields.collect::<Vec<_>>().join(" "),
                args: String::new(),
            })
        })
        .collect();
    let interpreters: Vec<_> = rows
        .iter()
        .filter(|p| {
            p.live()
                && p.tty != "??"
                && p.tty != "?"
                && Path::new(&p.command)
                    .file_name()
                    .is_some_and(|name| name == "node" || name == "nodejs" || name == "bun")
        })
        .map(|p| p.pid.to_string())
        .collect();
    if !interpreters.is_empty() {
        let output = Command::new("/bin/ps")
            .args(["-ww", "-p", &interpreters.join(","), "-o", "pid=,args="])
            .output()
            .ok()?;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let line = line.trim_start();
            if let Some((pid, args)) = line.split_once(char::is_whitespace) {
                if let Some(row) = rows
                    .iter_mut()
                    .find(|row| Some(row.pid) == pid.parse().ok())
                {
                    row.args = args.trim_start().into();
                }
            }
        }
    }
    Some(rows)
}

#[cfg(test)]
#[path = "terminal_observer_tests.rs"]
mod tests;
