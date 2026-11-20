import { query, getSessionInfo, type Query, type SDKUserMessage, type PermissionResult, type ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { launchOptions } from './claude-settings.mjs';

type Context = { workspaceId: string; sessionId: string; runId: string };
type Packet = { id?: string | number; method?: string; params?: any; result?: any };
type Pending = {
  kind: string;
  input: Record<string, any>;
  finish: (decision: any) => void;
  cancel: () => void;
};
const MAX_PACKET = 8 * 1024 * 1024;

async function* packets(input: Readable): AsyncGenerator<Packet> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end: number;
    while ((end = buffer.indexOf(10)) !== -1) {
      if (end >= MAX_PACKET) throw new Error('Слишком большой пакет Claude Code');
      const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
      buffer = buffer.subarray(end + 1);
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Повреждённый пакет Claude Code');
      yield packet;
    }
    if (buffer.length >= MAX_PACKET) throw new Error('Слишком большой пакет Claude Code');
  }
  if (buffer.length) throw new Error('Поток Claude Code закрыт посреди пакета');
}

export async function serve(
  input: Readable,
  output: Writable,
  diagnostic: Writable,
  sdk = { query, getSessionInfo },
) {
  let context: Context | undefined;
  let session: Query | undefined;
  let running: Promise<void> | undefined;
  let ended = false;
  let stopping = false;
  let finishInput = () => {};
  const pending = new Map<string, Pending>();
  const send = async (packet: unknown) => {
    const line = JSON.stringify(packet) + '\n';
    if (Buffer.byteLength(line) > MAX_PACKET) throw new Error('Слишком большой пакет Claude Code');
    if (!output.write(line)) await once(output, 'drain');
  };
  const event = (method: string, params: object) => send({ method, params: { context, ...params } });
  const sameContext = (value: any) => context && value &&
    ['workspaceId', 'sessionId', 'runId'].every(key => value[key] === context![key as keyof Context]);
  const cancelAll = () => { for (const request of [...pending.values()]) request.cancel(); };

  async function ask(kind: string, requestInput: Record<string, any>, signal: AbortSignal): Promise<any> {
    const denied = kind === 'elicitation' ? { action: 'cancel' } : { behavior: 'deny', message: 'Запрос больше не актуален' };
    if (ended || stopping || signal.aborted) return denied;
    const id = randomUUID();
    let finish!: (decision: any) => void;
    const result = new Promise(resolve => { finish = resolve; });
    const settle = (decision: any) => {
      pending.delete(id);
      signal.removeEventListener('abort', cancel);
      finish(decision);
    };
    const cancel = () => {
      settle(denied);
      void event('request_cancelled', { requestId: id }).catch(error => diagnostic.write(String(error) + '\n'));
    };
    pending.set(id, { kind, input: requestInput, finish: settle, cancel });
    signal.addEventListener('abort', cancel, { once: true });
    await send({ id, method: 'request', params: { context, kind, ...requestInput } });
    return result;
  }

  async function run(params: any) {
    try {
      if (params.resume && !await sdk.getSessionInfo(params.resume, { dir: params.cwd })) {
        throw new Error('Штатные данные разговора Claude Code отсутствуют; продолжение невозможно');
      }
      if (ended) return;
      const content = params.input as SDKUserMessage['message']['content'];
      const inputDone = new Promise<void>(resolve => { finishInput = resolve; });
      async function* messages(): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
        await inputDone;
      }
      session = sdk.query({
        prompt: messages(),
        options: {
          ...launchOptions(params.path, params.cwd, params.settings, process.env, params.loadProjectSettings === true),
          ...(params.resume ? { resume: params.resume } : {}),
          canUseTool: async (tool, input, { signal, toolUseID }) => {
            const decision = await ask(tool === 'AskUserQuestion' ? 'question' : 'permission', { tool, input, toolUseID }, signal);
            return decision.behavior === 'allow'
              ? { behavior: 'allow', updatedInput: { ...input, ...(decision.answers ? { answers: decision.answers } : {}) }, toolUseID }
              : { behavior: 'deny', message: decision.message ?? 'Действие отклонено пользователем', toolUseID } satisfies PermissionResult;
          },
          onElicitation: async (request, { signal }) => ask('elicitation', { request }, signal) as Promise<ElicitationResult>,
          stderr: text => { diagnostic.write(text); },
        },
      });
      let nativeId: string | undefined = params.resume;
      for await (const message of session) {
        if ('session_id' in message && message.session_id) {
          if (nativeId && nativeId !== message.session_id) throw new Error('Claude Code вернул другой разговор при продолжении');
          nativeId = message.session_id;
        }
        if (message.type === 'result') {
          cancelAll();
          if (nativeId) {
            const info = await sdk.getSessionInfo(nativeId, { dir: params.cwd }).catch(error => {
              diagnostic.write(String(error) + '\n');
              return undefined;
            });
            const title = info?.customTitle || info?.summary;
            if (info?.sessionId === nativeId && title?.trim()) await event('session_title', { title });
          }
        }
        await event('message', { message });
        if (message.type === 'result') return;
      }
      throw new Error('Соединение Claude Code закрыто без результата');
    } catch (error) {
      if (!ended) await event('failed', { message: error instanceof Error ? error.message : String(error) });
    } finally {
      ended = true;
      cancelAll();
      finishInput();
      session?.close();
    }
  }

  try {
    for await (const packet of packets(input)) {
      const { id, method, params } = packet;
      if (!Number.isSafeInteger(id) || typeof method !== 'string' || !params || typeof params !== 'object') {
        throw new Error('Повреждённый запрос Claude Code');
      }
      try {
        if (method === 'title') {
          if (running || !params.context || !['workspaceId', 'sessionId', 'runId'].every(key => typeof params.context[key] === 'string' && params.context[key]) ||
              !['path', 'cwd', 'prompt'].every(key => typeof params[key] === 'string' && params[key]) || !params.settings || typeof params.settings !== 'object') {
            throw new Error('Некорректные параметры названия разговора');
          }
          context = params.context;
          session = sdk.query({
            prompt: params.prompt,
            options: {
              ...launchOptions(params.path, homedir(), { model: params.settings.model }),
              systemPrompt: 'Верни только короткое название разговора. Не используй инструменты.',
              settingSources: [], tools: [],
              persistSession: false, maxTurns: 1, permissionMode: 'dontAsk',
              canUseTool: async (_tool, _input, { toolUseID }) => ({ behavior: 'deny', message: 'Создание названия не выполняет действия', toolUseID }),
              stderr: text => { diagnostic.write(text); },
            },
          });
          running = (async () => {
            const timer = setTimeout(() => session?.close(), 20_000);
            try {
              for await (const message of session!) {
                if (message.type === 'result') {
                  if (message.subtype !== 'success' || message.is_error) throw new Error('Не удалось создать название разговора');
                  await send({ id, result: { context, title: message.result } });
                  return;
                }
              }
              throw new Error('Claude Code не вернул название разговора');
            } catch (error) {
              await send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
            } finally {
              clearTimeout(timer);
              ended = true;
              session?.close();
            }
          })();
        } else if (method === 'start') {
          if (running) throw new Error('Разговор уже запущен');
          if (!params.context || !['workspaceId', 'sessionId', 'runId'].every(key => typeof params.context[key] === 'string' && params.context[key]) ||
              !['path', 'cwd'].every(key => typeof params[key] === 'string' && params[key]) ||
              !params.settings || typeof params.settings !== 'object' ||
              (params.resume != null && (typeof params.resume !== 'string' || !params.resume)) ||
              !Array.isArray(params.input) || !params.input.length || !params.input.every((block: any) => block &&
                ((block.type === 'text' && typeof block.text === 'string') || (block.type === 'image' && block.source && ['base64', 'url'].includes(block.source.type))))) {
            throw new Error('Некорректные параметры запуска Claude Code');
          }
          context = params.context;
          await send({ id, result: { context } });
          running = run(params);
        } else {
          if (!sameContext(params.context) || ended || !session) throw new Error('Запрос этого запуска больше не актуален');
          if (method === 'interrupt') {
            if (stopping) throw new Error('Остановка уже запрошена');
            stopping = true;
            cancelAll();
            try {
              await session.interrupt();
            } catch (error) {
              stopping = false;
              throw error;
            }
          } else if (method === 'reply') {
            const request = pending.get(params.requestId);
            if (!request || stopping) throw new Error('Запрос больше не актуален');
            const result = params.result;
            if (request.kind === 'elicitation') {
              if (!result || !['accept', 'decline', 'cancel'].includes(result.action) ||
                  (result.content != null && (typeof result.content !== 'object' || Array.isArray(result.content)))) throw new Error('Некорректный ответ MCP');
              request.finish({ action: result.action, ...(result.content ? { content: result.content } : {}) });
            } else {
              if (!result || !['allow', 'deny'].includes(result.behavior) || Object.keys(result).some(key => !['behavior', 'answers'].includes(key))) throw new Error('Некорректный ответ на запрос инструмента');
              if (result.behavior === 'allow' && request.kind === 'question') {
                const questions = request.input.input.questions;
                if (!Array.isArray(questions) || !result.answers || Object.keys(result.answers).length !== questions.length ||
                    !questions.every((q: any) => typeof result.answers[q.question] === 'string' && result.answers[q.question].trim())) throw new Error('Ответьте на вопросы Claude Code');
              } else if (result.answers !== undefined) throw new Error('Этот запрос не принимает ответы на вопросы');
              request.finish(result);
            }
          } else throw new Error('Неизвестная команда Claude Code');
          await send({ id, result: { context } });
        }
      } catch (error) {
        await send({ id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } });
      }
    }
  } finally {
    ended = true;
    cancelAll();
    finishInput();
    session?.close();
    await running;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  serve(process.stdin, process.stdout, process.stderr).catch(error => {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  });
}
