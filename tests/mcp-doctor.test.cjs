'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const {
  auditConfigFile,
  defaultClients,
  parseTomlServers,
  estimateTokens,
  drainJsonRpcFrames,
  probeStdioServer
} = require('../index.cjs');

const CLI_PATH = path.resolve(__dirname, '../bin/mcp-doctor.cjs');

test('defaultClients discovers 7 clients across win32, darwin, and linux', () => {
  const winClients = defaultClients('C:\\Users\\demo', 'C:\\Users\\demo\\AppData\\Roaming', 'win32');
  assert.equal(winClients.length, 7);
  assert.ok(winClients.some((c) => c.id === 'gemini-cli'));
  assert.ok(winClients.some((c) => c.id === 'antigravity'));
  assert.ok(winClients.some((c) => c.id === 'vscode' && c.path.includes('Code')));

  const macClients = defaultClients('/Users/demo', null, 'darwin');
  assert.ok(macClients.find((c) => c.id === 'claude-desktop').path.includes('Library'));
  assert.ok(macClients.find((c) => c.id === 'vscode').path.includes('Library'));

  const linuxClients = defaultClients('/home/demo', null, 'linux');
  assert.ok(linuxClients.find((c) => c.id === 'vscode').path.includes('.config'));
});

test('auditConfigFile flags Windows npx wrapper, missing paths, insecure HTTP, and expanded secrets without leaking env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-doctor-test-'));
  try {
    const cfg = path.join(dir, 'mcp.json');
    const secretVal = 'sk-ant-' + 'testdummy1234567890abcd';
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          badNpx: {
            command: 'npx',
            args: ['-y', '@example/server'],
            env: {
              ANTHROPIC_API_KEY: secretVal,
              HF_TOKEN: 'hf_' + 'testtoken1234567890abcdef'
            }
          },
          missingBin: {
            command: path.join(dir, 'does-not-exist.exe'),
            args: []
          },
          remoteHttp: {
            serverUrl: 'http://mcp.example.com/sse'
          },
          localHttp: {
            httpUrl: 'http://127.0.0.1:8080/mcp'
          }
        },
        servers: {
          vscodeSrv: {
            command: 'node',
            args: [],
            disabled: true
          }
        }
      })
    );

    const report = auditConfigFile(cfg, { platform: 'win32' });
    assert.equal(report.exists, true);
    assert.equal(report.servers.length, 5);

    const badNpx = report.servers.find((s) => s.name === 'badNpx');
    assert.ok(badNpx.findings.some((f) => f.code === 'WIN_CMD_WRAPPER'));
    assert.equal(badNpx.findings.filter((f) => f.code === 'HARDCODED_SECRET').length, 2);
    assert.equal(badNpx._probeEnv.ANTHROPIC_API_KEY, secretVal);
    assert.equal(JSON.stringify(report).includes(secretVal), false);

    const missingBin = report.servers.find((s) => s.name === 'missingBin');
    assert.ok(missingBin.findings.some((f) => f.code === 'COMMAND_NOT_FOUND'));

    const remoteHttp = report.servers.find((s) => s.name === 'remoteHttp');
    assert.ok(remoteHttp.findings.some((f) => f.code === 'INSECURE_HTTP_URL'));

    const localHttp = report.servers.find((s) => s.name === 'localHttp');
    assert.equal(localHttp.findings.length, 0);

    const vscodeSrv = report.servers.find((s) => s.name === 'vscodeSrv');
    assert.equal(vscodeSrv.disabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTomlServers parses Codex MCP sections, inline env tables, enabled=false, and comments', () => {
  const toml = [
    '[mcp_servers.lume]',
    'command = "node" # keep comment outside string',
    'args = ["server.cjs"]',
    'enabled = false',
    'env = { LUME_MODE = "readonly", TAG = "a#b" }',
    '',
    '[mcp_servers.remote]',
    'url = "https://mcp.example.com"',
    '[mcp_servers.remote.http_headers]',
    'Accept = "application/json"',
    ''
  ].join('\n');

  const parsed = parseTomlServers(toml);
  assert.equal(parsed.lume.command, 'node');
  assert.deepEqual(parsed.lume.args, ['server.cjs']);
  assert.equal(parsed.lume.enabled, false);
  assert.equal(parsed.lume.env.LUME_MODE, 'readonly');
  assert.equal(parsed.lume.env.TAG, 'a#b');
  assert.equal(parsed.remote.http_headers.Accept, 'application/json');
});

