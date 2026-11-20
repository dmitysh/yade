import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export function toolDecision(
  allow: boolean,
  signal: AbortSignal,
  input: Record<string, unknown>,
  toolUseID: string,
): PermissionResult {
  return allow && !signal.aborted
    ? { behavior: 'allow', updatedInput: input, toolUseID }
    : { behavior: 'deny', message: 'Действие отклонено проверочным сценарием', toolUseID };
}

function executablePath(env: NodeJS.ProcessEnv): string {
  if (env.YADE_CLAUDE_BIN) return realpathSync(env.YADE_CLAUDE_BIN);
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const path = join(directory, 'claude');
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  }
  throw new Error('claude_cli_missing');
}

export async function runProbe(
  args = process.argv.slice(2),
  environment = process.env,
  createQuery: typeof query = query,
  emit: (message: unknown) => void = (message) => console.log(JSON.stringify(message)),
) {
  const [folder, prompt, resume, ...extra] = args;
  if (!folder || !prompt || extra.length) {
    throw new Error('Использование: node probe.ts <папка> <сообщение> [идентификатор разговора]');
  }
  const cwd = realpathSync(folder);
  if (!statSync(cwd).isDirectory()) throw new Error('Рабочая папка отсутствует');
  const decision = environment.YADE_APPROVAL ?? 'decline';
  if (!['accept', 'decline'].includes(decision)) {
    throw new Error('YADE_APPROVAL: ожидается accept или decline');
  }
  const interruptAfter = environment.YADE_INTERRUPT_AFTER_MS;
  if (interruptAfter !== undefined && !/^\d+$/.test(interruptAfter)) {
    throw new Error('YADE_INTERRUPT_AFTER_MS: ожидается целое неотрицательное число');
  }
  const env = { ...environment };
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
  ]) delete env[key];
  if (/authorization|x-api-key|api-key|bearer/i.test(env.ANTHROPIC_CUSTOM_HEADERS ?? '')) {
    delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  env.CLAUDE_CODE_ENTRYPOINT = 'yade';
  let content: SDKUserMessage['message']['content'] = environment.YADE_INPUT_JSON
    ? JSON.parse(environment.YADE_INPUT_JSON)
    : prompt;
  if (Array.isArray(content)) {
    const texts = content.filter((block) => block.type === 'text').map((block) => block.text);
    // Claude раскрывает команду из последнего текстового блока, как в Orca.
    content = [
      ...content.filter((block) => block.type !== 'text'),
      ...(texts.length ? [{ type: 'text' as const, text: texts.join('\n') }] : []),
    ];
  }
  let finishInput!: () => void;
  const inputDone = new Promise<void>((resolve) => { finishInput = resolve; });
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    await inputDone;
  }
  const session = createQuery({
    prompt: messages(),
    options: {
      cwd,
      env,
      pathToClaudeCodeExecutable: executablePath(environment),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      ...(resume ? { resume } : {}),
      canUseTool: async (tool, input, { signal, toolUseID }) => {
        emit({ type: 'permission_request', tool, toolUseID, input, decision });
        return toolDecision(decision === 'accept', signal, input, toolUseID);
      },
      stderr: (text) => process.stderr.write(text),
    },
  });
  let sessionId: string | undefined;
  let resultReceived = false;
  let interruptRequested = false;
  let interruptError: Error | undefined;
  let interruption: Promise<void> | undefined;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let status: 'completed' | 'interrupted' | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; session.close(); }, 120_000);
  try {
    for await (const message of session) {
      emit(message);
      if ('session_id' in message && message.session_id) {
        if ((resume && resume !== message.session_id) || (sessionId && sessionId !== message.session_id)) {
          throw new Error('resume_session_mismatch');
        }
        sessionId = message.session_id;
      }
      if (message.type === 'system' && message.subtype === 'init' && interruptAfter !== undefined) {
        interruptTimer = setTimeout(() => {
          interruptRequested = true;
          interruption = session.interrupt().then(
            () => {},
            (error: Error) => { interruptError = error; session.close(); },
          );
        }, Number(interruptAfter));
      }
      if (message.type === 'result') {
        resultReceived = true;
        const interrupted = ['aborted_streaming', 'aborted_tools'].includes(message.terminal_reason ?? '');
        if (message.subtype !== 'success' || (message.is_error && !interrupted)) {
          throw new Error('query_failed: ' + JSON.stringify(message));
        }
        status = interrupted ? 'interrupted' : 'completed';
        await interruption;
        break;
      }
    }
    await interruption;
    if (timedOut) throw new Error('query_timeout');
    if (interruptError) throw interruptError;
    if (!resultReceived) throw new Error('connection_closed_without_result');
    emit({ type: 'probe_summary', sessionId, status, resultReceived, interruptRequested });
  } finally {
    clearTimeout(timeout);
    clearTimeout(interruptTimer);
    finishInput();
    session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProbe().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
