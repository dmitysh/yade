import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runProbe, toolDecision } from './probe.ts';

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'yade-claude-test-')));
after(() => rmSync(folder, { recursive: true, force: true }));
const environment = { YADE_CLAUDE_BIN: process.execPath };
const init = {
  type: 'system', subtype: 'init', session_id: 'original',
  slash_commands: ['compatibility-probe'], skills: ['compatibility-probe'],
  mcp_servers: [{ name: 'project-fixture', status: 'connected' }],
};
const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'original' };

function sdk(stream: (request: Parameters<typeof query>[0]) => AsyncGenerator<unknown>) {
  const interrupt = mock.fn(async () => {});
  const close = mock.fn(() => {});
  const create = mock.fn((request: Parameters<typeof query>[0]) => {
    return Object.assign(stream(request), { interrupt, close });
  });
  return { create: create as unknown as typeof query, interrupt, close };
}

test('флоу Orca передаёт CLI, профиль и настройки и публикует поток до результата', async () => {
  const events: unknown[] = [];
  const env = {
    ...environment, CLAUDE_CONFIG_DIR: join(folder, 'profile'), PATH: '/usr/bin',
    HTTPS_PROXY: 'http://localhost:8080', CLAUDECODE: 'parent', CLAUDE_CODE_ENTRYPOINT: 'parent',
    ANTHROPIC_API_KEY: 'test-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer test-token',
  };
  const originalEnv = { ...env };
  const connection = sdk(async function* ({ prompt, options }) {
    assert.equal(typeof prompt, 'object');
    if (typeof prompt === 'string') throw new Error('Ожидается поток ввода');
    assert.equal(options?.pathToClaudeCodeExecutable, realpathSync(process.execPath));
    assert.equal(options?.cwd, folder);
    assert.equal(options?.env?.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
    assert.equal(options?.env?.HTTPS_PROXY, env.HTTPS_PROXY);
    assert.equal(options?.env?.PATH, env.PATH);
    assert.equal(options?.env?.CLAUDE_CODE_ENTRYPOINT, 'yade');
    for (const key of ['CLAUDECODE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
      assert.equal(options?.env?.[key], undefined);
    }
    assert.deepEqual(options?.settingSources, ['user', 'project', 'local']);
    assert.deepEqual(options?.systemPrompt, { type: 'preset', preset: 'claude_code' });
    assert.equal(options?.includePartialMessages, true);
    assert.equal(options?.resume, undefined);
    const first = await prompt[Symbol.asyncIterator]().next();
    assert.deepEqual(first.value, {
      type: 'user', message: { role: 'user', content: 'Новое сообщение' }, parent_tool_use_id: null,
    });
    yield init;
    const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'Часть ответа' } } };
    yield delta;
    assert.ok(events.includes(delta));
    assert.ok(!events.includes(result));
    yield result;
  });
  await runProbe([folder, 'Новое сообщение'], env, connection.create, (event) => events.push(event));
  assert.deepEqual(env, originalEnv);
  assert.deepEqual(events[0], init);
  assert.equal(connection.close.mock.callCount(), 1);
  assert.deepEqual(events.at(-1), {
    type: 'probe_summary', sessionId: 'original', status: 'completed', resultReceived: true, interruptRequested: false,
  });
});

test('401 с subtype success остаётся ошибкой и закрывает процесс', async () => {
  const events: unknown[] = [];
  const connection = sdk(async function* () {
    yield init;
    yield { ...result, is_error: true, api_error_status: 401, result: 'OAuth access token is invalid' };
  });
  await assert.rejects(runProbe([folder, 'Сообщение'], environment, connection.create, (event) => events.push(event)), /query_failed.*401/);
  assert.equal(events.length, 2);
  assert.equal(connection.close.mock.callCount(), 1);
});

test('завершение без результата и ошибка транспорта не считаются успехом', async () => {
  for (const transportError of [false, true]) {
    const connection = sdk(async function* () {
      yield init;
      if (transportError) throw new Error('transport_failed');
    });
    await assert.rejects(
      runProbe([folder, 'Сообщение'], environment, connection.create, () => {}),
      transportError ? /transport_failed/ : /connection_closed_without_result/,
    );
    assert.equal(connection.close.mock.callCount(), 1);
  }
});

test('продолжение передаёт исходный идентификатор и только новое сообщение', async () => {
  const connection = sdk(async function* ({ prompt, options }) {
    assert.equal(options?.resume, 'original');
    assert.equal(options?.forkSession, undefined);
    if (typeof prompt === 'string') throw new Error('Ожидается поток ввода');
    const input = prompt[Symbol.asyncIterator]();
    assert.equal((await input.next()).value.message.content, 'Следующий вопрос');
    yield init;
    yield result;
  });
  await runProbe([folder, 'Следующий вопрос', 'original'], environment, connection.create, () => {});
  const wrongSession = sdk(async function* () { yield { ...init, session_id: 'another' }; });
  await assert.rejects(
    runProbe([folder, 'Следующий вопрос', 'original'], environment, wrongSession.create, () => {}),
    /resume_session_mismatch/,
  );
  assert.equal(wrongSession.close.mock.callCount(), 1);
});

