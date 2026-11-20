import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, IdeDialog } from "./Ide";
import SettingsSelect from "./SettingsSelect";
import type { Project, Workspace } from "./types";

export default function NewWorkspace({ project, close, refresh }: {
  project: Project; close: () => void; refresh: (created?: Workspace) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [branchesError, setBranchesError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const headSelected = sourceRef.trim() === "HEAD";
  const branchName = branch ?? name;

  useEffect(() => { nameInput.current?.focus(); }, []);
  useEffect(() => {
    let ignore = false;
    setBranches([]); setLoadingBranches(true); setBranchesError("");
    invoke<string[]>("project_branches", { projectId: project.id })
      .then(value => {
        if (ignore) return;
        const preferred = ["master", "main"];
        const sorted = [...preferred.filter(branch => value.includes(branch)), ...value.filter(branch => !preferred.includes(branch))];
        setBranches(sorted);
        setSourceRef(current => current || sorted[0] || "");
      })
      .catch(reason => { if (!ignore) setBranchesError(String(reason)); })
      .finally(() => { if (!ignore) setLoadingBranches(false); });
    return () => { ignore = true; };
  }, [project.id]);

  function cancel() { if (!working) close(); }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (working || !name.trim() || !sourceRef.trim() || !branchName.trim() || headSelected) return;
    setWorking(true); setError("");
    let created: Workspace | undefined;
    try {
      created = await invoke<Workspace>("create_worktree", { request: { projectId: project.id, name: name.trim(), sourceRef: sourceRef.trim(), branch: branchName.trim() } });
      close();
    } catch (reason) { setError(String(reason)); }
    finally {
      try { await refresh(created); } catch (reason) { setError(String(reason)); }
      setWorking(false);
    }
  }

  return <IdeDialog title="Новое пространство" className="new-workspace-dialog" close={cancel}>
    <div className="new-workspace-project"><Icon name="project" /><span title={project.path}>{project.name}</span></div>
    <form className="new-workspace-form" onSubmit={create} aria-busy={working}>
      <div className="new-workspace-fields">
        <label htmlFor="workspace-name">Название пространства
          <input id="workspace-name" ref={nameInput} value={name} onChange={event => setName(event.target.value)} placeholder="Например, delivery-fix" disabled={working} required />
        </label>
        <div className="new-workspace-field">
          <label htmlFor="workspace-source">Исходная ветка или коммит</label>
          <div className="new-workspace-source"><Icon name="git" /><input id="workspace-source" value={sourceRef} onChange={event => setSourceRef(event.target.value)} placeholder="Выберите ветку или введите коммит" aria-invalid={headSelected || undefined} aria-describedby={headSelected ? "workspace-source-error" : undefined} disabled={working} required />
            <div className="new-workspace-source-picker"><SettingsSelect label="Выбрать исходную ветку" hideLabel allowDefault={false} search="Найти ветку" value={branches.includes(sourceRef) ? sourceRef : null}
              choices={branches.map(value => ({ value, label: value }))}
              disabled={working || loadingBranches} title={loadingBranches ? "Загрузка веток…" : "Выбрать исходную ветку"} placeholder="Выбрать ветку" change={value => { if (value) setSourceRef(value); }} /></div>
          </div>
          {loadingBranches && <p role="status">Загрузка веток…</p>}
          {headSelected && <p id="workspace-source-error" className="error" role="alert">Выберите ветку или укажите хеш коммита вместо HEAD.</p>}
          {branchesError && <p className="error" role="alert">Не удалось загрузить ветки: {branchesError}. Введите ветку или коммит вручную.</p>}
        </div>
        <div className="new-workspace-field">
          <label htmlFor="workspace-branch">Новая ветка</label>
          <input id="workspace-branch" value={branchName} onChange={event => setBranch(event.target.value)} placeholder="Например, fix/delivery" aria-describedby="workspace-branch-hint" disabled={working} required />
          <div id="workspace-branch-hint" className="new-workspace-preview" aria-live="polite">
            <Icon name="layers" />
            <div>
              <strong>Будет создан отдельный worktree</strong>
              <p>{!sourceRef.trim() ? "Выберите исходную ветку или коммит." : branchName.trim()
                ? <>С новой веткой <code>{branchName.trim()}</code> от <code>{sourceRef.trim()}</code>.</>
                : "Укажите имя новой ветки."}</p>
            </div>
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="new-workspace-actions">
        <button type="button" onClick={cancel} disabled={working}>Отмена</button>
        <button type="submit" disabled={working || !name.trim() || !sourceRef.trim() || !branchName.trim() || headSelected}>{working ? "Создание пространства…" : "Создать пространство"}</button>
      </div>
    </form>
  </IdeDialog>;
}
