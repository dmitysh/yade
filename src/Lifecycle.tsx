import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flushFiles } from "./Files";
import { flushConversationDrafts } from "./Conversations";

type RecoveredProcess = { id: string; workspaceId: string; pid: number; verified: boolean; error?: string };

export default function Lifecycle({ flushView }: { flushView: () => Promise<void> }) {
  const [requested, setRequested] = useState(false);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recovered, setRecovered] = useState<RecoveredProcess[]>([]);
  const [recoveryError, setRecoveryError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const saveView = useRef(flushView);
  saveView.current = flushView;

  async function reconcile() {
    try {
      setRecovered(await invoke<RecoveredProcess[]>("reconcile_processes"));
      setRecoveryError("");
    } catch (reason) { setRecoveryError(`Прежние процессы не проверены: ${String(reason)}`); }
  }

  useEffect(() => { void reconcile(); }, []);

  async function finish(confirmed: boolean) {
    setBusy(true); setError("");
    try {
      await Promise.all([saveView.current(), flushFiles(), flushConversationDrafts()]);
      await invoke("finish_exit", { confirmed });
    } catch (reason) {
      setError(`Выход не выполнен: ${String(reason)}`);
      setBusy(false);
    }
  }

  useEffect(() => {
    const unlisten = listen("app-exit-requested", () => {
      if (pending.current) return;
      pending.current = true; setRequested(true); setBusy(true); setError("");
      void invoke<boolean>("has_active_work").then(value => {
        setActive(value);
        if (value) setBusy(false);
        else void finish(false);
      }).catch(reason => { setError(`Состояние работы не проверено: ${String(reason)}`); setBusy(false); });
    });
    void unlisten.catch(reason => setError(`Запросы выхода недоступны: ${String(reason)}`));
    return () => { void unlisten.then(stop => stop()).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (requested) dialog.current?.showModal();
  }, [requested]);

  function cancel() {
    if (busy) return;
    pending.current = false; setRequested(false); setError("");
  }

  return <>
    {(recovered.length > 0 || recoveryError) && <section aria-label="Восстановление после сбоя">
      <h2>Проверка прежних процессов</h2>
      <p>Команды не запускались повторно. Прежние процессы не подключаются к новому ядру и не завершаются по сохранённому PID. Проверьте их и завершите оставшуюся работу перед продолжением разговора.</p>
      {recovered.map(process => <p key={process.id}>PID {process.pid}: {process.verified ? "процесс прежнего запуска ещё существует" : "требуется проверка принадлежности процесса или его дочерних процессов"}.
        {process.error && <span role="alert" className="error"> {process.error}</span>}
      </p>)}
      {recoveryError && <p role="alert" className="error">{recoveryError}</p>}
      <button onClick={() => void reconcile()}>Повторить проверку процессов</button>
    </section>}
    {!requested && error && <p role="alert" className="error">{error}</p>}
    {requested && <dialog ref={dialog} aria-labelledby="exit-title" onCancel={event => { event.preventDefault(); cancel(); }}>
      <h2 id="exit-title">Полный выход из Yade</h2>
      {active && <p>Выполняются задачи или требуется проверка прежних процессов. При выходе разговоры, терминалы и подготовка этого запуска будут остановлены. Процессы после сбоя требуют отдельной проверки.</p>}
      {busy && <p role="status">Сохранение состояния и завершение работы…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <button disabled={busy} onClick={() => void finish(true)}>Завершить работу</button>
      <button disabled={busy} onClick={cancel}>Отменить выход</button>
    </dialog>}
  </>;
}
