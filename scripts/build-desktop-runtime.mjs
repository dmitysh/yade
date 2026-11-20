import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'executors/runtime');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'darwin' || process.version !== `v${manifest.engines.node}`) {
  throw new Error(`Для сборки macOS нужен Node.js ${manifest.engines.node} из официального дистрибутива.`);
}
const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const architecture = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
if (!architecture || (target && target !== `${architecture}-apple-darwin`)) {
  throw new Error('Сборка поддерживает только архитектуру текущего Mac; используйте соответствующий Node.js.');
}
if (manifest.dependencies['@anthropic-ai/claude-agent-sdk'] !== app.dependencies['@anthropic-ai/claude-agent-sdk']) {
  throw new Error('Версии SDK в приложении и поставке должны совпадать.');
}
const node = realpathSync(process.execPath);
const libraries = execFileSync('/usr/bin/otool', ['-L', node], { encoding: 'utf8' }).trim().split('\n').slice(1);
if (libraries.some(line => !/^\s*\/(usr\/lib|System\/Library)\//.test(line))) {
  throw new Error('Node.js зависит от внешних библиотек; используйте официальный дистрибутив.');
}
execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--prefix', source,
  '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
const destination = join(root, 'src-tauri/resources/runtime');
rmSync(destination, { recursive: true, force: true });
mkdirSync(join(destination, 'bin'), { recursive: true });
cpSync(node, join(destination, 'bin/node'));
cpSync(resolve(dirname(node), '../LICENSE'), join(destination, 'NODE-LICENSE'));
for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
  cpSync(join(source, name), join(destination, name), { recursive: true });
}
for (const name of ['claude-bridge.ts', 'claude-settings.mjs']) {
  cpSync(join(root, 'executors', name), join(destination, name));
}
console.log(`Подготовлена среда macOS ${process.arch}: Node.js ${manifest.engines.node}.`);
