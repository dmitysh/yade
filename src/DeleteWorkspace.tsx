import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, IdeDialog } from "./Ide";
import type { DeletionCheck, Workspace } from "./types";

export default function DeleteWorkspace({ workspace, inspect, refresh, close }: {
  workspace: Workspace; inspect: () => Promise<DeletionCheck>; refresh: () => Promise<void>; close: () => void;
}) {
  const [check, setCheck] = useState<DeletionCheck | null>(null);
  const [discardWork, setDiscardWork] = useState(false);
  const [working, setWorking] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    inspect().then(value => { if (!ignore) setCheck(value); })
      .catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; };
  }, [workspace.id]);

  function cancel() { if (!working) close(); }

  async function recheck() {
    setWorking(true); setError(""); setCheck(null); setDiscardWork(false);
    try { setCheck(await inspect()); }
    catch (reason) { setError(String(reason)); }
    finally { setWorking(false); }
  }

  async function remove() {
    if (working || (!removed && (!check || (needsDiscard && !discardWork)))) return;
    setWorking(true); setError("");
    try {
      if (!removed) {
        await invoke("delete_workspace", { expected: check, confirmed: true, discardWork });
        setRemoved(true);
      }
      await refresh();
      close();
    } catch (reason) { setError(String(reason)); }
    finally { setWorking(false); }
  }

  const needsDiscard = check?.kind === "worktree" && (!!check.drafts.length || !!check.changes || !!check.unmerged);

  return <IdeDialog title="Удаление пространства" className="new-workspace-dialog delete-workspace-dialog" close={cancel}>
    <div className="new-workspace-project"><Icon name="project" /><span title={workspace.path}>{workspace.name}</span></div>
    <div className="new-workspace-fields workspace-delete-fields">
      <p className="workspace-delete-question">Удалить пространство «{workspace.name}»?</p>
      <p className="path">{workspace.path}</p>
      {!check && !error && <p role="status">Проверка пространства…</p>}
      {check && !removed && <>
        <p>{check.kind === "folder" ? "Будет убрана только запись пространства. Папка и вложенные репозитории останутся на диске."
          : check.registered ? "Папка рабочего дерева Git будет удалена с диска."
            : "Рабочее дерево Git не зарегистрировано: будет убрана только запись пространства. Файлы останутся на диске."}</p>
        {!!check.drafts.length && <><h3>Сохранённые черновики</h3><ul>{check.drafts.map(draft => <li key={draft.id}>{draft.path ?? "Неотправленное сообщение"}</li>)}</ul></>}
        {!!check.changes && <><h3>Изменённые, неотслеживаемые и игнорируемые файлы</h3><pre className="output">{check.changes}</pre></>}
        {!!check.unmerged && <><h3>Коммиты вне исходной ветки или коммита</h3><pre className="output">{check.unmerged}</pre></>}
        <p>История разговоров и сохранённые черновики останутся. {check.branch && `Ветка ${check.branch} сохранится.`}</p>
        {needsDiscard && <label className="confirmation"><input type="checkbox" checked={discardWork} disabled={working} onChange={event => setDiscardWork(event.target.checked)} />Подтверждаю удаление пространства с обнаруженной работой</label>}
      </>}
      {removed && <p role="status">Пространство удалено. Обновите список, чтобы увидеть изменения.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="new-workspace-actions">
      <button disabled={working} onClick={cancel} autoFocus>Отмена</button>
      {error && !removed ? <button disabled={working} onClick={() => void recheck()}>Проверить повторно</button>
        : <button className="workspace-delete-confirm" disabled={working || (!removed && (!check || (needsDiscard && !discardWork)))} onClick={() => void remove()}>{working ? "Удаление…" : removed ? "Обновить список" : "Удалить пространство"}</button>}
    </div>
  </IdeDialog>;
}
