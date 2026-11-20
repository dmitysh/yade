import { useState } from "react";
import type { RunEvent } from "./types";
import SettingsSelect from "./SettingsSelect";

export default function ConversationRequest({ request, executor, reply, disabled = false }: {
  request: RunEvent; executor: string; reply: (result: Record<string, unknown>) => Promise<void>; disabled?: boolean;
}) {
  const { method, params } = request.payload;
  const claude = executor === "claude";
  const questions: any[] = method === "question" ? params.input.questions : method === "item/tool/requestUserInput" ? params.questions : [];
  const elicitation = ["elicitation", "mcpServer/elicitation/request"].includes(method);
  const prompt = claude && elicitation ? params.request : params;
  const schema = prompt.requestedSchema ?? {};
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = (q: any) => claude ? q.question : q.id;
  const values = (q: any) => [...(selected[key(q)] ?? []), ...(answers[key(q)]?.trim() ? [answers[key(q)].trim()] : [])];

  async function send(result: Record<string, unknown>) {
    if (disabled || busy) return;
    setBusy(true); setError("");
    try { await reply(result); }
    catch (reason) { setError(`Ответ не принят: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  function accept() {
    if (elicitation) {
      try {
        const content = Object.fromEntries(Object.entries(schema.properties ?? {}).flatMap(([name, field]: [string, any]) => {
          const value = fields[name];
          if (value === undefined || value === "") return [];
          return [[name, ["object", "array"].includes(field.type) ? JSON.parse(String(value)) :
            ["number", "integer"].includes(field.type) ? Number(value) : value]];
        }));
        void send({ action: "accept", ...(prompt.mode !== "url" ? { content } : {}) });
      } catch { setError("Проверьте формат ответа MCP"); }
    } else if (questions.length) {
      void send({ ...(claude ? { behavior: "allow" } : {}), answers: Object.fromEntries(questions.map(q =>
        [key(q), claude ? values(q).join(", ") : { answers: values(q) }])) });
    } else if (claude) void send({ behavior: "allow" });
    else if (method === "item/permissions/requestApproval") void send({ permissions: params.permissions, scope: "turn" });
    else void send({ decision: "accept" });
  }

  const detail = claude ? params.input : params.command ?? params.permissions ?? params.changes;
  return <section className="request" aria-label="Запрос исполнителя">
    <h3>{elicitation ? "Запрос MCP" : questions.length ? "Вопросы исполнителя" : "Разрешение на действие"}</h3>
    {elicitation ? <>
      <p>{prompt.serverName} · {prompt.message}</p>
      {prompt.url && <p className="path">{prompt.url}</p>}
    </> : <>
      {params.tool && <p>{params.tool}</p>}
      {params.reason && <p>{params.reason}</p>}
      {params.cwd && <p className="path">{params.cwd}</p>}
      {detail && !questions.length && <pre className="output">{typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}</pre>}
    </>}
    <form onSubmit={event => { event.preventDefault(); accept(); }}>
      {questions.map(q => <fieldset key={key(q)} disabled={busy}>
        <legend>{q.header ? `${q.header}: ` : ""}{q.question}</legend>
        {(q.options ?? []).map((option: any) => <label className="confirmation" key={option.label}>
          <input type={q.multiSelect ? "checkbox" : "radio"} name={key(q)}
            checked={(selected[key(q)] ?? []).includes(option.label)} onChange={event => setSelected(current => ({ ...current,
              [key(q)]: q.multiSelect ? event.target.checked ? [...(current[key(q)] ?? []), option.label] : (current[key(q)] ?? []).filter(v => v !== option.label) : [option.label],
            }))} />{option.label}{option.description && ` · ${option.description}`}
        </label>)}
        <label>Свой ответ: {q.question}<input type={q.isSecret ? "password" : "text"} value={answers[key(q)] ?? ""}
          onChange={event => setAnswers(current => ({ ...current, [key(q)]: event.target.value }))} /></label>
      </fieldset>)}
      {elicitation && Object.entries(schema.properties ?? {}).map(([name, field]: [string, any]) => field.type === "boolean" || field.enum
        ? <SettingsSelect key={name} label={`${field.title ?? name}${field.description ? ` · ${field.description}` : ""}`} disabled={busy}
          required={(schema.required ?? []).includes(name)} value={fields[name] === undefined ? null : String(fields[name])} placeholder="Выберите ответ"
          choices={field.type === "boolean" ? [{ value: "true", label: "Да" }, { value: "false", label: "Нет" }] : field.enum.map((value: string) => ({ value, label: value }))}
          change={value => setFields(current => ({ ...current, [name]: value === null ? "" : field.type === "boolean" ? value === "true" : value }))} />
        : <label key={name}>{field.title ?? name}{field.description && ` · ${field.description}`}<input disabled={busy} required={(schema.required ?? []).includes(name)}
          type={["number", "integer"].includes(field.type) ? "number" : field.format === "password" ? "password" : "text"}
          step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum}
          placeholder={["object", "array"].includes(field.type) ? "JSON" : undefined}
          value={String(fields[name] ?? "")} onChange={event => setFields(current => ({ ...current, [name]: event.target.value }))} />
      </label>)}
      <div className="conversation-actions">
        <button disabled={disabled || busy || questions.some(q => !values(q).length)} type="submit">{questions.length || elicitation ? "Отправить ответ" : "Разрешить один раз"}</button>
        <button disabled={disabled || busy} type="button" onClick={() => void send(elicitation ? { action: "decline" } : claude ? { behavior: "deny" } :
          method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } :
          questions.length ? { answers: {} } : { decision: "decline" })}>Отклонить запрос</button>
      </div>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
