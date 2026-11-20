import { useState } from "react";
import type { ConversationData } from "./types";
import { Icon } from "./Ide";
import MessageContent from "./MessageContent";
import ConversationRequest from "./ConversationRequest";
import type { FileLinks } from "./fileLinks";

type Step = {
  key: string; sequence: number; title: string; input: string; output: string;
  state: "running" | "completed" | "failed"; runId: string;
};

function text(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  return value?.text ?? "";
}

function describe(item: Record<string, any>): { title: string; input: string } {
  switch (item.type) {
    case "commandExecution": return { title: "Команда", input: item.command ?? "" };
    case "fileChange": return { title: "Изменение файлов", input: (item.changes ?? []).map((change: any) => `${change.path}\n${change.diff ?? ""}`).join("\n") };
    case "mcpToolCall": return { title: `${item.server} · ${item.tool}`, input: item.arguments ? JSON.stringify(item.arguments, null, 2) : "" };
    case "webSearch": return { title: "Поиск в интернете", input: item.action?.query ?? item.query ?? item.action?.url ?? "" };
    case "reasoning": return { title: "Размышление", input: "" };
    case "tool_use": {
      const input = item.input ?? {};
      return { title: item.name ?? "Инструмент", input: ["Edit", "Write", "MultiEdit"].includes(item.name) ? JSON.stringify(input, null, 2) : input.command ?? input.file_path ?? input.pattern ?? input.query ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : "") };
    }
    default: return { title: item.tool ?? item.name ?? "Действие", input: "" };
  }
}