test('drainJsonRpcFrames decodes both NDJSON and Content-Length framed messages', () => {
  const frame1 = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  const frame2 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
  const buf = Buffer.from(`Content-Length: ${Buffer.byteLength(frame1)}\r\n\r\n${frame1}\n${frame2}\n`, 'utf8');

  const { messages, rest } = drainJsonRpcFrames(buf);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[1].id, 2);
  assert.equal(rest.length, 0);
});

test('probeStdioServer forwards env and handles Content-Length framed stdio servers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-doctor-probe-'));
  try {
    const mockServer = path.join(dir, 'mock-mcp.cjs');
    fs.writeFileSync(
      mockServer,
      [
        "const readline = require('node:readline');",
        "const send = (obj) => { const body = JSON.stringify(obj); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`); };",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock-cl', version: '1.0.0' }, capabilities: { tools: {} } } });",
        "  } else if (msg.method === 'tools/list') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: process.env.MCP_TEST_TOOL || 'missing', description: 'Pong test tool', inputSchema: { type: 'object', properties: {} } }] } });",
        '  }',
        '});'
      ].join('\n')
    );

    const res = await probeStdioServer({
      command: process.execPath,
      args: [mockServer],
      env: { MCP_TEST_TOOL: 'env-propagated' },
      timeoutMs: 3000
    });
    assert.equal(res.ok, true);
    assert.equal(res.toolCount, 1);
    assert.equal(res.tools[0].name, 'env-propagated');
    assert.equal(res.serverInfo.name, 'mock-cl');
    assert.ok(res.estimatedSchemaTokens > 0);
    assert.ok(estimateTokens({ a: 1 }) > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI supports --server filtering, skips disabled servers, and flags SCHEMA_TOKEN_BLOAT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-doctor-cli-'));
  try {
    const mockServer = path.join(dir, 'heavy-mcp.cjs');
    fs.writeFileSync(
      mockServer,
      [
        "const readline = require('node:readline');",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'heavy', version: '1.0.0' }, capabilities: { tools: {} } } }) + '\\n');",
        "  } else if (msg.method === 'tools/list') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'giant_tool', description: 'x'.repeat(400), inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');",
        '  }',
        '});'
      ].join('\n')
    );

    const cfg = path.join(dir, 'config.json');
    const cliSecret = 'sk-' + 'testsecretvalue1234567890';
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          heavy: {
            command: process.execPath,
            args: [mockServer],
            env: { SUPER_SECRET: cliSecret }
          },
          brokenDisabled: {
            command: path.join(dir, 'missing.exe'),
            disabled: true
          }
        }
      })
    );

    const out = execFileSync(
      process.execPath,
      [CLI_PATH, '--file', cfg, '--probe', '--token-budget', '50', '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(out.includes(cliSecret), false);

    const [report] = JSON.parse(out);
    const heavy = report.servers.find((s) => s.name === 'heavy');
    assert.equal(heavy.probe.ok, true);
    assert.ok(heavy.findings.some((f) => f.code === 'SCHEMA_TOKEN_BLOAT'));

    const disabledSrv = report.servers.find((s) => s.name === 'brokenDisabled');
    assert.equal(disabledSrv.probe.skipped, true);

    const filteredOut = execFileSync(
      process.execPath,
      [CLI_PATH, '--file', cfg, '--server', 'heavy', '--json'],
      { encoding: 'utf8' }
    );
    const [filteredReport] = JSON.parse(filteredOut);
    assert.equal(filteredReport.servers.length, 1);
    assert.equal(filteredReport.servers[0].name, 'heavy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
