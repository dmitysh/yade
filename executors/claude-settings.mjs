import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

/** @returns {import('@anthropic-ai/claude-agent-sdk').Options} */
export function launchOptions(path, cwd, settings, environment = process.env, loadProjectSettings = false) {
  const env = { ...environment };
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDECODE',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ]) delete env[key];
  env.CLAUDE_CODE_ENTRYPOINT = 'yade';
  const overrides = {
    ...(!loadProjectSettings ? { disableAllHooks: true } : {}),
    ...(settings.fastMode != null ? { fastMode: settings.fastMode } : {}),
  };
  return {
    pathToClaudeCodeExecutable: path, cwd, env,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: loadProjectSettings ? ['user', 'project', 'local'] : ['user'],
    ...(!loadProjectSettings ? { mcpServers: {}, strictMcpConfig: true } : {}),
    includePartialMessages: true,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
    ...(settings.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(settings.workMode === 'plan' ? { permissionMode: 'plan' } : {}),
    ...(settings.workMode === 'default' && settings.permissionMode === 'plan' ? { permissionMode: 'default' } : {}),
    ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}),
    ...(Object.keys(overrides).length ? { settings: overrides } : {}),
  };
}

export async function inspect(path, settings, createQuery = query, readSettings = resolveSettings) {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  async function* input() { await done; }
  const options = launchOptions(path, homedir(), settings);
  const session = createQuery({
    prompt: input(),
    options: {
      ...options,
      persistSession: false,
      allowDangerouslySkipPermissions: true,
      canUseTool: async (_tool, _input, { toolUseID }) => ({ behavior: 'deny', message: 'Проверка настроек не выполняет действия', toolUseID }),
    },
  });
  const timer = setTimeout(() => session.close(), 20_000);
  try {
    const models = await session.supportedModels();
    const { effective } = await readSettings({ cwd: options.cwd, settingSources: options.settingSources });
    const candidates = [
      ['default', 'Штатные запросы разрешений'], ['acceptEdits', 'Разрешать правки файлов'],
      ['plan', 'Планирование'], ['dontAsk', 'Отклонять действия без запроса'],
      ['bypassPermissions', 'Пропускать проверки разрешений'],
      ...(models.some(m => m.supportsAutoMode) ? [['auto', 'Автоматическая проверка']] : []),
    ].map(([value, label]) => ({ value, label }));
    if (settings.permissionMode === 'auto' && !models.find(m => m.value === settings.model)?.supportsAutoMode) {
      throw new Error('Выбранная модель не поддерживает автоматическую проверку разрешений');
    }
    if (settings.reasoningEffort || settings.fastMode === true) {
      const model = models.find(m => m.value === settings.model);
      if (!model) throw new Error('Сначала выберите модель для настройки усилий и быстрого режима');
      if (settings.reasoningEffort && !model.supportedEffortLevels?.includes(settings.reasoningEffort)) throw new Error('Выбранная модель не поддерживает эти усилия рассуждения');
      if (settings.fastMode === true && !model.supportsFastMode) throw new Error('Выбранная модель не поддерживает быстрый режим');
    }
    if (settings.model) {
      if (!models.some(m => m.value === settings.model)) throw new Error('Выбранная модель отсутствует в каталоге Claude Code; настройки не сохранены');
      await session.setModel(settings.model);
    }
    const permissionModes = [];
    for (const choice of candidates) {
      if (choice.value === 'auto' && !settings.model) { permissionModes.push(choice); continue; }
      try {
        await session.setPermissionMode(choice.value);
        permissionModes.push(choice);
      } catch { /* Недоступные в текущем профиле режимы не предлагаются. */ }
    }
    const mode = options.permissionMode;
    if (mode) await session.setPermissionMode(mode);
    return {
      defaultModel: models.find(m => m.value === (process.env.ANTHROPIC_MODEL || effective.model || 'default'))?.value ?? null,
      defaultReasoningEffort: process.env.CLAUDE_CODE_EFFORT_LEVEL || effective.effortLevel || null,
      models: models.map(m => ({ value: m.value, label: m.displayName, reasoningEfforts: m.supportedEffortLevels ?? [], supportsFastMode: m.supportsFastMode ?? false, supportsAutoMode: m.supportsAutoMode ?? false })),
      workModes: [{ value: 'default', label: 'Выполнение' }, { value: 'plan', label: 'План' }]
        .filter(mode => permissionModes.some(choice => choice.value === mode.value)),
      approvalPolicies: [], sandboxes: [], warnings: [],
      permissionModes,
    };
  } finally {
    clearTimeout(timer);
    finish();
    session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [path, settings] = process.argv.slice(2);
  inspect(path, JSON.parse(settings)).then(
    result => console.log(JSON.stringify(result)),
    error => { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; },
  );
}