export default function ConversationTimeline({ data, executor, active, canReply, reply, workspacePath, fileWorkspaces, openFile }: {
  data: ConversationData; executor: string; active: boolean; canReply: boolean; reply: (text: string) => Promise<void>;
} & FileLinks) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const steps = new Map<string, Step>();
  const thinking = new Map<string, Step>();
  const questions = new Map(data.events.filter(event => event.kind === "message_completed" && event.payload.questions?.length)
    .map(event => [event.payload.sequence, event]));
  function step(runId: string, id: string, sequence: number) {
    const key = `${runId}:${id}`;
    let value = steps.get(key);
    if (!value) {
      value = { key, runId, sequence, title: "Действие", input: "", output: "", state: "running" };
      steps.set(key, value);
    }
    return value;
  }
  for (const event of data.events) {
    const item = event.payload;
    const run = event.context.runId;
    if (["action_started", "action_completed"].includes(event.kind) || (event.kind === "action_output" && item.type === "tool_use")) {
      const id = item.id ?? item.tool_use_id;
      if (!id) continue;
      const value = step(run, id, event.sequence);
      if (item.type !== "tool_result") {
        const description = describe(item);
        value.title = description.title;
        if (description.input) value.input = description.input;
        if (item.type === "reasoning") value.output = text(item.summary) || text(item.content) || value.output;
        else if (typeof item.aggregatedOutput === "string") value.output = item.aggregatedOutput;
        else if (item.result) value.output = text(item.result.content ?? item.result);
        if (item.error) value.output = text(item.error) || item.error.message || value.output;
      } else value.output = text(item.content);
      if (event.kind === "action_completed") value.state = item.is_error || item.success === false || ["failed", "declined"].includes(item.status) || (typeof item.exitCode === "number" && item.exitCode !== 0) || item.error ? "failed" : "completed";
      continue;
    }
    if (event.kind !== "action_output") continue;
    const params = item.params ?? {};
    if (item.method === "turn/plan/updated") {
      const value = step(run, `plan:${params.turnId}`, event.sequence);
      value.title = "План";
      value.output = [params.explanation, ...(params.plan ?? []).map((entry: any) => `${entry.status === "completed" ? "✓" : entry.status === "inProgress" ? "•" : "○"} ${entry.step}`)].filter(Boolean).join("\n");
      value.state = params.plan?.every((entry: any) => entry.status === "completed") ? "completed" : "running";
    } else if (params.itemId && ["item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/mcpToolCall/progress", "item/reasoning/summaryTextDelta"].includes(item.method)) {
      const value = step(run, params.itemId, event.sequence);
      if (item.method === "item/reasoning/summaryTextDelta") value.title = "Размышление";
      value.output += params.delta ?? params.message ?? "";
    } else if (item.type === "content_block_start" && item.content_block?.type === "thinking") {
      const value = step(run, `thinking:${event.sequence}`, event.sequence);
      value.title = "Размышление";
      value.output = item.content_block.thinking ?? "";
      thinking.set(`${run}:${item.index}`, value);
    } else if (item.type === "content_block_delta" && item.delta?.type === "thinking_delta") {
      const value = thinking.get(`${run}:${item.index}`);
      if (value) value.output += item.delta.thinking ?? "";
    } else if (item.type === "content_block_stop") {
      const value = thinking.get(`${run}:${item.index}`);
      if (value) value.state = "completed";
      thinking.delete(`${run}:${item.index}`);
    }
  }
  const entries = [
    ...data.messages.map(message => ({ key: `message:${message.sequence}`, sequence: data.messageEvents[message.sequence] ?? message.sequence, message, step: null })),
    ...[...steps.values()].map(value => ({ key: `step:${value.key}`, sequence: value.sequence, message: null, step: value })),
  ].sort((a, b) => a.sequence - b.sequence);
  return <>{entries.map(entry => {
    if (entry.message) {
      const question = questions.get(entry.message.sequence);
      const pending = question && !data.messages.some(message => message.role === "user" && message.sequence > entry.message!.sequence);
      const params = { questions: (question?.payload.questions ?? []).map((q: any, index: number) => ({
        id: String(index), question: q.title, options: q.options?.map((label: string) => ({ label })),
      })) };
      return <article key={entry.key}>
        <strong>{entry.message.role === "user" ? "Вы" : executor}</strong>
        {pending ? <>
          <ConversationRequest request={{ ...question, payload: { method: "item/tool/requestUserInput", params } }} executor="codex" disabled={!canReply}
            reply={async result => {
              const answers = result.answers as Record<string, { answers: string[] }>;
              await reply(Object.keys(answers).length ? params.questions.map((q: any) => `${q.question}\n${answers[q.id].answers.join(", ")}`).join("\n\n")
                : "Пользователь отклонил запрос ввода.");
            }} />
          {active && <p className="muted">Ответ можно отправить после завершения текущего выполнения.</p>}
        </> : <MessageContent body={entry.message.body || "Сообщение с вложением"} workspacePath={workspacePath} fileWorkspaces={fileWorkspaces} openFile={openFile} />}
      </article>;
    }
    const value = entry.step!;
    const running = value.state === "running" && active && value.runId === data.context?.runId;
    const label = value.state === "failed" ? "Ошибка" : value.state === "completed" ? "Завершено" : running ? "Выполняется" : "Прервано";
    const input = value.title === "Размышление" ? "" : value.input;
    const open = expanded.includes(value.key);
    const contentId = `step-content:${data.session.id}:${value.key}`;
    const toggleLabel = open ? "Свернуть вывод" : "Развернуть полный вывод";
    return <div key={entry.key} className={`conversation-step ${value.state === "failed" ? "step-failed" : ""}`} aria-label={`${value.title}: ${label}`}>
      <div className="conversation-step-heading"><span aria-hidden="true">{value.state === "failed" ? "!" : value.state === "completed" ? "✓" : running ? "•" : "○"}</span><strong>{value.title}</strong><span className="muted">{label}</span>
        {(input || value.output) && <button className="ide-icon-button conversation-step-toggle" aria-label={toggleLabel} title={toggleLabel} aria-expanded={open} aria-controls={contentId}
          onClick={() => setExpanded(current => open ? current.filter(key => key !== value.key) : [...current, value.key])}><Icon name="chevron" /></button>}
      </div>
      <div id={contentId}>
        {open ? <>
          {input && <pre className="conversation-step-input">{input}</pre>}
          {value.output && <pre className="conversation-step-output">{value.output}</pre>}
        </> : (input || value.output) && <pre className={`conversation-step-preview ${input ? "conversation-step-input" : "conversation-step-output"}`}>{(input || value.output).split(/\r?\n/, 1)[0]}</pre>}
      </div>
    </div>;
  })}</>;
}
