'use strict';

const { spawn } = require('node:child_process');
const { estimateTokens } = require('./audit.cjs');

/**
 * Extracts complete JSON-RPC messages from a stdout buffer supporting both
 * newline-delimited JSON and LSP-style Content-Length framing.
 * @param {Buffer} buf
 * @returns {{ messages: any[], rest: Buffer }}
 */
function drainJsonRpcFrames(buf) {
  const messages = [];
  let cursor = 0;

  while (cursor < buf.length) {
    while (cursor < buf.length && (buf[cursor] === 13 || buf[cursor] === 10 || buf[cursor] === 32 || buf[cursor] === 9)) {
      cursor += 1;
    }
    if (cursor >= buf.length) break;

    const slice = buf.subarray(cursor);
    if (slice.subarray(0, 15).toString('ascii').toLowerCase() === 'content-length:') {
      const headerEndCrlf = slice.indexOf('\r\n\r\n');
      const headerEndLf = slice.indexOf('\n\n');
      let headerEnd = -1;
      let sepLen = 0;
      if (headerEndCrlf !== -1 && (headerEndLf === -1 || headerEndCrlf < headerEndLf)) {
        headerEnd = headerEndCrlf;
        sepLen = 4;
      } else if (headerEndLf !== -1) {
        headerEnd = headerEndLf;
        sepLen = 2;
      }
      if (headerEnd === -1) break;

      const headerStr = slice.subarray(0, headerEnd).toString('ascii');
      const lenMatch = headerStr.match(/content-length:\s*(\d+)/i);
      if (!lenMatch) {
        cursor += headerEnd + sepLen;
        continue;
      }
      const bodyLen = Number(lenMatch[1]);
      const bodyStart = headerEnd + sepLen;
      if (slice.length < bodyStart + bodyLen) break;

      const bodyStr = slice.subarray(bodyStart, bodyStart + bodyLen).toString('utf8').trim();
      cursor += bodyStart + bodyLen;
      try {
        messages.push(JSON.parse(bodyStr));
      } catch {}
      continue;
    }

    const nlIdx = slice.indexOf(10);
    if (nlIdx === -1) break;
    const line = slice.subarray(0, nlIdx).toString('utf8').trim();
    cursor += nlIdx + 1;
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {}
  }

  return { messages, rest: buf.subarray(cursor) };
}

/**
 * Probes a stdio MCP server by sending initialize + tools/list over JSON-RPC 2.0.
 * @param {{ command: string, args?: string[], env?: Record<string, string>, timeoutMs?: number }} options
 */
function probeStdioServer({ command, args = [], env = {}, timeoutMs = 4000 }) {
  const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 4000;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let rawBuffer = Buffer.alloc(0);
    let stderr = '';
    let serverInfo = null;

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
        child.stdin.end();
      } catch {}
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
      finish({ ok: false, error: `Probe timed out after ${effectiveTimeout}ms` });
    }, effectiveTimeout);

    child.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    child.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, error: `Server exited early with code ${code}` });
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2048) {
        stderr += chunk.toString('utf8');
      }
    });

    child.stdout.on('data', (chunk) => {
      rawBuffer = Buffer.concat([rawBuffer, chunk]);
      const { messages, rest } = drainJsonRpcFrames(rawBuffer);
      rawBuffer = rest;

      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.id === 1 && msg.result) {
          serverInfo = msg.result.serverInfo || null;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2 && msg.result) {
          const tools = Array.isArray(msg.result.tools) ? msg.result.tools : [];
          const estimatedSchemaTokens = estimateTokens(tools);
          const toolBreakdown = tools
            .map((t) => ({ name: t.name, tokens: estimateTokens(t) }))
            .sort((a, b) => b.tokens - a.tokens);
          finish({
            ok: true,
            serverInfo,
            toolCount: tools.length,
            estimatedSchemaTokens,
            tools: toolBreakdown
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
          clientInfo: { name: 'mcp-doctor', version: '1.1.0' }
        }
      }) + '\n'
    );
  });
}

module.exports = { drainJsonRpcFrames, probeStdioServer };
