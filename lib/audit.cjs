'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const SECRET_PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub PAT', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ }
];

function defaultClients(
  home = os.homedir(),
  appdata = process.env.APPDATA || path.join(home, '.config'),
  platform = process.platform
) {
  const claudeDesktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(appdata, 'Claude', 'claude_desktop_config.json');

  return [
    { id: 'claude-desktop', name: 'Claude Desktop', format: 'json', path: claudeDesktop },
    { id: 'claude-code', name: 'Claude Code', format: 'json', path: path.join(home, '.claude.json') },
    { id: 'cursor', name: 'Cursor', format: 'json', path: path.join(home, '.cursor', 'mcp.json') },
    {
      id: 'codex',
      name: 'Codex',
      format: 'toml',
      path: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')
    }
  ];
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function parseTomlValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function parseTomlServers(text) {
  const servers = {};
  let currentServer = null;
  let inEnv = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const section = header[1].trim();
      const envMatch = section.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\.env$/);
      const srvMatch = section.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))$/);
      if (envMatch) {
        currentServer = envMatch[1] || envMatch[2] || envMatch[3];
        servers[currentServer] = servers[currentServer] || { env: {} };
        servers[currentServer].env = servers[currentServer].env || {};
        inEnv = true;
      } else if (srvMatch) {
        currentServer = srvMatch[1] || srvMatch[2] || srvMatch[3];
        servers[currentServer] = servers[currentServer] || {};
        inEnv = false;
      } else {
        currentServer = null;
        inEnv = false;
      }
      continue;
    }

    if (!currentServer) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = parseTomlValue(kv[2]);
    if (inEnv) {
      servers[currentServer].env = servers[currentServer].env || {};
      servers[currentServer].env[key] = val;
    } else {
      servers[currentServer][key] = val;
    }
  }
  return servers;
}

function auditServerEntry(name, def, platform = process.platform) {
  const findings = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    findings.push({ severity: 'error', code: 'INVALID_ENTRY', message: 'Server definition must be an object.' });
    return { name, findings };
  }

  const isRemote = typeof def.url === 'string' && def.url.trim().length > 0;
  if (!isRemote && (typeof def.command !== 'string' || !def.command.trim())) {
    findings.push({ severity: 'error', code: 'MISSING_COMMAND', message: 'Missing stdio "command" (or remote "url").' });
  }

  if (typeof def.command === 'string') {
    const cmd = def.command.trim();
    const base = path.basename(cmd).toLowerCase();
    if (platform === 'win32' && (base === 'npx' || base === 'npm' || base === 'pnpm')) {
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

  if (def.env && typeof def.env === 'object') {
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

  return { name, command: def.command || def.url || '', args: def.args || [], findings };
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
      servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
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
  return clients.map((client) => ({
    id: client.id,
    name: client.name,
    ...auditConfigFile(client.path, { format: client.format, platform: options.platform })
  }));
}

module.exports = {
  MAX_CONFIG_BYTES,
  defaultClients,
  estimateTokens,
  parseTomlServers,
  auditServerEntry,
  auditConfigFile,
  auditAllClients
};