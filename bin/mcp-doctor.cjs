#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { auditAllClients, auditConfigFile } = require('../lib/audit.cjs');
const { probeStdioServer } = require('../lib/probe.cjs');

function parseArgs(argv) {
  const args = { json: false, probe: false, timeoutMs: 4000, file: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file' && argv[i + 1]) args.file = path.resolve(argv[++i]);
    else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Number(argv[++i]) || 4000;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: mcp-doctor [--file <path>] [--probe] [--timeout <ms>] [--json]');
    process.exit(0);
  }

  const reports = args.file
    ? [{ id: 'custom', name: 'Custom File', ...auditConfigFile(args.file) }]
    : auditAllClients();

  if (args.probe) {
    for (const report of reports) {
      for (const srv of report.servers) {
        if (srv.command && !srv.command.startsWith('http')) {
          srv.probe = await probeStdioServer({
            command: srv.command,
            args: srv.args,
            timeoutMs: args.timeoutMs
          });
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
      console.log(`  - ${srv.name}: ${srv.command}`);
      for (const f of srv.findings) {
        if (f.severity === 'error') hasErrors = true;
        console.log(`    ${f.severity.toUpperCase()} [${f.code}]: ${f.message}`);
      }
      if (srv.probe) {
        if (srv.probe.ok) {
          console.log(`    PROBE OK (${srv.probe.latencyMs}ms): ${srv.probe.toolCount} tools, ~${srv.probe.estimatedSchemaTokens} tokens`);
        } else {
          hasErrors = true;
          console.log(`    PROBE FAIL (${srv.probe.latencyMs}ms): ${srv.probe.error}`);
        }
      }
    }
  }
  if (hasErrors) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});