import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/bundle/macos/Yade.app'));
const temporary = mkdtempSync(join(tmpdir(), 'yade-delivery-'));
try {
  const app = join(temporary, 'Yade.app');
  cpSync(source, app, { recursive: true });
  const runtime = join(app, 'Contents/Resources/runtime');
  const node = join(runtime, 'bin/node');
  const env = { HOME: temporary, PATH: '/usr/bin:/bin', TMPDIR: temporary };
  const options = { cwd: temporary, env, encoding: 'utf8', timeout: 30_000 };
  const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
  assert.equal(execFileSync(node, ['--version'], options).trim(), `v${manifest.engines.node}`);
  assert.ok(existsSync(join(runtime, 'NODE-LICENSE')));
  assert.ok(!existsSync(join(runtime, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64')));
  const request = { id: 1, method: 'interrupt', params: { context: { workspaceId: 'w', sessionId: 's', runId: 'r' } } };
  const reply = JSON.parse(execFileSync(node, [join(runtime, 'claude-bridge.ts')], {
    ...options, input: JSON.stringify(request) + '\n',
  }));
  assert.equal(reply.id, request.id);
  assert.equal(reply.error.code, -32602);
  // Проверяем тот же файл поставки с существующей подстановкой SDK, без подписочного запроса.
  const test = join(temporary, 'bridge-check.mjs');
  writeFileSync(test, `
    import assert from 'node:assert/strict';
    import { PassThrough } from 'node:stream';
    import { serve } from ${JSON.stringify(pathToFileURL(join(runtime, 'claude-bridge.ts')).href)};
    import { inspect } from ${JSON.stringify(pathToFileURL(join(runtime, 'claude-settings.mjs')).href)};
    import { fakeSdk } from ${JSON.stringify(pathToFileURL(join(root, 'src-tauri/test-fixtures/claude.mjs')).href)};
    const fake = fakeSdk();
    const input = new PassThrough(), output = new PassThrough();
    const packets = [];
    output.on('data', chunk => {
      const packet = JSON.parse(String(chunk));
      packets.push(packet);
      if (packet.params?.message?.type === 'result') input.end();
    });
    const done = serve(input, output, new PassThrough(), fake.sdk);
    input.write(JSON.stringify({id:1,method:'start',params:{
      context:{workspaceId:'w',sessionId:'s',runId:'r'},path:'/external/claude',
      cwd:process.cwd(),settings:{},input:[{type:'text',text:'Проверка поставки'}],
    }})+'\\n');
    await done;
    assert.ok(packets.some(packet => packet.params?.message?.type === 'result'));
    assert.equal(fake.calls[0].pathToClaudeCodeExecutable, '/external/claude');
    assert.equal(fake.calls[0].cwd, process.cwd());
    let closed = false;
    const catalog = await inspect('/external/claude', {}, () => ({
      supportedModels:async()=>[{value:'test',displayName:'Проверка'}],close:()=>{closed=true},
    }));
    assert.equal(catalog.models[0].value, 'test');
    assert.ok(closed);
  `);
  execFileSync(node, [test], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('Проверка копии .app пройдена: встроенный Node.js, SDK, протокол, поток и настройки Claude без Node.js в PATH.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
