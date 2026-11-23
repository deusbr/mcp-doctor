# mcp-doctor

[![CI](https://github.com/deusbr/mcp-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/deusbr/mcp-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](package.json)

Zero-dependency CLI, library, and portable AI Skill (`SKILL.md`) to audit **Model Context Protocol (MCP)** configurations across **Claude Desktop**, **Claude Code**, **Cursor**, **Codex**, **Gemini CLI**, **Antigravity**, and **VS Code**.

## Why?

Setting up MCP servers frequently breaks due to malformed configs, Windows `npx`/`npm`/`pnpm`/`yarn` wrapper omissions (`cmd /c`), missing binary paths, accidental hardcoded secrets, unencrypted remote URLs, and silent token bloat from oversized `tools/list` schemas. `mcp-doctor` catches those issues before your AI session starts.

## Features

- **Multi-Client Config Discovery:** Inspects Claude Desktop, Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Codex (`config.toml`, including inline tables and `enabled = false`), Gemini CLI (`~/.gemini/settings.json`), Antigravity (`~/.gemini/antigravity/mcp_config.json`), and VS Code (`mcp.json` `"servers"`), or any custom `--file`.
- **Targeted Filtering (`--client`, `--server`):** Audit or probe only specific clients or server entries without unrelated configs failing CI/checks.
- **Windows, Path & Transport Diagnostics:** Flags bare `npx`/`npm`/`pnpm`/`yarn` invocations on Windows, missing absolute paths in `command` or `args`, and non-loopback `http://` remote URLs (`INSECURE_HTTP_URL`).
- **Secret Hygiene Checks:** Detects hardcoded token patterns (`sk-ant-...`, `sk-...`, `AIza...`, `hf_...`, `ghp_...`, `github_pat_...`, `xoxb-...`, `AKIA...`) in `env` blocks while never printing `env` values in `--json` output.
- **Live Stdio Handshake Probe (`--probe`):** Executes `initialize` + `tools/list` over both newline-delimited JSON-RPC 2.0 and `Content-Length`-framed stdio transports, forwards configured `env` safely, skips `disabled: true` / `enabled = false` entries by default, and flags `SCHEMA_TOKEN_BLOAT` above `--token-budget` (default `5000`).
- **Portable Skill:** Includes [`skill/SKILL.md`](skill/SKILL.md) for Claude Code, Codex, and OpenBot agents.

## Quick Start

```bash
node bin/mcp-doctor.cjs
node bin/mcp-doctor.cjs --client claude-code --probe --json
node bin/mcp-doctor.cjs --probe --token-budget 3000
node bin/mcp-doctor.cjs --file /path/to/claude_desktop_config.json --probe
```

## CLI Options

| Flag | Description |
| :--- | :--- |
| `--file <path>` | Audit a single JSON or TOML MCP config file |
| `--client <id[,id...]>` | Filter clients (`claude-desktop`, `claude-code`, `cursor`, `codex`, `gemini-cli`, `antigravity`, `vscode`) |
| `--server <name[,...]>` | Filter MCP server entries by name |
| `--probe` | Run live stdio `initialize` + `tools/list` handshakes |
| `--timeout <ms>` | Probe timeout per server in ms (default: `4000`) |
| `--token-budget <n>` | Warn on schema bloat above `n` tokens (default: `5000`, `0` to disable) |
| `--include-disabled` | Include disabled servers during `--probe` |
| `--json` | Output machine-readable JSON report (never leaks `env` values) |

## License

MIT — see [`LICENSE`](LICENSE).
