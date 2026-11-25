#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { version: PKG_VERSION } = require('../package.json');
const { auditAllClients, auditConfigFile } = require('../lib/audit.cjs');
const { probeStdioServer } = require('../lib/probe.cjs');

const DEFAULT_TOKEN_BUDGET = 5000;

function splitCsvList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    json: false,
    probe: false,
    timeoutMs: 4000,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    includeDisabled: false,
    file: null,
    clients: [],
    servers: [],
    help: false,
    version: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--include-disabled') args.includeDisabled = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--file' && argv[i + 1]) args.file = path.resolve(argv[++i]);
    else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Number(argv[++i]) || 4000;
    else if (a === '--token-budget' && argv[i + 1]) {
      const n = Number(argv[++i]);
      args.tokenBudget = Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOKEN_BUDGET;
    } else if (a === '--client' && argv[i + 1]) {
      args.clients.push(...splitCsvList(argv[++i]));
    } else if (a === '--server' && argv[i + 1]) {
      args.servers.push(...splitCsvList(argv[++i]));
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      'Usage: mcp-doctor [options]',
      '',
      'Options:',
      '  --file <path>          Audit a single JSON or TOML MCP config file',
      '  --client <id[,id...]>  Filter clients (claude-desktop, claude-code, cursor, codex, gemini-cli, antigravity, vscode)',
      '  --server <name[,...]>  Filter MCP server entries by name',
      '  --probe                Run live stdio initialize + tools/list handshakes',
      '  --timeout <ms>         Probe timeout per server in ms (default: 4000)',
      '  --token-budget <n>     Warn on schema bloat above <n> tokens (default: 5000, 0 to disable)',
      '  --include-disabled     Include disabled servers during --probe',
      '  --json                 Output machine-readable JSON report',
      '  -v, --version          Show version',
      '  -h, --help             Show this help'
    ].join('\n')
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(PKG_VERSION);
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  let reports = args.file
    ? [{ id: 'custom', name: 'Custom File', ...auditConfigFile(args.file) }]
    : auditAllClients({ clientIds: args.clients });

  if (args.servers.length > 0) {
    const serverSet = new Set(args.servers.map((s) => s.toLowerCase()));
    reports = reports.map((r) => ({
      ...r,
      servers: r.servers.filter((s) => serverSet.has(s.name.toLowerCase()))
    }));
  }

  if (args.probe) {
    for (const report of reports) {
      for (const srv of report.servers) {
        if (srv.disabled && !args.includeDisabled) {
          srv.probe = { skipped: true, reason: 'disabled' };
          continue;
        }
        if (srv.command && !/^https?:\/\//i.test(srv.command)) {
          srv.probe = await probeStdioServer({
            command: srv.command,
            args: srv.args,
            env: srv._probeEnv || {},
            timeoutMs: args.timeoutMs
          });
          if (srv.probe.ok && args.tokenBudget > 0 && srv.probe.estimatedSchemaTokens > args.tokenBudget) {
            const topTools = (srv.probe.tools || [])
              .slice(0, 3)
              .map((t) => `${t.name}(~${t.tokens})`)
              .join(', ');
            srv.findings.push({
              severity: 'warn',
              code: 'SCHEMA_TOKEN_BLOAT',
              message: `Schema uses ~${srv.probe.estimatedSchemaTokens} tokens (budget: ${args.tokenBudget}). Heaviest tools: ${topTools || 'n/a'}.`
            });
          }
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  let hasErrors = false;
  for (const r of reports) {
    console.log(`\n[${r.name}] ${r.path} (${r.exists ? 'found' : 'not found'})`);
    for (const err of r.errors) {
      hasErrors = true;
      console.log(`  ERROR [${err.code}]: ${err.message}`);
    }
    for (const srv of r.servers) {
      const tag = srv.disabled ? ' [DISABLED]' : '';
      console.log(`  - ${srv.name}${tag}: ${srv.command}`);
      for (const f of srv.findings) {
        if (f.severity === 'error' && !srv.disabled) hasErrors = true;
        console.log(`    ${f.severity.toUpperCase()} [${f.code}]: ${f.message}`);
      }
      if (srv.probe) {
        if (srv.probe.skipped) {
          console.log(`    PROBE SKIPPED (${srv.probe.reason})`);
        } else if (srv.probe.ok) {
          console.log(
            `    PROBE OK (${srv.probe.latencyMs}ms): ${srv.probe.toolCount} tools, ~${srv.probe.estimatedSchemaTokens} tokens`
          );
        } else {
          if (!srv.disabled) hasErrors = true;
          console.log(`    PROBE FAIL (${srv.probe.latencyMs}ms): ${srv.probe.error}`);
        }
      }
    }
  }
  if (hasErrors) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs };
