import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from './claude-bridge.ts';
import { fakeSdk } from '../src-tauri/test-fixtures/claude.mjs';

const context = { workspaceId: 'workspace', sessionId: 'session', runId: 'run' };
function harness(mode = 'success', resume, finish = () => true) {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostic = new PassThrough();
  const packets = [];
  const log = [];
  let buffer = '';
  let errors = '';
  output.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      packets.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  diagnostic.on('data', text => { errors += text; });
  const fake = fakeSdk(mode, packet => log.push(packet), finish);
  const done = serve(input, output, diagnostic, fake.sdk);
  let nextId = 0;
  const command = (method, params) => input.write(JSON.stringify({ id: ++nextId, method, params }) + '\n');
  const start = (input = [{ type: 'text', text: 'Новое сообщение' }], loadProjectSettings = true) =>
    command('start', { context, path: '/installed/claude', cwd: '/workspace', settings: { model: 'sonnet', permissionMode: 'default' }, resume, input, loadProjectSettings });
  const until = async predicate => {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await delay(5);
    }
    assert.fail('Не дождались события: ' + JSON.stringify(packets));
  };
  return { input, packets, log, fake, done, command, start, until, errors: () => errors };
}

test('запуск передаёт CLI, настройки и одно сообщение, диагностика отделена от протокола', async () => {
  const h = harness();
  h.start();
  await h.until(() => h.packets.some(p => p.params?.message?.type === 'result'));
  assert.equal(h.fake.calls[0].pathToClaudeCodeExecutable, '/installed/claude');
  assert.equal(h.fake.calls[0].cwd, '/workspace');
  assert.deepEqual(h.fake.calls[0].settingSources, ['user', 'project', 'local']);
  assert.equal(h.fake.calls[0].model, 'sonnet');
  assert.equal(h.fake.calls[0].permissionMode, 'default');
  assert.deepEqual(h.log[0].input.message.content, [{ type: 'text', text: 'Новое сообщение' }]);
  assert(h.errors().includes('Диагностика'));
  assert(h.packets.every(p => p.result?.context?.runId === 'run' || p.params?.context?.runId === 'run'));
  h.input.end();
  await h.done;
});

test('у запуска без доверия отключены проектные настройки, хуки и MCP из файлов', async () => {
  const h = harness();
  h.start(undefined, false);
  await h.until(() => h.packets.some(p => p.params?.message?.type === 'result'));
  const options = h.fake.calls[0];
  assert.deepEqual(options.settingSources, ['user']);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  h.input.end();
  await h.done;
});

test('штатное название читается перед итогом без дополнительного запроса и не мешает ответу при ошибке', async () => {
  for (const [mode, expected] of [['title', 'Название из Claude'], ['title_summary', 'Сводка из Claude'], ['title_empty', undefined], ['title_error', undefined], ['success', undefined]]) {
    const h = harness(mode);
    h.start();
    await h.until(() => h.packets.some(p => p.params?.message?.type === 'result'));
    const title = h.packets.find(p => p.method === 'session_title');
    assert.equal(title?.params.title, expected);
    if (title) assert(h.packets.indexOf(title) < h.packets.findIndex(p => p.params?.message?.type === 'result'));
    assert.equal(h.fake.calls.length, 1);
    assert.equal(h.packets.some(p => p.method === 'failed'), false);
    assert(h.log.some(p => p.lookup === 'native-claude' && p.dir === '/workspace'));
    h.input.end();
    await h.done;
  }
});

test('название создаётся отдельно без инструментов, сохранения сессии и событий переписки', async () => {
  for (const mode of ['success', 'title_failure']) {
    const h = harness(mode);
    h.command('title', { context, path: '/installed/claude', cwd: '/workspace', settings: { model: 'sonnet', permissionMode: 'bypassPermissions' }, loadProjectSettings: true, prompt: 'Назови разговор' });
    await h.until(() => h.packets.some(p => p.id === 1));
    const result = h.packets.find(p => p.id === 1);
    if (mode === 'success') assert.deepEqual(result.result, { context, title: 'Краткое название разговора' });
    else assert(result.error.message.includes('Название недоступно'));
    assert.equal(h.packets.some(p => p.method), false);
    const options = h.fake.calls[0];
    assert.equal(options.model, 'sonnet');
    assert.equal(options.cwd, homedir());
    assert.equal(options.resume, undefined);
    assert.equal(options.persistSession, false);
    assert.equal(options.maxTurns, 1);
    assert.equal(options.permissionMode, 'dontAsk');
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.settings, { disableAllHooks: true });
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.equal(h.log.some(p => p.lookup), false);
    h.input.end();
    await h.done;
  }
});

test('содержимое сообщения передаётся SDK без перестановки и добавления блоков', async () => {
  const images = [
    { type: 'image', source: { type: 'url', url: 'https://example.com/first.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
  ];
  for (const content of [[{ type: 'text', text: 'Первое изображение' }, images[0], { type: 'text', text: 'Второе изображение' }, images[1]], images]) {
    const h = harness();
    h.start(content);
    await h.until(() => h.packets.some(p => p.params?.message?.type === 'result'));
    assert.deepEqual(h.log[0].input.message.content, content);
    h.input.end();
    await h.done;
  }
});

test('разделённые байты UTF-8 и несколько пакетов сохраняют корреляцию, EOF закрывает SDK', async () => {
  const h = harness('wait', undefined, () => false);
  const packet = Buffer.from(JSON.stringify({ id: 7, method: 'start', params: { context, path: '/cli', cwd: '/workspace', settings: {}, input: [{ type: 'text', text: 'Привет' }] } }) + '\n');
  for (const byte of packet) h.input.write(Buffer.from([byte]));
  await h.until(() => h.fake.calls.length);
  h.input.write(JSON.stringify({ id: 8, method: 'interrupt', params: { context: { ...context, runId: 'other' } } }) + '\n' + JSON.stringify({ id: 9, method: 'unknown', params: { context } }) + '\n');
  await h.until(() => h.packets.some(p => p.id === 9));
  assert(h.packets.find(p => p.id === 7).result);
  assert(h.packets.find(p => p.id === 8).error);
  assert(h.packets.find(p => p.id === 9).error);
  assert(!h.log.some(p => p.interrupt));
  h.input.end();
  await h.done;
  assert(!h.packets.some(p => p.params?.message?.type === 'result'));
});

test('повреждённые, оборванные и слишком большие пакеты отклоняются', async () => {
  for (const text of ['invalid\n', '[]\n', '{"id":1}', 'x'.repeat(8 * 1024 * 1024), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])]) {
    const h = harness();
    const rejected = assert.rejects(h.done);
    h.input.end(text);
    await rejected;
    assert.equal(h.fake.calls.length, 0);
  }
});

test('продолжение проверяет штатные данные и не отправляет сохранённую историю', async () => {
  for (const mode of ['success', 'missing', 'mismatch']) {
    const h = harness(mode, 'native-claude');
    h.start();
    await h.until(() => h.packets.some(p => p.method === 'failed' || p.params?.message?.type === 'result'));
    assert.equal(h.log[0].lookup, 'native-claude');
    assert.equal(h.log[0].dir, '/workspace');
    if (mode === 'missing') assert.equal(h.fake.calls.length, 0);
    else {
      assert.equal(h.fake.calls[0].resume, 'native-claude');
      assert.equal(h.log[1].input.message.content.length, 1);
    }
    assert.equal(h.packets.some(p => p.method === 'failed'), mode !== 'success');
    h.input.end();
    await h.done;
  }
});

test('разрешения двух сессий, отказ и ответы на вопросы адресуются исходному запросу', async () => {
  const first = harness('permission');
  const second = harness('question');
  for (const h of [first, second]) h.start();
  await Promise.all([first, second].map(h => h.until(() => h.packets.some(p => p.method === 'request'))));
  const a = first.packets.find(p => p.method === 'request');
  const b = second.packets.find(p => p.method === 'request');
  first.command('reply', { context, requestId: b.id, result: { behavior: 'allow' } });
  await first.until(() => first.packets.some(p => p.error));
  assert(!first.log.some(p => p.decision));
  second.command('reply', { context, requestId: b.id, result: { behavior: 'allow', answers: { 'Чужой вопрос': 'ответ' } } });
  await second.until(() => second.packets.some(p => p.error));
  assert(!second.log.some(p => p.decision));
  first.command('reply', { context, requestId: a.id, result: { behavior: 'deny' } });
  second.command('reply', { context, requestId: b.id, result: { behavior: 'allow', answers: { 'Как продолжить?': 'Продолжить' } } });
  await Promise.all([first, second].map(h => h.until(() => h.log.some(p => p.decision))));
  assert.equal(first.log.find(p => p.decision).decision.behavior, 'deny');
  const decision = second.log.find(p => p.decision).decision;
  assert.deepEqual(decision.updatedInput.answers, { 'Как продолжить?': 'Продолжить' });
  assert.equal(decision.updatedInput.questions[0].question, 'Как продолжить?');
  assert.equal(decision.toolUseID, 'same-tool');
  for (const h of [first, second]) h.input.end();
  await Promise.all([first.done, second.done]);
});

