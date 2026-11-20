import { Comparison } from "./CodeEditor";
import { Icon } from "./Ide";
import SettingsSelect from "./SettingsSelect";
import FileIcon from "./FileIcon";
import GitMenu from "./GitMenu";
import type { GitDiff, GitVersion } from "./types";

export interface GitComparison { path: string; versions: GitVersion[]; left: number; right: number; diff: GitDiff | null; historical?: string; base?: string }

export default function GitDiffView({ comparison, busy, change, stage, discard, edit, previous, next }: {
  comparison: GitComparison; busy: boolean; change: (value: GitComparison) => void;
  stage: (diff: GitDiff, hunk: number) => void; discard: (diff: GitDiff) => void; edit: () => void;
  previous?: () => void; next?: () => void;
}) {
  const { path, versions, left, right, diff } = comparison;
  const errors = [versions[left], versions[right]].filter(v => v.error).map(v => `${v.name}: ${v.error}`).join("\n");
  return <section className="git-diff-view" aria-label={`Версии ${path}`}>
    <div className="git-file-toolbar"><FileIcon path={path} /><span className="git-path">{path}</span><span className="ide-toolbar-spacer" />
      {!comparison.historical && <><button className="ide-icon-button" disabled={busy || !previous} onClick={previous} aria-label="Предыдущий файл" title="Предыдущий файл"><Icon name="arrow-left" /></button><button className="ide-icon-button" disabled={busy || !next} onClick={next} aria-label="Следующий файл" title="Следующий файл"><Icon name="arrow-right" /></button></>}
      {!comparison.historical && <button className="ide-icon-button" disabled={busy} onClick={edit} aria-label={`Редактировать ${path}`} title="Открыть в редакторе · F4"><Icon name="file" /></button>}
      {diff && <GitMenu label="Действия сравнения" disabled={busy} items={[{ label: "Откатить неподготовленные изменения…", icon: "history", run: () => discard(diff) }]} />}
    </div>
    <div className="git-version-toolbar">
      {(["left", "right"] as const).map((side, index) => <SettingsSelect key={side} label={index === 0 ? "Версия слева" : "Версия справа"} hideLabel
        value={String(comparison[side])} allowDefault={false} change={value => change({ ...comparison, [side]: Number(value) })}
        choices={versions.map((version, i) => ({ value: String(i), label: `${version.name}${version.error ? " (недоступна)" : version.text === null ? " (отсутствует)" : ""}` }))} />)}
    </div>
    {errors ? <pre className="git-notice error" role="alert">{errors}</pre> : <Comparison path={path} a={versions[left].text ?? ""} b={versions[right].text ?? ""} navigation busy={busy}
      hunks={left === 1 && right === 2 && diff ? diff : undefined} stageHunk={index => { if (diff) stage(diff, index); }} />}
  </section>;
}
