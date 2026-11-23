'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const WIN_WRAPPER_BINS = new Set(['npx', 'npm', 'pnpm', 'yarn']);

const SECRET_PATTERNS = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub PAT', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ }
];

function defaultClients(
  home = os.homedir(),
  appdata = process.env.APPDATA || null,
  platform = process.platform
) {
  const roamingDir =
    appdata ||
    (platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config'));

  const claudeDesktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : platform === 'win32'
        ? path.join(roamingDir, 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');

  const vscodeMcp =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
      : platform === 'win32'
        ? path.join(roamingDir, 'Code', 'User', 'mcp.json')
        : path.join(home, '.config', 'Code', 'User', 'mcp.json');

  return [
    { id: 'claude-desktop', name: 'Claude Desktop', format: 'json', path: claudeDesktop },
    { id: 'claude-code', name: 'Claude Code', format: 'json', path: path.join(home, '.claude.json') },
    { id: 'cursor', name: 'Cursor', format: 'json', path: path.join(home, '.cursor', 'mcp.json') },
    {
      id: 'codex',
      name: 'Codex',
      format: 'toml',
      path: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')
    },
    { id: 'gemini-cli', name: 'Gemini CLI', format: 'json', path: path.join(home, '.gemini', 'settings.json') },
    {
      id: 'antigravity',
      name: 'Antigravity',
      format: 'json',
      path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json')
    },
    { id: 'vscode', name: 'VS Code', format: 'json', path: vscodeMcp }
  ];
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function stripTomlComment(raw) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

function splitTopLevelCommas(inner) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      const seg = inner.slice(start, i).trim();
      if (seg) parts.push(seg);
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseTomlValue(raw) {
  const trimmed = stripTomlComment(raw);
  if (trimmed.startsWith('"') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const obj = {};
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return obj;
    for (const pair of splitTopLevelCommas(inner)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const rawKey = pair.slice(0, eq).trim();
      const key =
        (rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))
          ? rawKey.slice(1, -1)
          : rawKey;
      obj[key] = parseTomlValue(pair.slice(eq + 1));
    }
    return obj;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseTomlServers(text) {
  const servers = {};
  let currentServer = null;
  let subKey = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const section = header[1].trim();
      const subMatch = section.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\.(env|http_headers)$/);
      const srvMatch = section.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))$/);
      if (subMatch) {
        currentServer = subMatch[1] || subMatch[2] || subMatch[3];
        subKey = subMatch[4];
        servers[currentServer] = servers[currentServer] || {};
        servers[currentServer][subKey] = servers[currentServer][subKey] || {};
      } else if (srvMatch) {
        currentServer = srvMatch[1] || srvMatch[2] || srvMatch[3];
        subKey = null;
        servers[currentServer] = servers[currentServer] || {};
      } else {
        currentServer = null;
        subKey = null;
      }
      continue;
    }

    if (!currentServer) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=\s*(.+)$/);
    if (!kv) continue;
    const rawKey = kv[1].trim();
    const key =
      (rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))
        ? rawKey.slice(1, -1)
        : rawKey;
    const val = parseTomlValue(kv[2]);
    if (subKey) {
      servers[currentServer][subKey] = servers[currentServer][subKey] || {};
      servers[currentServer][subKey][key] = val;
    } else {
      servers[currentServer][key] = val;
    }
  }
  return servers;
}

function checkInsecureUrl(urlStr, findings) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    findings.push({ severity: 'error', code: 'INVALID_URL', message: `Malformed remote URL: ${urlStr}` });
    return;
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    findings.push({
      severity: 'warn',
      code: 'INSECURE_HTTP_URL',
      message: `Remote MCP URL uses unencrypted http:// on non-loopback host "${parsed.hostname}"; prefer https://.`
    });
  }
}

