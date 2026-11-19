# mcp-doctor

[![CI](https://github.com/deusbr/mcp-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/deusbr/mcp-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](package.json)

Zero-dependency CLI, library, and portable AI Skill (`SKILL.md`) to audit **Model Context Protocol (MCP)** configurations across **Claude Desktop**, **Claude Code**, **Cursor**, and **Codex**.

## Why?

Setting up MCP servers frequently breaks due to malformed configs, Windows `npx` wrapper omissions (`cmd /c`), missing binary paths, accidental hardcoded secrets, and silent token bloat from oversized `tools/list` schemas. `mcp-doctor` catches those issues before your AI session starts.

## Features

- **Multi-Client Config Discovery:** Inspects Claude Desktop, Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and Codex (`config.toml`), or any custom `--file`.
- **Windows & Path Diagnostics:** Flags bare `npx`/`npm`/`pnpm` invocations on Windows and missing absolute paths in `command` or `args`.
- **Secret Hygiene Checks:** Detects common hardcoded token patterns (`sk-...`, `ghp_...`, `xoxb-...`, `AKIA...`) in `env` blocks.
- **Live Stdio Handshake Probe (`--probe`):** Executes `initialize` + `tools/list` over JSON-RPC 2.0 with a strict timeout and estimates **schema token overhead**.
- **Portable Skill:** Includes [`skill/SKILL.md`](skill/SKILL.md) for Claude Code and OpenBot agents.

## Quick Start

```bash
node bin/mcp-doctor.cjs
node bin/mcp-doctor.cjs --probe --json
node bin/mcp-doctor.cjs --file /path/to/claude_desktop_config.json --probe
```

## License

MIT — see [`LICENSE`](LICENSE).