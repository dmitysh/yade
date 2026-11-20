import { serve } from '../../executors/claude-bridge.ts';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export function fakeSdk(mode = 'success', log = () => {}, finish = () => true) {
  const calls = [];
  const sessions = [];
  const sdk = {
    getSessionInfo: async (id, options) => {
      log({ lookup: id, ...options });
      if (mode === 'title_error') throw new Error('Метаданные недоступны');
      return mode === 'missing' ? undefined : {
        sessionId: id,
        ...(mode === 'title' ? { customTitle: 'Название из Claude', summary: 'Сводка из Claude' } : {}),
        ...(mode === 'title_summary' ? { summary: 'Сводка из Claude' } : {}),
        ...(mode === 'title_empty' ? { summary: '  ' } : {}),
      };
    },
    query: ({ prompt, options }) => {
      calls.push(options);
      let closed = false;
      let interrupted = false;
      const state = {
        interrupt: async () => { interrupted = true; log({ interrupt: true }); },
        close: () => { closed = true; },
        async *[Symbol.asyncIterator]() {
          if (typeof prompt === 'string') {
            log({ title: true, options: { ...options, env: undefined }, prompt });
            if (mode === 'title_wait') {
              while (!closed && !finish()) await delay(10);
            }
            if (closed) return;
            if (mode === 'title_failure') throw new Error('Название недоступно');
            yield { type: 'result', subtype: 'success', session_id: 'title-session', is_error: false,
              result: mode === 'title_invalid' ? 'Название\nПояснение' : 'Краткое название разговора' };
            return;
          }
          log({ options: { ...options, env: undefined }, input: (await prompt.next()).value });
          options.stderr('Диагностика тестового процесса\n');
          const session_id = mode === 'mismatch' ? 'another-session' : 'native-claude';
          yield { type: 'system', subtype: 'init', session_id, model: 'sonnet', mcp_servers: [{ name: 'probe' }], slash_commands: ['help'], skills: ['probe'] };
          yield { type: 'stream_event', session_id, event: { type: 'message_start', message: { id: 'message' } } };
          yield { type: 'stream_event', session_id, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
          yield { type: 'stream_event', session_id, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Частичный ответ' } } };
          if (mode === 'permission' || mode === 'question' || mode === 'cancel') {
            const controller = new AbortController();
            const tool = mode === 'question' ? 'AskUserQuestion' : 'Bash';
            const input = mode === 'question' ? { questions: [{ question: 'Как продолжить?', options: [] }] } : { command: 'true' };
            const decision = options.canUseTool(tool, input, { signal: controller.signal, toolUseID: 'same-tool' });
            if (mode === 'cancel') controller.abort();
            log({ decision: await decision });
          }
          if (mode === 'elicitation') {
            const decision = await options.onElicitation({ serverName: 'probe', message: 'Введите значение', requestedSchema: { type: 'object' } }, { signal: new AbortController().signal });
            log({ decision });
          }
          if (mode === 'process') {
            const child = spawn('/bin/sh', ['-c', 'sleep 120'], { stdio: 'ignore' });
            log({ child: child.pid });
          }
          if (mode === 'disconnect') return;
          if (mode === 'throw') throw new Error('Ошибка тестового транспорта');
          if (['wait', 'process', 'interrupt'].includes(mode)) {
            while (!closed && !(mode === 'interrupt' ? interrupted && finish() : finish())) await delay(10);
          }
          if (closed) return;
          yield { type: 'assistant', session_id, message: { id: 'message', content: [{ type: 'text', text: 'Частичный ответ' }] } };
          yield { type: 'stream_event', session_id, event: { type: 'content_block_stop', index: 0 } };
          const tool = { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'README.md' } };
          yield { type: 'stream_event', session_id, event: { type: 'content_block_start', index: 1, content_block: { ...tool, input: {} } } };
          yield { type: 'assistant', session_id, message: { id: 'message', content: [tool] } };
          yield { type: 'stream_event', session_id, event: { type: 'content_block_stop', index: 1 } };
          if (mode === 'blocks') {
            yield { type: 'stream_event', session_id, event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } };
            yield { type: 'stream_event', session_id, event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: ' Продолжение' } } };
            yield { type: 'assistant', session_id, message: { id: 'message', content: [{ type: 'text', text: ' Продолжение' }] } };
            yield { type: 'stream_event', session_id, event: { type: 'content_block_stop', index: 2 } };
          }
          yield { type: 'user', session_id, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Содержимое' }] } };
          yield {
            type: 'result', subtype: 'success', session_id, is_error: mode === 'auth',
            result: mode === 'auth' ? 'OAuth access token is invalid' : 'Частичный ответ',
            ...(mode === 'auth' ? { api_error_status: 401 } : {}),
            ...(interrupted ? { terminal_reason: 'aborted_tools', is_error: true } : {}),
          };
        },
      };
      sessions.push(state);
      return state;
    },
  };
  return { sdk, calls, sessions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = packet => appendFileSync(process.env.FAKE_LOG, JSON.stringify(packet) + '\n');
  if (process.env.FAKE_MODE === 'malformed') {
    process.stdout.write('invalid json\n');
  } else if (process.env.FAKE_MODE === 'truncated') {
    process.stdout.write('{"method":"message"');
  } else if (process.env.FAKE_MODE === 'blocked') {
    writeFileSync(process.env.FAKE_LOG, String(process.pid));
    process.stdin.pause();
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_MODE === 'late-request') {
    const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
    for await (const line of createInterface({ input: process.stdin })) {
      const { id, method, params: { context } } = JSON.parse(line);
      send({ id, result: { context } });
      if (method === 'start') {
        send({ method: 'message', params: { context, message: { type: 'system', subtype: 'init', session_id: 'native-claude' } } });
      } else if (method === 'interrupt') {
        send({ id: 'late-request', method: 'request', params: { context, kind: 'permission', tool: 'Bash', input: { command: 'true' } } });
        send({ method: 'request_cancelled', params: { context, requestId: 'late-request' } });
        send({ method: 'message', params: { context, message: { type: 'rate_limit_event' } } });
        while (!existsSync(process.env.FAKE_FINISH)) await delay(10);
        send({ method: 'message', params: { context, message: { type: 'result', subtype: 'success', session_id: 'native-claude', terminal_reason: 'aborted_tools', is_error: true } } });
      }
    }
  } else if (process.env.FAKE_MODE === 'reply-rejected') {
    const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
    let context;
    let firstReply;
    const request = id => send({ id, method: 'request', params: { context, kind: 'permission', tool: 'Bash', input: { command: 'true' } } });
    for await (const line of createInterface({ input: process.stdin })) {
      const packet = JSON.parse(line);
      if (packet.method === 'start') {
        context = packet.params.context;
        send({ id: packet.id, result: { context } });
        send({ method: 'message', params: { context, message: { type: 'system', subtype: 'init', session_id: 'native-claude' } } });
        request('cancelled-reply');
        request('accepted-reply');
      } else if (packet.method === 'reply') {
        log({ reply: packet.params.requestId });
        if (packet.params.requestId === 'cancelled-reply') {
          firstReply = packet;
        } else if (packet.params.requestId === 'accepted-reply') {
          send({ id: packet.id, result: { context } });
          send({ method: 'request_cancelled', params: { context, requestId: 'cancelled-reply' } });
          send({ id: firstReply.id, error: { code: -32602, message: 'Запрос больше не актуален' } });
          request('final-reply');
        } else {
          send({ method: 'message', params: { context, message: { type: 'result', subtype: 'success', session_id: 'native-claude', is_error: false } } });
          await delay(100);
          send({ id: packet.id, result: { context } });
        }
      } else if (packet.method === 'interrupt') {
        send({ id: packet.id, error: { code: -32602, message: 'Прерывание отклонено' } });
      }
    }
  } else {
    const fake = fakeSdk(process.env.FAKE_MODE, log, () => existsSync(process.env.FAKE_FINISH));
    serve(process.stdin, process.stdout, process.stderr, fake.sdk).catch(error => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    });
  }
}
