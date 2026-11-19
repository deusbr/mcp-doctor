'use strict';

const { spawn } = require('node:child_process');
const { estimateTokens } = require('./audit.cjs');

/**
 * Probes a stdio MCP server by sending initialize + tools/list over newline-delimited JSON-RPC 2.0.
 * @param {{ command: string, args?: string[], env?: Record<string, string>, timeoutMs?: number }} options
 */
function probeStdioServer({ command, args = [], env = {}, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let buffer = '';
    let stderr = '';
    let serverInfo = null;
    let tools = null;

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true
    });

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve({
        ...outcome,
        latencyMs: Date.now() - startedAt,
        stderr: stderr.trim().slice(0, 500)
      });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `Probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    child.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, error: `Server exited early with code ${code}` });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          serverInfo = msg.result.serverInfo || null;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2 && msg.result) {
          tools = Array.isArray(msg.result.tools) ? msg.result.tools : [];
          const estimatedSchemaTokens = estimateTokens(tools);
          finish({
            ok: true,
            serverInfo,
            toolCount: tools.length,
            estimatedSchemaTokens,
            tools: tools.map((t) => ({ name: t.name, tokens: estimateTokens(t) }))
          });
        } else if (msg.error && (msg.id === 1 || msg.id === 2)) {
          finish({ ok: false, error: msg.error.message || 'JSON-RPC error' });
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mcp-doctor', version: '1.0.0' }
        }
      }) + '\n'
    );
  });
}

module.exports = { probeStdioServer };