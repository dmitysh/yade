import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'yade-desktop-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts/desktop');
  const bin = join(root, 'bin');
  const applications = join(root, 'Applications');
  const source = join(root, 'src-tauri/target/release/bundle/macos/Yade.app');
  for (const path of [scripts, bin, applications, source]) mkdirSync(path, { recursive: true });
  writeFileSync(join(source, 'version'), 'new');
  for (const name of ['install.command', 'distribute.command']) {
    cpSync(fileURLToPath(new URL(name, import.meta.url)), join(scripts, name));
  }
  const commands = {
    uname: 'printf "Darwin\\n"',
    npm: 'printf "%s|%s\\n" "$PWD" "$*" >> "$YADE_TEST_LOG"\n[[ "$*" != "${YADE_TEST_FAIL_NPM:-}" ]]',
    pgrep: 'exit "${YADE_TEST_RUNNING:-1}"',
    ditto: '[[ "${YADE_TEST_FAIL_COPY:-0}" != 1 ]] || exit 1\n/bin/cp -R "$1" "$2"',
    mv: 'if [[ "${YADE_TEST_FAIL_REPLACE:-0}" == 1 && "$1" == */.yade-install.*/Yade.app ]]; then exit 1; fi\n/bin/mv "$@"',
  };
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  }
  const app = join(applications, 'Yade.app');
  const log = join(root, 'commands');
  return {
    app, applications,
    previous() {
      mkdirSync(app);
      writeFileSync(join(app, 'version'), 'old');
      writeFileSync(join(app, 'obsolete'), 'old');
    },
    run(name = 'install.command', env = {}) {
      return spawnSync('/bin/bash', [join(scripts, name), applications], {
        cwd: tmpdir(), encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, YADE_TEST_LOG: log, ...env },
      });
    },
    commands() { return readFileSync(log, 'utf8').trim().split('\n').map(line => {
      const [cwd, command] = line.split('|');
      assert.equal(cwd, root);
      return command;
    }); },
  };
}

test('установка из другого каталога и замена всей предыдущей версии', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.app, 'version'), 'utf8'), 'new');
  writeFileSync(join(f.app, 'obsolete'), 'old');
  assert.equal(f.run().status, 0);
  assert.ok(!existsSync(join(f.app, 'obsolete')));
  assert.deepEqual(readdirSync(f.applications), ['Yade.app']);
  assert.deepEqual(f.commands(), ['ci', 'run desktop:build', 'run desktop:check',
    'ci', 'run desktop:build', 'run desktop:check']);
});

for (const [name, env] of [
  ['запущенное приложение', { YADE_TEST_RUNNING: '0' }],
  ['ошибка проверки сборки', { YADE_TEST_FAIL_NPM: 'run desktop:check' }],
  ['ошибка копирования', { YADE_TEST_FAIL_COPY: '1' }],
  ['ошибка замены', { YADE_TEST_FAIL_REPLACE: '1' }],
]) {
  test(`${name}: прежняя установка сохраняется`, t => {
    const f = fixture(t);
    f.previous();
    assert.notEqual(f.run('install.command', env).status, 0);
    assert.equal(readFileSync(join(f.app, 'version'), 'utf8'), 'old');
    assert.ok(existsSync(join(f.app, 'obsolete')));
    assert.deepEqual(readdirSync(f.applications), ['Yade.app']);
  });
}

test('сборка DMG сохраняет приложение для проверки без установки', t => {
  const f = fixture(t);
  assert.equal(f.run('distribute.command').status, 0);
  assert.deepEqual(f.commands(), ['ci', 'run tauri -- build --bundles app,dmg', 'run desktop:check']);
  assert.deepEqual(readdirSync(f.applications), []);
});

test('при ошибке установки зависимостей сборка DMG не начинается', t => {
  const f = fixture(t);
  assert.notEqual(f.run('distribute.command', { YADE_TEST_FAIL_NPM: 'ci' }).status, 0);
  assert.deepEqual(f.commands(), ['ci']);
});
