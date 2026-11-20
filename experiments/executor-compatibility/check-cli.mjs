import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'yade-cli-check-'));

function run(executable, args, env = process.env) {
  return spawnSync(executable, args, {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function authStatus(executable, isolated) {
  const env = { ...process.env };
  const args = executable === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  if (isolated) {
    for (const key of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK', 'OPENAI_API_KEY', 'CODEX_API_KEY',
    ]) delete env[key];
    if (executable === 'codex') args.unshift('-c', 'cli_auth_credentials_store="ephemeral"');
    else env.CLAUDE_CONFIG_DIR = directory;
  }
  const result = run(executable, args, env);
  if (result.error) throw result.error;
  if (executable === 'claude') {
    const status = JSON.parse(result.stdout);
    return {
      exitCode: result.status,
      loggedIn: status.loggedIn,
      method: status.authMethod,
      subscription: status.subscriptionType ?? null,
    };
  }
  const output = result.stdout + result.stderr;
  if (/Logged in using ChatGPT/.test(output)) {
    return { exitCode: result.status, loggedIn: true, method: 'chatgpt' };
  }
  if (/Not logged in/.test(output)) {
    return { exitCode: result.status, loggedIn: false, method: 'none' };
  }
  throw new Error('Состояние входа Codex не распознано; совместимость не подтверждена');
}

try {
  for (const executable of ['codex', 'claude']) {
    const missing = run(executable, ['--version'], { PATH: directory });
    assert.equal(missing.error?.code, 'ENOENT');
    const version = run(executable, ['--version']);
    if (version.error?.code === 'ENOENT') {
      console.log(JSON.stringify({ executable, state: 'missing' }));
      continue;
    }
    if (version.error) throw version.error;
    assert.equal(version.status, 0);
    const current = authStatus(executable, false);
    const isolated = authStatus(executable, true);
    assert.equal(isolated.loggedIn, false);
    assert.equal(isolated.exitCode, 1);
    console.log(JSON.stringify({
      executable,
      version: version.stdout.trim(),
      current,
      missingCli: 'ENOENT',
      isolated,
    }));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
