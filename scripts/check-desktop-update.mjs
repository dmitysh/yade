import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const previous = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/bundle/macos/Yade.app'));
const next = resolve(process.argv[3] ?? previous);
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'yade-update-')));
const app = join(temporary, 'Yade.app');
const directory = join(temporary, 'Library/Application Support/dev.yade.desktop');
const database = join(directory, 'state.sqlite3');
let child;
async function stop() {
  if (child?.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
  }
  child = undefined;
}
async function launch(source) {
  rmSync(app, { recursive: true, force: true });
  cpSync(source, app, { recursive: true });
  let diagnostic = '';
  child = spawn(join(app, 'Contents/MacOS/yade'), [], {
    cwd: temporary, env: { HOME: temporary, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', TMPDIR: temporary },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  let error;
  child.on('error', value => { error = value; });
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.ifError(error);
    assert.equal(child.exitCode, null, diagnostic);
    assert.equal(child.signalCode, null, diagnostic);
    if (existsSync(database)) {
      const db = new DatabaseSync(database);
      const version = db.prepare('PRAGMA user_version').get().user_version;
      db.close();
      if (version === 5 || version === 6) {
        await delay(500);
        assert.equal(child.exitCode, null, diagnostic);
        assert.equal(child.signalCode, null, diagnostic);
        return;
      }
    }
    await delay(100);
  }
  assert.fail(`Приложение не открыло базу: ${diagnostic}`);
}
function savedState() {
  const db = new DatabaseSync(database);
  const state = Object.fromEntries(['projects', 'workspaces', 'sessions', 'runs', 'messages', 'drafts', 'settings']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close();
  return state;
}
try {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(database);
  for (const migration of ['001_initial.sql', '002_workspaces.sql', '003_preparation.sql', '004_source_commit.sql']) {
    db.exec(readFileSync(join(root, 'src-tauri/migrations', migration), 'utf8'));
  }
  db.exec('PRAGMA user_version=4');
  db.prepare("INSERT INTO projects(id,name,path,kind) VALUES('p','Проект',?,'folder')").run(temporary);
  db.prepare("INSERT INTO workspaces(id,project_id,name,path,kind) VALUES('w','p','Основное',?,'folder')").run(temporary);
  db.exec(`
    INSERT INTO sessions VALUES('s','w','claude','native','Разговор','completed');
    INSERT INTO runs VALUES('r','s','completed');
    INSERT INTO messages(session_id,run_id,role,body) VALUES('s','r','assistant','История');
    INSERT INTO drafts VALUES('message:s','w','s',NULL,'Не отправлено',NULL);
    INSERT INTO drafts VALUES('file','w',NULL,'main.rs','Правки','Исходник');
    INSERT INTO settings VALUES('model','"chosen"');
  `);
  db.close();
  const before = savedState();
  await launch(previous);
  await stop();
  assert.deepEqual(savedState(), before);
  await launch(next);
  await stop();
  assert.deepEqual(savedState(), before);
  const unchanged = new DatabaseSync(database);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(unchanged.prepare('SELECT count(*) AS count FROM runs').get().count, 1);
  unchanged.close();
  console.log('Готовые .app запущены с временным HOME и системным PATH. Миграция и замена приложения сохранили проекты, разговор, настройки и оба вида черновиков без повторного запуска.');
} finally {
  await stop();
  rmSync(temporary, { recursive: true, force: true });
}
