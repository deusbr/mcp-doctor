'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { auditConfigFile, parseTomlServers, estimateTokens, probeStdioServer } = require('../index.cjs');

test('auditConfigFile flags Windows npx wrapper, missing paths, and hardcoded secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-doctor-test-'));
  try {
    const cfg = path.join(dir, 'claude_desktop_config.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          badNpx: {
            command: 'npx',
            args: ['-y', '@example/server'],
            env: { OPENAI_API_KEY: 'sk-' + 'testdummy1234567890abcd' }
          },
          missingBin: {
            command: path.join(dir, 'does-not-exist.exe'),
            args: []
          }
        }
      })
    );

    const report = auditConfigFile(cfg, { platform: 'win32' });
    assert.equal(report.exists, true);
    assert.equal(report.servers.length, 2);

    const badNpx = report.servers.find((s) => s.name === 'badNpx');
    assert.ok(badNpx.findings.some((f) => f.code === 'WIN_CMD_WRAPPER'));
    assert.ok(badNpx.findings.some((f) => f.code === 'HARDCODED_SECRET'));

    const missingBin = report.servers.find((s) => s.name === 'missingBin');
    assert.ok(missingBin.findings.some((f) => f.code === 'COMMAND_NOT_FOUND'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTomlServers parses Codex MCP sections and env tables', () => {
  const toml = [
    '[mcp_servers.lume]',
    'command = "node"',
    'args = ["server.cjs"]',
    '',
    '[mcp_servers.lume.env]',
    'LUME_MODE = "readonly"',
    ''
  ].join('\n');

  const parsed = parseTomlServers(toml);
  assert.equal(parsed.lume.command, 'node');
  assert.deepEqual(parsed.lume.args, ['server.cjs']);
  assert.equal(parsed.lume.env.LUME_MODE, 'readonly');
});

test('probeStdioServer performs initialize + tools/list and estimates schema tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-doctor-probe-'));
  try {
    const mockServer = path.join(dir, 'mock-mcp.cjs');
    fs.writeFileSync(
      mockServer,
      [
        "const readline = require('node:readline');",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock', version: '1.0.0' }, capabilities: { tools: {} } } }) + '\\n');",
        "  } else if (msg.method === 'tools/list') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'Pong test tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');",
        '  }',
        '});'
      ].join('\n')
    );

    const res = await probeStdioServer({ command: process.execPath, args: [mockServer], timeoutMs: 3000 });
    assert.equal(res.ok, true);
    assert.equal(res.toolCount, 1);
    assert.equal(res.serverInfo.name, 'mock');
    assert.ok(res.estimatedSchemaTokens > 0);
    assert.ok(estimateTokens({ a: 1 }) > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});