function auditServerEntry(name, def, platform = process.platform) {
  const findings = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    findings.push({ severity: 'error', code: 'INVALID_ENTRY', message: 'Server definition must be an object.' });
    return { name, command: '', args: [], disabled: false, findings };
  }

  const disabled = def.disabled === true || def.enabled === false;
  const remoteUrl = [def.url, def.serverUrl, def.httpUrl].find((u) => typeof u === 'string' && u.trim().length > 0);
  const isRemote = Boolean(remoteUrl);

  if (isRemote) {
    checkInsecureUrl(remoteUrl.trim(), findings);
  } else if (typeof def.command !== 'string' || !def.command.trim()) {
    findings.push({ severity: 'error', code: 'MISSING_COMMAND', message: 'Missing stdio "command" (or remote "url").' });
  }

  if (typeof def.command === 'string' && def.command.trim()) {
    const cmd = def.command.trim();
    const base = path.basename(cmd).toLowerCase();
    if (platform === 'win32' && WIN_WRAPPER_BINS.has(base)) {
      findings.push({
        severity: 'warn',
        code: 'WIN_CMD_WRAPPER',
        message: `Direct "${cmd}" on Windows often fails in MCP GUI hosts; prefer "cmd" with ["/c", "${cmd}", ...].`
      });
    }
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
      findings.push({
        severity: 'error',
        code: 'COMMAND_NOT_FOUND',
        message: `Executable path does not exist: ${cmd}`
      });
    }
  }

  if (def.args !== undefined && !Array.isArray(def.args)) {
    findings.push({ severity: 'error', code: 'INVALID_ARGS', message: '"args" must be an array of strings.' });
  }

  if (Array.isArray(def.args)) {
    for (const arg of def.args) {
      if (typeof arg === 'string' && path.isAbsolute(arg) && !fs.existsSync(arg)) {
        findings.push({
          severity: 'warn',
          code: 'MISSING_ARG_PATH',
          message: `Referenced path in args does not exist: ${arg}`
        });
      }
    }
  }

  if (def.env && typeof def.env === 'object' && !Array.isArray(def.env)) {
    for (const [k, v] of Object.entries(def.env)) {
      const val = String(v);
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(val)) {
          findings.push({
            severity: 'warn',
            code: 'HARDCODED_SECRET',
            message: `Env "${k}" matches ${pat.name}; avoid committing plaintext credentials.`
          });
          break;
        }
      }
    }
  }

  const entry = {
    name,
    command: def.command || (remoteUrl ? remoteUrl.trim() : ''),
    args: Array.isArray(def.args) ? def.args : [],
    disabled,
    findings
  };

  if (def.env && typeof def.env === 'object' && !Array.isArray(def.env)) {
    const sanitizedEnv = {};
    for (const [k, v] of Object.entries(def.env)) {
      if (v !== undefined && v !== null) sanitizedEnv[k] = String(v);
    }
    // Keep env non-enumerable so JSON output never leaks secrets while --probe can forward it.
    Object.defineProperty(entry, '_probeEnv', {
      value: sanitizedEnv,
      enumerable: false,
      configurable: true
    });
  }

  return entry;
}

function auditConfigFile(filePath, options = {}) {
  const platform = options.platform || process.platform;
  const format = options.format || (filePath.endsWith('.toml') ? 'toml' : 'json');
  const result = {
    path: filePath,
    format,
    exists: false,
    servers: [],
    errors: []
  };

  if (!fs.existsSync(filePath)) return result;
  result.exists = true;

  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    result.errors.push({ severity: 'error', code: 'SYMLINK_REJECTED', message: 'Config path is a symlink.' });
    return result;
  }
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) {
    result.errors.push({ severity: 'error', code: 'UNSAFE_FILE', message: 'Config is not a regular file or exceeds 2 MB.' });
    return result;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let servers = {};
  if (format === 'toml') {
    servers = parseTomlServers(raw);
  } else {
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result.errors.push({ severity: 'error', code: 'INVALID_JSON_ROOT', message: 'JSON root must be an object.' });
        return result;
      }
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
        Object.assign(servers, parsed.mcpServers);
      }
      if (parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)) {
        Object.assign(servers, parsed.servers);
      }
    } catch (err) {
      result.errors.push({ severity: 'error', code: 'JSON_PARSE_ERROR', message: err.message });
      return result;
    }
  }

  for (const [name, def] of Object.entries(servers)) {
    result.servers.push(auditServerEntry(name, def, platform));
  }
  return result;
}

function auditAllClients(options = {}) {
  const clients = options.clients || defaultClients(options.home, options.appdata, options.platform);
  const clientFilter = Array.isArray(options.clientIds) && options.clientIds.length > 0
    ? new Set(options.clientIds.map((c) => String(c).toLowerCase()))
    : null;

  return clients
    .filter((client) => !clientFilter || clientFilter.has(client.id.toLowerCase()))
    .map((client) => ({
      id: client.id,
      name: client.name,
      ...auditConfigFile(client.path, { format: client.format, platform: options.platform })
    }));
}

module.exports = {
  MAX_CONFIG_BYTES,
  defaultClients,
  estimateTokens,
  parseTomlValue,
  parseTomlServers,
  auditServerEntry,
  auditConfigFile,
  auditAllClients
};