test('отмена SDK снимает запрос и запрещает устаревшее разрешение', async () => {
  const h = harness('cancel');
  h.start();
  await h.until(() => h.packets.some(p => p.method === 'request_cancelled'));
  const request = h.packets.find(p => p.method === 'request');
  h.command('reply', { context, requestId: request.id, result: { behavior: 'allow' } });
  await h.until(() => h.packets.some(p => p.error));
  assert.equal(h.log.find(p => p.decision).decision.behavior, 'deny');
  h.input.end();
  await h.done;
});

test('ввод MCP возвращается только своему запросу', async () => {
  const h = harness('elicitation');
  h.start();
  await h.until(() => h.packets.some(p => p.method === 'request'));
  const request = h.packets.find(p => p.method === 'request');
  h.command('reply', { context, requestId: request.id, result: { action: 'accept', content: { value: 'ответ' } } });
  await h.until(() => h.log.some(p => p.decision));
  assert.deepEqual(h.log.find(p => p.decision).decision, { action: 'accept', content: { value: 'ответ' } });
  h.input.end();
  await h.done;
});

test('прерывание вызывает SDK выбранного запуска и ожидает фактический результат', async () => {
  let finish = false;
  const h = harness('interrupt', undefined, () => finish);
  const other = harness('wait', undefined, () => false);
  h.start(); other.start();
  await h.until(() => h.packets.some(p => p.params?.message?.type === 'stream_event'));
  h.command('interrupt', { context });
  await h.until(() => h.log.some(p => p.interrupt));
  assert(!h.packets.some(p => p.params?.message?.type === 'result'));
  assert(!other.log.some(p => p.interrupt));
  finish = true;
  await h.until(() => h.packets.some(p => p.params?.message?.type === 'result'));
  assert.equal(h.packets.find(p => p.params?.message?.type === 'result').params.message.terminal_reason, 'aborted_tools');
  h.input.end(); other.input.end();
  await Promise.all([h.done, other.done]);
});

test('отклонённое прерывание разрешает новые запросы инструментов и повторную остановку', async t => {
  const h = harness('wait', undefined, () => false);
  t.after(async () => { h.input.end(); await h.done; });
  h.start();
  await h.until(() => h.packets.some(p => p.params?.message?.type === 'stream_event'));
  const session = h.fake.sessions[0];
  const interrupt = session.interrupt;
  let attempts = 0;
  session.interrupt = async () => {
    if (++attempts === 1) throw new Error('Прерывание отклонено');
    await interrupt();
  };
  h.command('interrupt', { context });
  await h.until(() => h.packets.some(p => p.id === 2));
  assert.equal(h.packets.find(p => p.id === 2).error.message, 'Прерывание отклонено');
  const decision = h.fake.calls[0].canUseTool('Bash', { command: 'true' }, { signal: new AbortController().signal, toolUseID: 'after-interrupt' });
  await h.until(() => h.packets.some(p => p.method === 'request'));
  h.command('reply', { context, requestId: h.packets.find(p => p.method === 'request').id, result: { behavior: 'allow' } });
  assert.equal((await decision).behavior, 'allow');
  h.command('interrupt', { context });
  await h.until(() => h.packets.some(p => p.id === 4));
  assert(h.packets.find(p => p.id === 4).result);
  assert.equal(attempts, 2);
});

test('ошибка авторизации, исключение и разрыв не превращаются в успех', async () => {
  for (const mode of ['auth', 'throw', 'disconnect']) {
    const h = harness(mode);
    h.start();
    await h.until(() => h.packets.some(p => p.method === 'failed' || p.params?.message?.type === 'result'));
    if (mode === 'auth') {
      const result = h.packets.find(p => p.params?.message?.type === 'result').params.message;
      assert.equal(result.is_error, true);
      assert.equal(result.api_error_status, 401);
    } else assert(h.packets.some(p => p.method === 'failed'));
    h.input.end();
    await h.done;
  }
});