test('решения разрешения относятся к исходным запросам SDK', async () => {
  for (const decision of ['accept', 'decline']) {
    const controller = new AbortController();
    const connection = sdk(async function* ({ options }) {
      yield init;
      const permission = await options!.canUseTool!('Bash', { command: 'pwd' }, {
        signal: controller.signal, toolUseID: 'original-tool',
      });
      assert.equal(permission.toolUseID, 'original-tool');
      assert.equal(permission.behavior, decision === 'accept' ? 'allow' : 'deny');
      controller.abort();
      const expired = await options!.canUseTool!('Bash', {}, {
        signal: controller.signal, toolUseID: 'expired-tool',
      });
      assert.equal(expired.behavior, 'deny');
      assert.equal(expired.toolUseID, 'expired-tool');
      yield result;
    });
    await runProbe([folder, 'Проверка'], { ...environment, YADE_APPROVAL: decision }, connection.create, () => {});
  }
});

test('прерывание направляется исходной сессии и ждёт её результата', async () => {
  const events: unknown[] = [];
  let finish!: () => void;
  const interrupted = new Promise<void>((resolve) => { finish = resolve; });
  const connection = sdk(async function* () {
    yield init;
    await interrupted;
    assert.equal(events.some((event) => (event as { type: string }).type === 'probe_summary'), false);
    yield { ...result, is_error: true, terminal_reason: 'aborted_tools' };
  });
  connection.interrupt.mock.mockImplementation(async () => { finish(); });
  const other = sdk(async function* () { yield { ...result, session_id: 'other' }; });
  await Promise.all([
    runProbe([folder, 'Длительная задача', 'original'], { ...environment, YADE_INTERRUPT_AFTER_MS: '0' }, connection.create, (event) => events.push(event)),
    runProbe([folder, 'Другая задача', 'other'], environment, other.create, () => {}),
  ]);
  assert.equal(connection.interrupt.mock.callCount(), 1);
  assert.equal(other.interrupt.mock.callCount(), 0);
  assert.deepEqual(events.at(-1), {
    type: 'probe_summary', sessionId: 'original', status: 'interrupted', resultReceived: true, interruptRequested: true,
  });
});

test('результат прерывания до ответа interrupt не закрывает итератор преждевременно', async () => {
  const events: unknown[] = [];
  const order: string[] = [];
  let finish!: () => void;
  const interrupted = new Promise<void>((resolve) => { finish = resolve; });
  let rejectInterrupt!: (error: Error) => void;
  const connection = sdk(async function* () {
    try {
      yield init;
      await interrupted;
      order.push('result');
      yield { ...result, is_error: true, terminal_reason: 'aborted_tools' };
    } finally {
      order.push('iterator_closed');
      rejectInterrupt(new Error('Query closed before response received'));
    }
  });
  connection.interrupt.mock.mockImplementation(() => new Promise<void>((resolve, reject) => {
    rejectInterrupt = reject;
    order.push('interrupt');
    finish();
    setImmediate(() => { order.push('interrupt_response'); resolve(); });
  }));
  await runProbe(
    [folder, 'Длительная задача'], { ...environment, YADE_INTERRUPT_AFTER_MS: '0' },
    connection.create, (event) => events.push(event),
  );
  assert.deepEqual(order, ['interrupt', 'result', 'interrupt_response', 'iterator_closed']);
  assert.equal(connection.close.mock.callCount(), 1);
  assert.deepEqual(events.at(-1), {
    type: 'probe_summary', sessionId: 'original', status: 'interrupted', resultReceived: true, interruptRequested: true,
  });
});

test('команда с файлом и изображением сохраняется в последнем текстовом блоке, как в Orca', async () => {
  const content = [
    { type: 'text', text: '/проверка' },
    { type: 'text', text: 'Прочитай @fixture.txt' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAOElEQVR4nO3PsQkAAAzDsPz/dHpFliLwbFCaTBvvu94DAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAQcOkv4asq/aw0AAAAASUVORK5CYII=' } },
  ];
  const connection = sdk(async function* ({ prompt }) {
    if (typeof prompt === 'string') throw new Error('Ожидается поток ввода');
    const first = await prompt[Symbol.asyncIterator]().next();
    assert.deepEqual(first.value.message.content, [
      content[2], { type: 'text', text: '/проверка\nПрочитай @fixture.txt' },
    ]);
    yield result;
  });
  await runProbe([folder, 'Вложение'], { ...environment, YADE_INPUT_JSON: JSON.stringify(content) }, connection.create, () => {});
});

test('завершённый запрос не разрешает действие даже при положительном решении', () => {
  const controller = new AbortController();
  const input = { command: 'touch approval.txt' };
  assert.deepEqual(toolDecision(true, controller.signal, input, 'first'), {
    behavior: 'allow', updatedInput: input, toolUseID: 'first',
  });
  controller.abort();
  const result = toolDecision(true, controller.signal, input, 'first');
  assert.equal(result.behavior, 'deny');
  assert.equal(result.toolUseID, 'first');
  assert.equal(toolDecision(false, new AbortController().signal, input, 'second').behavior, 'deny');
});
