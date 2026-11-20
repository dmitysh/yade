import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const directory = realpathSync(mkdtempSync(join(sourceDirectory, '../.matrix-')));
const probe = join(sourceDirectory, 'target/debug/codex-compatibility');
const fileMarker = 'FILE_' + randomUUID();
const mcpMarker = 'MCP_' + randomUUID();
const skillPath = join(directory, '.agents/skills/compatibility-probe/SKILL.md');
const imagePath = join(directory, 'colors.png');
const serverPath = join(directory, 'fixture-mcp.mjs');
const launcher = join(directory, 'codex-launch');
const overrides = [
  'mcp_servers.yade_fixture.command=' + JSON.stringify(process.execPath),
  'mcp_servers.yade_fixture.args=[' + JSON.stringify(serverPath) + ']',
  'model_reasoning_effort="low"',
];
const flags = overrides.flatMap((value) => ['-c', value]);
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

mkdirSync(dirname(skillPath), { recursive: true });
mkdirSync(join(directory, '.codex'));
writeFileSync(join(directory, 'AGENTS.md'), '# Проверочный проект\nВ конце каждого ответа добавляй PROJECT_INSTRUCTIONS_OK.\n');
writeFileSync(skillPath, '---\nname: compatibility-probe\ndescription: Проверка загрузки проектного навыка.\n---\nДобавь в ответ SKILL_INSTRUCTIONS_OK.\n');
writeFileSync(join(directory, 'fixture.txt'), fileMarker);
writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAASElEQVR4nO3PwQkAMBCEwO2/6aSIe4ggTAG6t6nxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QVHHzLD+GoHbk06AAAAAElFTkSuQmCC', 'base64'));
writeFileSync(serverPath, `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
for await(const line of lines){
 const request=JSON.parse(line);
 if(request.id===undefined)continue;
 let result;
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'yade-fixture',version:'1.0.0'}};
 else if(request.method==='tools/list')result={tools:[{name:'ping',description:'Вернуть проверочную строку.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 else if(request.method==='tools/call'&&request.params.name==='ping')result={content:[{type:'text',text:${JSON.stringify(mcpMarker)}}]};
 else if(request.method==='ping')result={};
 else {console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unsupported_method'}}));continue;}
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
}
`);
writeFileSync(join(directory, '.codex/config.toml'), [
  'model_reasoning_effort = "low"',
  '[mcp_servers.yade_fixture]',
  'command = ' + JSON.stringify(process.execPath),
  'args = [' + JSON.stringify(serverPath) + ']',
  '',
].join('\n'));
writeFileSync(launcher, '#!/bin/sh\nexec codex ' + flags.map(shellQuote).join(' ') + ' "$@"\n', { mode: 0o700 });

const prompt = [
  'Используй $compatibility-probe.',
  'Прочитай @fixture.txt в текущей папке и вызови ping сервера yade_fixture.',
  'Определи цвет вложенного изображения.',
  'В итоговом ответе напиши обе проверочные строки из файла и MCP, а затем название цвета на английском.',
  'Не меняй файлы и не вызывай другие MCP-серверы.',
].join(' ');

function run(name, command, args, env) {
  const result = spawnSync(command, args, {
    cwd: directory, env, encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(directory, name + '.jsonl'), result.stdout ?? '');
  writeFileSync(join(directory, name + '.stderr'), result.stderr ?? '');
  assert.equal(result.status, 0, name + ': ' + (result.error?.message ?? result.stderr));
  const packets = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const text = packets.flatMap((packet) => {
    if (packet.method === 'item/completed' && packet.params.item.type === 'agentMessage') return [packet.params.item.text];
    if (packet.type === 'item.completed' && packet.item.type === 'agent_message') return [packet.item.text];
    return [];
  }).join('\n');
  for (const marker of [fileMarker, mcpMarker, 'SKILL_INSTRUCTIONS_OK', 'PROJECT_INSTRUCTIONS_OK']) {
    assert.ok(text.includes(marker), name + ': отсутствует ' + marker + '; ответ: ' + text);
  }
  assert.match(text, /red/i);
  console.log(JSON.stringify({ scenario: name, passed: true, directory, text }));
  return packets;
}

console.log(JSON.stringify({ directory }));
const packets = run('app-server', probe, [directory, prompt], {
  ...process.env,
  YADE_CODEX_BIN: launcher,
  YADE_APPROVAL: 'accept',
  YADE_INPUT_JSON: JSON.stringify([
    { type: 'text', text: prompt },
    { type: 'skill', name: 'compatibility-probe', path: skillPath },
    { type: 'localImage', path: imagePath },
  ]),
});
const metadata = packets.find((packet) => packet.operation);
assert.equal(metadata.reasoningEffort, 'low');
assert.ok(metadata.instructionSources.includes(join(directory, 'AGENTS.md')));
const sources = packets.find((packet) => packet.configSources).configSources;
assert.ok(sources.some((source) => source.type === 'user'));
const disabled = packets.find((packet) => packet.configSources).disabledConfigSources;
const projectLoaded = sources.some((source) => source.type === 'project' && source.dotCodexFolder === join(directory, '.codex'));
const projectTrustRequired = disabled.some((layer) => layer.source.type === 'project' && /trusted project/.test(layer.reason));
assert.ok(projectLoaded || projectTrustRequired);
console.log(JSON.stringify({ configuration: 'checked', model: metadata.model, sources, projectLoaded, projectTrustRequired, mcpConfiguration: 'sessionFlags' }));

run('native-cli', 'codex', [
  ...flags, 'exec', '--json', '--sandbox', 'read-only', '--image', imagePath, '--', prompt,
], process.env);
assert.equal(readFileSync(join(directory, 'fixture.txt'), 'utf8'), fileMarker);
rmSync(directory, { recursive: true, force: true });
