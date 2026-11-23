---
name: mcp-doctor
description: Audit MCP client configurations across Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, Antigravity, and VS Code for broken paths, Windows cmd wrappers, hardcoded secrets, live stdio handshake failures, and tool-schema token bloat.
---

# MCP Doctor Skill

Use this skill when debugging failing Model Context Protocol (MCP) servers, Windows spawn errors, or excessive context token usage from MCP tool schemas.

## Workflow

1. Run a static audit across known clients without executing servers first:
   ```bash
   node bin/mcp-doctor.cjs --json
   ```
2. Target a single client or config file when debugging a specific setup:
   ```bash
   node bin/mcp-doctor.cjs --client claude-code,codex --probe --json
   node bin/mcp-doctor.cjs --file /abs/path/to/config.json --probe
   ```
3. Probe live `stdio` handshakes (`initialize` + `tools/list`, NDJSON or `Content-Length`) and flag schema bloat above a token budget:
   ```bash
   node bin/mcp-doctor.cjs --probe --timeout 4000 --token-budget 5000
   ```
4. Apply fixes safely:
   - Replace bare `npx` / `npm` / `pnpm` / `yarn` commands on Windows with `cmd` + `["/c", "npx", ...]`.
   - Move plaintext API keys out of config files into environment references or secure vaults, and upgrade non-loopback `http://` endpoints to `https://`.
   - Prune or split high-token MCP servers when `SCHEMA_TOKEN_BLOAT` / `estimatedSchemaTokens` inflates startup context.
