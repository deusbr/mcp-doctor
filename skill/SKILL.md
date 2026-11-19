---
name: mcp-doctor
description: Audit MCP client configurations across Claude Desktop, Claude Code, Cursor, and Codex for broken paths, Windows cmd wrappers, hardcoded secrets, live stdio handshake failures, and tool-schema token bloat.
---

# MCP Doctor Skill

Use this skill when debugging failing Model Context Protocol (MCP) servers, Windows spawn errors, or excessive context token usage from MCP tool schemas.

## Workflow

1. Run a static audit across known clients without executing servers first:
   ```bash
   node bin/mcp-doctor.cjs --json
   ```
2. Inspect a specific config file when debugging a single project:
   ```bash
   node bin/mcp-doctor.cjs --file /abs/path/to/config.json --json
   ```
3. Probe live `stdio` handshakes (`initialize` + `tools/list`) and measure estimated schema token overhead:
   ```bash
   node bin/mcp-doctor.cjs --probe --timeout 4000
   ```
4. Apply fixes safely:
   - Replace bare `npx` / `npm` commands on Windows with `cmd` + `["/c", "npx", ...]`.
   - Move plaintext API keys out of config files into environment references or secure vaults.
   - Prune or split high-token MCP servers when `estimatedSchemaTokens` inflates startup context.