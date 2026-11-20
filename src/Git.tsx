import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Icon, IdeDialog } from "./Ide";
import SettingsSelect from "./SettingsSelect";
import FileIcon from "./FileIcon";
import GitDiffView, { type GitComparison } from "./GitDiff";
import GitHistoryView from "./GitHistory";
import GitMenu from "./GitMenu";
import { emptyGitDraft, readGitDraft } from "./gitState";
import type { GitDraft } from "./gitState";
import type { GitBranch, GitChange, GitCommitDetails, GitDiff, GitStash, GitStatus, GitTarget, GitVersion } from "./types";
import "./git.css";

interface Confirmation { title: string; command: string; args: Record<string, unknown>; description?: string; field?: "name" | "message"; value: string; checkout?: boolean }
export interface GitRequest { workspaceId: string; action: "changes" | "history" | "switch" | "create_branch" | "fetch" | "pull" | "push" }

const fileCountForm = new Intl.PluralRules("ru");

function Repository({ target, projectId, open, center, children, referenceChanged, beforeOperation, active, request, requestHandled }: { target: GitTarget; projectId: string; open: (path: string) => void; center?: HTMLElement | null; children: ReactNode; referenceChanged?: (reference: string, repository: string) => void; beforeOperation?: () => Promise<void>; active: boolean; request?: GitRequest | null; requestHandled?: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [mode, setMode] = useState<"changes" | "history">("changes");
  const [comparison, setComparison] = useState<GitComparison | null>(null);
  const [tabs, setTabs] = useState<{ path: string; historical?: string; base?: string; left: number; right: number }[]>([]);
  const [branchComparison, setBranchComparison] = useState<GitCommitDetails | null>(null);
  const [query, setQuery] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [reference, setReference] = useState("");
  const [revision, setRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [remote, setRemote] = useState("");
  const [force, setForce] = useState(false);
  const [amend, setAmend] = useState(false);
  const [amendHead, setAmendHead] = useState("");
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;
  const storageKey = `yade.git:${JSON.stringify([target.workspaceId, target.repository])}`;
  const messageKey = `yade.git.message:${JSON.stringify([projectId, target.repository])}`;
  const [storageError, setStorageError] = useState("");
  const [draft, setDraft] = useState<GitDraft>(() => {
    try { return readGitDraft(storageKey, messageKey); } catch { return emptyGitDraft; }
  });
  const storageReady = useRef(false);
  const mounted = useRef(true);
  const reading = useRef(0);
  const running = useRef(false);
  const branchSelect = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      if (!storageReady.current) readGitDraft(storageKey, messageKey);
      localStorage.setItem(storageKey, JSON.stringify(draft));
      localStorage.setItem(messageKey, JSON.stringify(draft.message));
      storageReady.current = true; setStorageError("");
    } catch (reason) { setStorageError(`Черновик Git не сохранён: ${String(reason)}`); }
  }, [draft, storageKey, messageKey]);

  async function load() {
    const [value, refs, saved] = await Promise.all([
      invoke<GitStatus>("git_status", { target }), invoke<GitBranch[]>("git_branches", { target }), invoke<GitStash[]>("git_stashes", { target }),
    ]);
    if (!mounted.current) return;
    setStatus(value); setBranches(refs); setStashes(saved);
    setReference(current => current && !refs.some(branch => branch.reference === current) ? "" : current);
    referenceChanged?.(value.reference, target.repository);
    setRemote(current => value.remotes.includes(current) ? current : value.remotes[0] ?? "");
    setRevision(current => current + 1);
    return value;
  }
  async function refresh() {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); ++reading.current;
    const viewed = comparisonRef.current;
    setComparison(current => current ? { ...current, diff: null } : null);
    try { await beforeOperation?.(); const value = await load(); await restoreComparison(viewed, value); } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function run(command: string, args: Record<string, unknown>, pushAfter = false) {
    if (running.current) return;
    if (pushAfter || (args.action as { kind?: string } | undefined)?.kind === "push") setForce(false);
    running.current = true; setBusy(true); setError(""); setResult(""); ++reading.current;
    const viewed = comparisonRef.current;
    const isCommit = command === "commit_git" || (args.action as { kind?: string } | undefined)?.kind === "amend";
    setComparison(current => current ? { ...current, diff: null } : null);
    try {
      await beforeOperation?.();
      const output = await invoke<string | null>(command, { target, ...args });
      if (mounted.current) {
        setResult(output || "");
        if (isCommit) {
          setDraft(current => ({ ...current, message: "", messages: [current.message, ...(current.messages ?? []).filter(message => message !== current.message)].slice(0, 20) }));
          setAmend(false);
        }
      }
      if (pushAfter) {
        const output = await invoke<string>("git_action", { target, action: { kind: "push", remote: status?.upstream ? null : remote, force } });
        if (mounted.current) setResult(output || "Коммиты отправлены.");
      }
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally {
      try { const value = await load(); await restoreComparison(viewed, value); } catch (reason) { if (mounted.current) setError(current => `${current}\nСостояние Git не прочитано: ${String(reason)}`); }
      running.current = false; if (mounted.current) setBusy(false);
    }
  }
  async function restoreComparison(viewed: GitComparison | null, value?: GitStatus) {
    if (!mounted.current || !viewed || viewed.historical || !value) return;
    const change = value.changes.find(change => change.path === viewed.path);
    if (!change) { setComparison(null); return; }
    const prepared = change.worktree === " " && !change.conflict;
    await compare(viewed.path, change.conflict ? viewed.left : prepared ? 0 : 1, change.conflict ? viewed.right : prepared ? 1 : 2, undefined, undefined, value);
  }
  async function compare(path: string, left = 0, right = 2, historical?: string, base?: string, snapshot?: GitStatus) {
    const id = ++reading.current;
    if (!snapshot) setError(""); setBusy(true);
    try {
      await beforeOperation?.();
      const versions = await invoke<GitVersion[]>(historical ? "git_revision_versions" : "git_versions", { target, path, ...(historical ? { reference: historical, base: base ?? null } : {}) });
      let diff: GitDiff | null = null;
      const change = (snapshot ?? status)?.changes.find(change => change.path === path);
      if (!historical && right === 2 && change && !change.conflict && change.worktree !== " ") diff = await invoke<GitDiff>("git_diff", { target, path });
      if (!mounted.current || id !== reading.current) return;
      setComparison({ path, versions, left, right, diff, historical, base });
      setTabs(current => current.some(tab => tab.path === path && tab.historical === historical && tab.base === base) ? current : [...current, { path, historical, base, left, right }]);
    } catch (reason) { if (mounted.current && id === reading.current) setError(current => snapshot && current ? `${current}\nСравнение не обновлено: ${String(reason)}` : String(reason)); }
    finally { if (mounted.current && id === reading.current) setBusy(false); }
  }
  async function compareBranch(base = reference) {
    if (!base) return;
    const id = ++reading.current;
    setBusy(true); setError(""); setComparison(null);
    try {
      const value = await invoke<GitCommitDetails>("git_compare_branches", { target, base, reference: "HEAD" });
      if (mounted.current && id === reading.current) setBranchComparison(value);
    } catch (reason) { if (mounted.current && id === reading.current) setError(String(reason)); }
    finally { if (mounted.current && id === reading.current) setBusy(false); }
  }
  function confirmAction(kind: string, reference: string, title: string) {
    setConfirmation({ title, command: "git_action", args: { action: { kind, ...(kind === "create_branch" ? { start: reference } : { reference }) } }, field: ["create_branch", "create_tag"].includes(kind) ? "name" : undefined, value: "", description: kind === "create_branch" && reference === "HEAD" ? undefined : branches.find(branch => branch.reference === reference)?.name ?? reference, checkout: kind === "create_branch" ? true : undefined });
  }
  function network(kind: "fetch" | "pull" | "push", pushForce = force) {
    if (kind === "push" && !status?.upstream && status?.remotes.length !== 1) setConfirmation({ title: "Отправить коммиты", command: "push", args: {}, value: "", description: `Ветка ${status?.reference}` });
    else void run("git_action", { action: { kind, ...(kind === "push" ? { remote: status?.upstream ? null : remote, force: pushForce } : {}) } });
  }
  async function submitConfirmation() {
    if (!confirmation) return;
    const value = confirmation; setConfirmation(null);
    if (value.command === "list") { setDraft(current => ({ ...current, lists: [...current.lists, { id: crypto.randomUUID(), name: value.value.trim() }] })); return; }
    if (value.command === "rename_list") { setDraft(current => ({ ...current, lists: current.lists.map(list => list.id === value.args.id ? { ...list, name: value.value.trim() } : list) })); return; }
    if (value.command === "delete_list") { setDraft(current => ({ ...current, lists: current.lists.filter(list => list.id !== value.args.id), assignments: Object.fromEntries(Object.entries(current.assignments).filter(([, id]) => id !== value.args.id)) })); return; }
    if (value.command === "push") { await run("git_action", { action: { kind: "push", remote, force } }); return; }
    if (value.command === "commit_push") { await run(amend ? "git_action" : "commit_git", amend ? { action: { kind: "amend", message: draft.message, reference: amendHead } } : { message: draft.message }, true); return; }
    const args = value.field ? { ...value.args, action: { ...(value.args.action as object), [value.field]: value.value.trim(), ...(value.checkout !== undefined ? { checkout: value.checkout } : {}) } } : value.args;
    await run(value.command, args);
  }
  function commit(pushAfter: boolean) {
    if (pushAfter && !status?.upstream && status?.remotes.length !== 1) setConfirmation({ title: "Коммит и отправка", command: "commit_push", args: {}, value: "", description: `Ветка ${status?.reference}. Будет создан коммит подготовленных изменений и выполнена отправка.` });
    else void run(amend ? "git_action" : "commit_git", amend ? { action: { kind: "amend", message: draft.message, reference: amendHead } } : { message: draft.message }, pushAfter);
  }
  async function toggleAmend(checked: boolean) {
    setAmend(checked); setAmendHead("");
    if (!checked) return;
    setBusy(true); setError("");
    try {
      const details = await invoke<GitCommitDetails>("git_commit_details", { target, reference: "HEAD" });
      if (mounted.current) { setAmendHead(details.hash); setDraft(current => current.message.trim() ? current : { ...current, message: details.message.trimEnd() }); }
    } catch (reason) { if (mounted.current) { setError(String(reason)); setAmend(false); } }
    finally { if (mounted.current) setBusy(false); }
  }
  function edit(path: string) { open(target.repository ? `${target.repository}/${path}` : path); }
  async function requestDiscard(path: string) {
    setBusy(true); setError("");
    try {
      await beforeOperation?.();
      const expected = await invoke<GitDiff>("git_diff", { target, path });
      if (mounted.current) setConfirmation({ title: "Откатить изменения файла?", command: "discard_git_file", args: { expected }, description: `${path}\nНеподготовленные изменения будут потеряны. Неотслеживаемый файл будет удалён.`, value: "" });
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function showMode(next: "changes" | "history") {
    ++reading.current;
    if (!running.current) setBusy(false);
    setMode(next); setComparison(null); setBranchComparison(null);
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; ++reading.current; }; }, []);
  useEffect(() => setForce(false), [status?.reference]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    function focus() { if (!document.hidden && !running.current) void refresh(); }
    window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus);
  }, [active]);
  useEffect(() => {
    if (!request || !status || busy || running.current || !active) return;
    requestHandled?.();
    if (request.action === "changes") showMode("changes");
    else if (request.action === "history") { setReference(branches.find(branch => branch.current)?.reference ?? "HEAD"); showMode("history"); }
    else if (request.action === "switch") branchSelect.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
    else if (request.action === "create_branch") confirmAction("create_branch", "HEAD", "Новая ветка");
    else if (!status.remotes.length) setError("Не настроен удалённый репозиторий.");
    else if (request.action === "pull" && !status.upstream) setError("Для текущей ветки не настроена отслеживаемая удалённая ветка.");
    else { setForce(false); network(request.action, false); }
  }, [request, busy, status, active]);
  const changes = status?.changes ?? [];
  const staged = changes.filter(c => c.index !== " " && c.index !== "?" && !c.conflict);
  const conflicts = changes.filter(c => c.conflict);
  const visibleChanges = changes.filter(c => !c.conflict && c.path.toLowerCase().includes(query.toLowerCase()));
  const visibleStaged = visibleChanges.filter(c => c.index !== " " && c.index !== "?");
  const grouped = draft.lists.length > 1 || draft.lists[0].name !== "Изменения";
  const changeLists = grouped
    ? [...draft.lists.map(list => ({ ...list, files: visibleChanges.filter(c => c.index !== "?" && listId(c.path) === list.id) })), { id: "untracked", name: "Новые файлы", files: visibleChanges.filter(c => c.index === "?") }]
    : [{ ...draft.lists[0], files: visibleChanges }];
  const commitDisabled = busy || (!staged.length && !amend) || (amend && !amendHead) || !draft.message.trim() || !!conflicts.length;
  const showHistory = mode === "history" && !comparison && !branchComparison;
  function listId(path: string) { return Object.hasOwn(draft.assignments, path) ? draft.assignments[path] : "default"; }
  function fileRow(change: GitChange) {
    const prepared = change.index !== " " && change.index !== "?";
    const partial = prepared && change.worktree !== " ";
    const slash = change.path.lastIndexOf("/");
    const added = change.index === "A" || change.index === "?" || change.worktree === "A";
    const deleted = change.index === "D" || change.worktree === "D";
    return <GitMenu key={change.path} className={`git-change-file ${deleted ? "deleted" : added ? "added" : ""}`} label={`Действия файла ${change.path}`} disabled={busy || !active} items={[
      { label: "Открыть в редакторе", icon: "file", run: () => edit(change.path) },
      { label: "Включить файл целиком", icon: "plus", disabled: change.worktree === " ", run: () => void run("stage_git_files", { paths: [change.path] }) },
      { label: "Исключить из коммита", icon: "minus", disabled: !prepared, run: () => void run("unstage_git_files", { paths: [change.path] }) },
      { label: "Сравнить подготовленные изменения", icon: "layout", disabled: !prepared, run: () => void compare(change.path, 0, 1) },
      { label: "Откатить неподготовленные изменения…", icon: "history", disabled: change.worktree === " ", run: () => void requestDiscard(change.path) },
      ...draft.lists.filter(list => list.id !== listId(change.path)).map(list => ({ label: `В набор «${list.name}»`, icon: "layers", disabled: change.index === "?", run: () => setDraft(current => ({ ...current, assignments: { ...current.assignments, [change.path]: list.id } })) })),
    ]}><div className="git-file-row">
      <input type="checkbox" aria-label={`${prepared ? "Исключить из коммита" : "Включить в коммит"} ${change.path}`} checked={prepared} ref={input => { if (input) input.indeterminate = partial; }} disabled={busy} onChange={() => void run(prepared ? "unstage_git_files" : "stage_git_files", { paths: [change.path] })} />
      <button disabled={busy && running.current} aria-current={comparison?.path === change.path ? "true" : undefined} aria-label={`${prepared && !partial ? "Подготовленные" : "Неподготовленные"} ${change.path}`} onClick={() => { setMode("changes"); void compare(change.path, prepared && !partial ? 0 : 1, prepared && !partial ? 1 : 2); }} onDoubleClick={() => edit(change.path)} onKeyDown={event => {
        if (event.key === "F4") { event.preventDefault(); edit(change.path); }
        if (["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); const rows = [...event.currentTarget.closest(".git-changes-tree")!.querySelectorAll<HTMLButtonElement>(".git-file-row > button")].filter(button => button.closest("details")?.open ?? true);
          const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)]; next?.focus(); next?.click();
        }
      }} title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}>
        <FileIcon path={change.path} />
        <span className="git-file-label">
          <span className="git-file-name">{change.path.slice(slash + 1)}</span>
          {slash !== -1 && <small className="git-file-path">{change.path.slice(0, slash)}</small>}
        </span>
        <code className="git-file-status">{prepared ? change.index : change.worktree === "?" ? "+" : change.worktree}</code>
      </button>
    </div></GitMenu>;
  }

  const main = <div className="git-main">
    <div className="git-tabs" role="tablist" aria-label="Вкладки Git">
      {tabs.map((tab, index) => {
        const selected = comparison?.path === tab.path && comparison.historical === tab.historical && comparison.base === tab.base;
        return <div className={`git-tab ${selected ? "active" : ""}`} key={`${tab.historical}:${tab.base}:${tab.path}`}><button role="tab" aria-selected={selected} disabled={busy} onClick={() => { setMode(tab.historical ? "history" : "changes"); void compare(tab.path, tab.left, tab.right, tab.historical, tab.base); }}><FileIcon path={tab.path} />{tab.path.split("/").at(-1)}{tab.historical && <small>{tab.historical.slice(0, 7)}</small>}</button><button aria-label={`Закрыть сравнение ${tab.path}`} disabled={busy} onClick={() => { setTabs(current => current.filter((_, i) => i !== index)); if (selected) setComparison(null); }}><Icon name="close" /></button></div>;
      })}
      {mode === "history" && <div className={`git-tab ${!comparison ? "active" : ""}`}><button role="tab" aria-selected={!comparison} onClick={() => showMode("history")}><Icon name="history" />История коммитов</button></div>}
      {!tabs.length && mode === "changes" && <div className="git-tab active"><span><Icon name="git" />Изменения</span></div>}
    </div>
    {(error || storageError || result || busy) && <div className="git-notices">
      {busy && <span className="ide-visually-hidden" role="status">Выполняется операция Git…</span>}{error && <pre className="git-notice error" role="alert">{error}</pre>}{storageError && <p className="git-notice error" role="alert">{storageError}</p>}
      {result && <div className="git-result"><pre role="status">{result.trim()}</pre><button className="ide-icon-button" aria-label="Закрыть результат Git" onClick={() => setResult("")}><Icon name="close" /></button></div>}
    </div>}
    {status?.operation && <div className="git-operation"><Icon name="info" /><span>Незавершённая операция: {({ merge: "слияние", rebase: "перебазирование", cherry_pick: "применение коммита", revert: "отмена коммита" } as Record<string, string>)[status.operation]}. {conflicts.length ? "Разрешите конфликты и подготовьте файлы." : "Изменения готовы к продолжению."}</span><button disabled={busy || !!conflicts.length} onClick={() => void run("git_action", { action: { kind: "continue" } })}>Продолжить</button><button disabled={busy} onClick={() => setConfirmation({ title: "Прервать операцию Git?", command: "git_action", args: { action: { kind: "abort" } }, description: "Git вернёт состояние до начала операции. Правки, сделанные при разрешении конфликтов, могут быть потеряны.", value: "" })}>Прервать…</button></div>}
    {status && mode === "history" && <div className="git-history-host" hidden={!showHistory}><GitHistoryView target={target} status={status} branches={branches} reference={reference} revision={revision} busy={busy} active={showHistory && active} compare={(hash, path) => void compare(path, 0, 1, hash)} action={confirmAction} network={network} /></div>}
    {branchComparison && !comparison ? <section className="git-branch-comparison"><div className="git-file-toolbar"><Icon name="git" /><strong>Сравнение веток</strong><span className="ide-toolbar-spacer" /><button onClick={() => setBranchComparison(null)}>Вернуться к истории</button></div><p className="git-empty">{branchComparison.message.slice(0, 8)} → {branchComparison.hash.slice(0, 8)} · {branchComparison.files.length} файлов</p><div className="git-commit-files">{branchComparison.files.map(file => <button key={file.path} disabled={busy} onClick={() => void compare(file.path, 0, 1, branchComparison.hash, branchComparison.message)}><FileIcon path={file.path} /><span>{file.path}</span><small className="git-added">+{file.added ?? "—"}</small><small className="git-deleted">−{file.deleted ?? "—"}</small></button>)}</div>{!branchComparison.files.length && <p className="git-empty">Ветки содержат одинаковые файлы</p>}</section> : showHistory ? null : <>
      {comparison ? <>
        <GitDiffView key={`${comparison.path}:${comparison.historical}`} comparison={comparison} change={setComparison} busy={busy || !active} stage={(expected, hunk) => void run("stage_git_hunk", { expected, hunk })}
          previous={changes.findIndex(change => change.path === comparison.path) > 0 ? () => { const change = changes[changes.findIndex(change => change.path === comparison.path) - 1]; void compare(change.path, change.conflict ? 0 : change.worktree === " " ? 0 : 1, change.conflict ? 1 : change.worktree === " " ? 1 : 2); } : undefined}
          next={changes.findIndex(change => change.path === comparison.path) < changes.length - 1 && !comparison.historical ? () => { const change = changes[changes.findIndex(change => change.path === comparison.path) + 1]; void compare(change.path, change.conflict ? 0 : change.worktree === " " ? 0 : 1, change.conflict ? 1 : change.worktree === " " ? 1 : 2); } : undefined}
          discard={expected => setConfirmation({ title: "Откатить изменения файла?", command: "discard_git_file", args: { expected }, description: `${expected.path}\nНеподготовленные изменения будут потеряны. Неотслеживаемый файл будет удалён. Подготовленные изменения сохранятся.`, value: "" })}
          edit={() => open(target.repository ? `${target.repository}/${comparison.path}` : comparison.path)} />
      </> : <div className="git-empty git-empty-main"><Icon name="git" /><p>{changes.length ? "Выберите файл" : "Нет изменений"}</p></div>}
    </>}
  </div>;
  return <>
    <div className="git-sidebar">
      <div className="git-panel-heading"><strong>{mode === "changes" ? "Коммит" : "Git"}</strong><span className="ide-toolbar-spacer" /><button className="ide-icon-button" disabled={busy} aria-label="Обновить Git" title="Обновить" onClick={() => void refresh()}><Icon name="refresh" /></button><GitMenu label="Действия Git" disabled={busy || !active} items={[
        { label: "Получить изменения", icon: "download", disabled: !status?.remotes.length, run: () => network("fetch") },
        { label: "Обновить ветку", icon: "refresh", disabled: !status?.upstream, run: () => network("pull") },
        { label: "Отправить коммиты", icon: "send", disabled: !status?.remotes.length, run: () => network("push") },
        { label: "Новая ветка…", icon: "plus", run: () => confirmAction("create_branch", "HEAD", "Новая ветка") },
        { label: "Создать набор изменений", icon: "layers", run: () => setConfirmation({ title: "Новый набор изменений", command: "list", args: {}, field: "name", value: "" }) },
        { label: amend ? "Не дополнять последний коммит" : "Дополнить последний коммит", icon: amend ? "check" : "edit", disabled: !status || !!status.operation, run: () => void toggleAmend(!amend) },
        { label: force ? "Отключить принудительную отправку" : "Принудительная отправка", icon: force ? "check" : "send", disabled: !status?.remotes.length, run: () => setForce(!force) },
      ]} /></div>
      {children}
      {status && <>
        <div className="git-current-branch" ref={branchSelect}><SettingsSelect label="Текущая ветка" hideLabel value={branches.find(b => b.current)?.reference ?? status.reference} allowDefault={false} icon="git" search="Найти ветку…" disabled={busy}
          menuHeader={<button type="button" onClick={() => confirmAction("create_branch", "HEAD", "Новая ветка")}><Icon name="plus" />Новая ветка…</button>}
          choices={[...branches.map(branch => ({ value: branch.reference, label: branch.name })), ...(!branches.some(b => b.current) ? [{ value: status.reference, label: status.reference.slice(0, 12) }] : [])]}
          change={value => { if (value && value !== (branches.find(b => b.current)?.reference ?? status.reference)) void run("git_action", { action: { kind: "switch", reference: value } }); }} /></div>
        <div className="git-mode-tabs" role="tablist" aria-label="Режим Git"><button role="tab" aria-selected={mode === "changes"} onClick={() => showMode("changes")}>Изменения <small>{changes.length}</small></button><button role="tab" aria-selected={mode === "history"} onClick={() => showMode("history")}>История</button></div>
        {mode === "changes" ? <>{!changes.length && !amend ? <div className="git-clean-state">
          <span className="git-clean-icon"><Icon name="check" /></span><strong>Нет изменений</strong>
          <p>В рабочей папке нет изменённых<br />или новых файлов.</p>
          <button onClick={() => showMode("history")}>Посмотреть историю <Icon name="arrow-right" /></button>
        </div> : <>
          {!!changes.length && <div className="git-sidebar-search"><label className="git-search"><Icon name="search" /><input aria-label="Найти изменённый файл" placeholder="Найти файл…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>}
          <div className="git-changes-tree">
            {!!conflicts.length && <section className="git-conflicts" aria-label="Конфликты Git"><h3>Конфликты <small>{conflicts.length}</small></h3>{conflicts.map(change => <div className="git-conflict-file" key={change.path}><button disabled={busy} aria-label={`Версии конфликта ${change.path}`} onClick={() => void compare(change.path, 0, 1)}><FileIcon path={change.path} />{change.path}</button><button disabled={busy} aria-label={`Редактировать ${change.path}`} onClick={() => open(target.repository ? `${target.repository}/${change.path}` : change.path)}><Icon name="file" /></button><button disabled={busy} aria-label={`Подготовить результат ${change.path}`} title="Подготовить результат" onClick={() => void run("stage_git_files", { paths: [change.path] })}><Icon name="check" /></button></div>)}</section>}
            {grouped && !!visibleChanges.length && <label className="git-selection-summary"><input type="checkbox" aria-label={visibleStaged.length === visibleChanges.length ? "Исключить все файлы" : "Включить все файлы"} checked={visibleStaged.length === visibleChanges.length} ref={input => { if (input) input.indeterminate = !!visibleStaged.length && visibleStaged.length < visibleChanges.length; }} disabled={busy}
              onChange={() => void run(visibleStaged.length === visibleChanges.length ? "unstage_git_files" : "stage_git_files", { paths: visibleChanges.map(c => c.path) })} />Выбрано {visibleStaged.length} из {visibleChanges.length}</label>}
            {changeLists.map(list => {
              const count = list.files.length;
              if (!count && (!grouped || list.id === "untracked")) return null;
              const included = list.files.filter(c => c.index !== " " && c.index !== "?").length;
              const checked = count > 0 && included === count;
              const form = fileCountForm.select(count);
              return <details key={list.id} className="git-change-list" open><summary>
                <Icon name="chevron" />
                <input type="checkbox" aria-label={`${checked ? "Исключить" : "Включить"} ${grouped ? `набор ${list.name}` : "все файлы"}`} title={`Выбрано ${included} из ${count}`} checked={checked} ref={input => { if (input) input.indeterminate = included > 0 && !checked; }} disabled={busy || !count}
                  onClick={event => event.stopPropagation()} onChange={() => void run(checked ? "unstage_git_files" : "stage_git_files", { paths: list.files.map(c => c.path) })} />
                <strong>{list.name}</strong><small>{count} {form === "one" ? "файл" : form === "few" ? "файла" : "файлов"}</small>
                {grouped && list.id !== "untracked" && <GitMenu label={`Действия набора ${list.name}`} disabled={busy || !active} items={[
                  { label: "Переименовать набор…", icon: "edit", run: () => setConfirmation({ title: "Переименовать набор", command: "rename_list", args: { id: list.id }, field: "name", value: list.name }) },
                  { label: "Удалить набор…", icon: "trash", disabled: list.id === "default", run: () => setConfirmation({ title: "Удалить набор изменений?", command: "delete_list", args: { id: list.id }, value: "", description: "Файлы сохранятся и вернутся в основной набор." }) },
                ]} />}
              </summary>{list.files.map(fileRow)}</details>;
            })}
            {!!query && !visibleChanges.length && <p className="git-empty">Файлы не найдены</p>}
          </div>
          <form className="git-commit-form" onSubmit={event => { event.preventDefault(); commit(false); }}>
            <div className="git-commit-label"><label>Сообщение коммита<textarea aria-label="Сообщение коммита" placeholder="Введите сообщение…" value={draft.message} disabled={busy} onChange={event => setDraft(current => ({ ...current, message: event.target.value }))} required onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !commitDisabled) { event.preventDefault(); commit(false); } }} /></label>
              {!!draft.messages?.length && <GitMenu icon="history" label="История сообщений коммита" disabled={busy} items={draft.messages.map(message => ({ label: message, run: () => setDraft(current => ({ ...current, message })) }))} />}
            </div>
            <div className="git-commit-buttons"><button className="git-primary" type="submit" title="⌘Enter / Ctrl+Enter" disabled={commitDisabled}><Icon name="commit" />{amend ? "Дополнить коммит" : "Создать коммит"}</button><GitMenu className="git-commit-menu" icon="chevron" label="Действия коммита" disabled={busy} items={[
              { label: "Коммит и отправка", icon: "send", disabled: commitDisabled || !status.remotes.length, run: () => commit(true) },
              { label: amend ? "Не дополнять последний коммит" : "Дополнить последний коммит", icon: amend ? "check" : "edit", disabled: !!status.operation, run: () => void toggleAmend(!amend) },
              { label: force ? "Отключить принудительную отправку" : "Принудительная отправка", icon: force ? "check" : "send", disabled: !status.remotes.length, run: () => setForce(!force) },
            ]} /></div>
            <small className="git-commit-hint">{force ? "Включена принудительная отправка · " : ""}{amend ? "Дополнение последнего коммита" : `Файлов в коммите: ${staged.length}`}</small>
          </form>
        </>}</> : <>
          <div className="git-sidebar-search"><label className="git-search"><Icon name="search" /><input aria-label="Найти ветку" placeholder="Найти ветку…" value={branchQuery} onChange={event => setBranchQuery(event.target.value)} /></label><button className="ide-icon-button" aria-label="Создать ветку" disabled={busy} onClick={() => confirmAction("create_branch", "HEAD", "Новая ветка")}><Icon name="plus" /></button></div>
          <div className="git-branches"><button className={`git-branch-row ${!reference ? "selected" : ""}`} onClick={() => setReference("")}><Icon name="git" />Все ветки</button>
            {([["local", "Локальные"], ["remote", "Удалённые"], ["tag", "Теги"]] as const).map(([kind, title]) => <details key={kind} open={kind !== "tag"}><summary>{title}<small>{branches.filter(b => b.kind === kind).length}</small></summary>{branches.filter(b => b.kind === kind && b.name.toLowerCase().includes(branchQuery.toLowerCase())).map(branch => <GitMenu key={branch.reference} label={`Действия ветки ${branch.name}`} disabled={busy || !active} items={[
              { label: "Переключиться", icon: "git", disabled: branch.current, run: () => void run("git_action", { action: { kind: "switch", reference: branch.reference } }) },
              { label: "Сравнить с текущей", icon: "layout", disabled: branch.current, run: () => void compareBranch(branch.reference) },
              { label: "Слить в текущую ветку…", icon: "git", disabled: branch.current, run: () => confirmAction("merge", branch.reference, `Слить в ${status.reference}?`) },
              { label: "Новая ветка отсюда…", icon: "plus", run: () => confirmAction("create_branch", branch.reference, "Новая ветка") },
              { label: "Удалить…", icon: "trash", disabled: branch.current || branch.kind === "remote", run: () => setConfirmation({ title: branch.kind === "tag" ? "Удалить локальный тег?" : "Удалить ветку?", command: "git_action", args: { action: { kind: branch.kind === "tag" ? "delete_tag" : "delete_branch", name: branch.name } }, value: "", description: branch.name }) },
            ]}><button className={`git-branch-row ${reference === branch.reference ? "selected" : ""}`} onClick={() => setReference(branch.reference)} onDoubleClick={() => { if (!branch.current) void run("git_action", { action: { kind: "switch", reference: branch.reference } }); }} title={branch.upstream ? `Отслеживает ${branch.upstream}` : branch.name}><Icon name={kind === "remote" ? "cloud" : kind === "tag" ? "tag" : "git"} /><span>{branch.name}</span>{branch.current && <Icon name="check" />}</button></GitMenu>)}</details>)}
            <details className="git-stashes"><summary>Отложенные изменения <small>{stashes.length}</small></summary><button className="git-secondary" disabled={busy || !changes.length} onClick={() => setConfirmation({ title: "Сохранить изменения в stash", command: "git_action", args: { action: { kind: "stash_save" } }, field: "message", value: "Незавершённая работа", description: "Подготовленные, неподготовленные и неотслеживаемые файлы будут сохранены. Рабочая копия станет чистой." })}>Сохранить текущие изменения…</button>{stashes.map(stash => <div className="git-stash" key={stash.hash}><strong>{stash.message}</strong><div className="git-stash-actions"><button className="git-secondary" disabled={busy} onClick={() => setConfirmation({ title: "Восстановить отложенные изменения?", command: "git_action", args: { action: { kind: "stash_apply", reference: stash.reference, hash: stash.hash } }, value: "", description: `${stash.message}. Запись останется в stash после применения.` })}>Применить…</button><button className="ide-icon-button" disabled={busy} aria-label={`Удалить ${stash.reference}`} title="Удалить отложенные изменения" onClick={() => setConfirmation({ title: "Удалить отложенные изменения?", command: "git_action", args: { action: { kind: "stash_drop", reference: stash.reference, hash: stash.hash } }, value: "", description: stash.message })}><Icon name="trash" /></button></div></div>)}</details>
          </div>
        </>}

      </>}
    </div>
    {center ? createPortal(main, center) : center === undefined ? main : null}
    {confirmation && <IdeDialog title={confirmation.title} className="git-confirm-dialog" close={() => setConfirmation(null)}><form onSubmit={event => { event.preventDefault(); void submitConfirmation(); }}>
      {confirmation.description && <p>{confirmation.description}</p>}{confirmation.field && <label>{confirmation.field === "name" ? "Название" : "Описание"}<input autoFocus value={confirmation.value} onChange={event => setConfirmation({ ...confirmation, value: event.target.value })} required /></label>}
      {confirmation.checkout !== undefined && <label className="confirmation"><input type="checkbox" checked={confirmation.checkout} onChange={event => setConfirmation({ ...confirmation, checkout: event.target.checked })} />Переключиться на новую ветку</label>}
      {["push", "commit_push"].includes(confirmation.command) && <><SettingsSelect label="Удалённый репозиторий" allowDefault={false} value={remote} choices={(status?.remotes ?? []).map(name => ({ value: name, label: name }))} change={value => setRemote(value ?? "")} /><label className="confirmation"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />Принудительная отправка</label></>}
      <div className="git-confirm-buttons"><button type="button" onClick={() => setConfirmation(null)}>Отмена</button><button className="git-primary" type="submit" disabled={busy || (!!confirmation.field && !confirmation.value.trim()) || (["push", "commit_push"].includes(confirmation.command) && !remote)}>Подтвердить</button></div>
    </form></IdeDialog>}
  </>;
}

export default function Git({ workspaceId, projectId = workspaceId, open, embedded = false, active = true, center, referenceChanged, beforeOperation, request, requestHandled }: { workspaceId: string; projectId?: string; open: (path: string) => void; embedded?: boolean; active?: boolean; center?: HTMLElement | null; referenceChanged?: (reference: string, repository: string) => void; beforeOperation?: () => Promise<void>; request?: GitRequest | null; requestHandled?: () => void }) {
  const [expanded, setExpanded] = useState(embedded && active);
  const [repositories, setRepositories] = useState<string[] | null>(null);
  const [repository, setRepository] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (embedded && active) setExpanded(true); }, [embedded, active]);
  useEffect(() => { if (request) { setExpanded(true); setRepository(""); } }, [request]);
  useEffect(() => {
    if (!expanded) return;
    let ignore = false; setRepositories(null); setError("");
    invoke<string[]>("list_git_repositories", { workspaceId }).then(paths => { if (!ignore) { setRepositories(paths); setRepository(paths[0] ?? ""); } }).catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; };
  }, [workspaceId, expanded]);
  const message = error ? <p className="git-empty" role="alert">{error}</p> : repositories?.length === 0 ? <p className="git-empty">В пространстве нет Git-репозиториев. Вложенные проекты добавляются в группу отдельно.</p> : <p className="git-empty" role="status">Загрузка репозитория…</p>;
  return <section className={`git-workspace ${center === undefined ? "standalone" : ""}`} aria-label="Git пространства">
    {!embedded && <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Git</button>}
    {expanded && (repositories?.length ? <Repository key={`${workspaceId}:${repository}`} target={{ workspaceId, repository }} projectId={projectId} open={open} center={center} referenceChanged={referenceChanged} beforeOperation={beforeOperation} active={active} request={!repository ? request : null} requestHandled={requestHandled}>
      {repositories.length > 1 && <div className="git-repository-select"><SettingsSelect label="Репозиторий" value={repository} allowDefault={false} change={value => setRepository(value ?? "")} choices={repositories.map(path => ({ value: path, label: path || "." }))} /></div>}
    </Repository> : <>{message}{center && createPortal(message, center)}</>)}
  </section>;
}
