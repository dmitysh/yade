import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { inspect as inspectExecutor, launchOptions } from './claude-settings.mjs';

const inspect = (path, settings, createQuery, readSettings = async () => ({ effective: {} })) =>
  inspectExecutor(path, settings, createQuery, readSettings);

test('в доверенном пространстве сохраняются штатный профиль и настройки проекта', () => {
  const env = { CLAUDE_CONFIG_DIR: '/profile', HTTPS_PROXY: 'proxy', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1' };
  const options = launchOptions('/installed/claude', '/workspace', {}, env, true);
  assert.equal(options.cwd, '/workspace');
  assert.equal(options.pathToClaudeCodeExecutable, '/installed/claude');
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(options.env, { CLAUDE_CONFIG_DIR: '/profile', HTTPS_PROXY: 'proxy', CLAUDE_CODE_ENTRYPOINT: 'yade' });
  assert.equal('model' in options, false);
  assert.equal('permissionMode' in options, false);
  assert.equal(options.strictMcpConfig, undefined);
  assert.equal(options.settings, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'secret');
});

test('проверка передаёт выбор исходному SDK и закрывает только свой процесс без сообщения', async () => {
  let closed = false;
  let prompt;
  const calls = [];
  const catalog = await inspect('/cli', { model: 'sonnet', permissionMode: 'plan' }, args => {
    assert.equal(args.options.cwd, homedir());
    assert.deepEqual(args.options.settingSources, ['user']);
    assert.deepEqual(args.options.settings, { disableAllHooks: true });
    assert.deepEqual(args.options.mcpServers, {});
    assert.equal(args.options.strictMcpConfig, true);
    assert.equal(args.options.persistSession, false);
    assert.equal(args.options.model, 'sonnet');
    prompt = args.prompt;
    return {
      supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
      setModel: async value => { calls.push(value); },
      setPermissionMode: async value => { calls.push(value); },
      close: () => { closed = true; },
    };
  });
  assert.deepEqual(calls, ['sonnet', 'default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'plan']);
  assert.deepEqual(catalog.models, [{ value: 'sonnet', label: 'Sonnet', reasoningEfforts: [], supportsFastMode: false, supportsAutoMode: false }]);
  assert.equal(closed, true);
  assert.deepEqual(await prompt.next(), { done: true, value: undefined });
});

test('усилия, ускорение и режим планирования передаются в параметры запуска', () => {
  const settings = { model: 'chosen', workMode: 'plan', permissionMode: 'acceptEdits', reasoningEffort: 'high', fastMode: true };
  const plan = launchOptions('/cli', '/workspace', settings, {}, true);
  assert.equal(plan.permissionMode, 'plan');
  assert.equal(plan.effort, 'high');
  assert.deepEqual(plan.settings, { fastMode: true });
  assert.equal(launchOptions('/cli', '/workspace', { ...settings, workMode: 'default' }, {}).permissionMode, 'acceptEdits');
  assert.equal(launchOptions('/cli', '/workspace', { workMode: 'default', permissionMode: 'plan', fastMode: false }, {}).permissionMode, 'default');
  assert.deepEqual(launchOptions('/cli', '/workspace', { fastMode: false }, {}).settings, { disableAllHooks: true, fastMode: false });
});

test('штатная модель берётся из каталога, неизвестные усилия не подставляются', async () => {
  const catalog = await inspect('/cli', {}, () => ({
    supportedModels: async () => [
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'default', displayName: 'Штатная модель', supportedEffortLevels: ['medium', 'high'] },
    ],
    setPermissionMode: async () => {}, close: () => {},
  }));
  assert.equal(catalog.defaultModel, 'default');
  assert.equal(catalog.defaultReasoningEffort, null);
});

test('штатный выбор для каталога читается из пользовательского профиля', async () => {
  const catalog = await inspect('/cli', {}, () => ({
    supportedModels: async () => [{ value: 'default', displayName: 'Штатная модель' }, { value: 'sonnet', displayName: 'Sonnet' }],
    setPermissionMode: async () => {}, close: () => {},
  }), async options => {
    assert.deepEqual(options, { cwd: homedir(), settingSources: ['user'] });
    return { effective: { model: 'sonnet', effortLevel: 'medium' } };
  });
  assert.equal(catalog.defaultModel, 'sonnet');
  assert.equal(catalog.defaultReasoningEffort, 'medium');
});

test('каталог сохраняет возможности модели и отклоняет несовместимые параметры', async () => {
  const createQuery = () => ({
    supportedModels: async () => [{ value: 'chosen', displayName: 'Модель', supportedEffortLevels: ['low', 'high'], supportsFastMode: true }],
    setModel: async () => {}, setPermissionMode: async () => {}, close: () => {},
  });
  const catalog = await inspect('/cli', { model: 'chosen', reasoningEffort: 'high', fastMode: true }, createQuery);
  assert.deepEqual(catalog.models[0], { value: 'chosen', label: 'Модель', reasoningEfforts: ['low', 'high'], supportsFastMode: true, supportsAutoMode: false });
  await assert.rejects(inspect('/cli', { model: 'chosen', reasoningEffort: 'max' }, createQuery), /не поддерживает/);
  await assert.rejects(inspect('/cli', { fastMode: true }, createQuery), /Сначала выберите модель/);
  assert.equal(catalog.permissionModes.some(mode => mode.value === 'auto'), false);
});

test('режимы разрешений учитывают ответ CLI и поддержку автоматической проверки моделью', async () => {
  const createQuery = () => ({
    supportedModels: async () => [{ value: 'chosen', displayName: 'Модель', supportsAutoMode: true }],
    setModel: async () => {},
    setPermissionMode: async mode => { if (mode === 'bypassPermissions' || mode === 'plan') throw new Error('Режим запрещён'); },
    close: () => {},
  });
  const catalog = await inspect('/cli', { model: 'chosen' }, createQuery);
  assert.deepEqual(catalog.permissionModes.map(mode => mode.value), ['default', 'acceptEdits', 'dontAsk', 'auto']);
  assert.deepEqual(catalog.workModes.map(mode => mode.value), ['default']);
  await inspect('/cli', { model: 'chosen', permissionMode: 'auto' }, createQuery);
  await assert.rejects(inspect('/cli', { model: 'missing', permissionMode: 'auto' }, createQuery), /не поддерживает автоматическую/);
  await assert.rejects(inspect('/cli', { model: 'chosen', permissionMode: 'plan' }, createQuery), /Режим запрещён/);
});

test('отклонённый параметр не выдаётся за применённый, процесс закрывается', async () => {
  let closed = false;
  await assert.rejects(inspect('/cli', { permissionMode: 'acceptEdits' }, () => ({
    supportedModels: async () => [],
    setPermissionMode: async () => { throw new Error('Режим недоступен'); },
    close: () => { closed = true; },
  })), /Режим недоступен/);
  assert.equal(closed, true);
});
