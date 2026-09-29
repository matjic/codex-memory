# Codex Memory

A local [Codex plugin](https://developers.openai.com/plugins/build/plugins) for searching and maintaining a markdown memory store across sessions. It packages a skill and an MCP server configuration. The MCP server comes from [`@mathew-cf/opencode-memory`](https://github.com/mathew-cf/opencode-memory), so the Codex and OpenCode integrations share the same search and storage code.

## Tools

- `memory_search`, `memory_read`, `memory_list`, `memory_access`, `memory_save`, `memory_setup`
- `knowledge_list`, `knowledge_base_search`, `knowledge_base_read`
- `codex_session_search`

## Requirements

- [Bun](https://bun.sh/) on `PATH`
- A published `@mathew-cf/opencode-memory` version containing the `codex-memory-mcp` executable. The source is in the upstream repository; the currently published 2.1.0 package does not contain it yet.

Initialize the shared store once with `bunx @mathew-cf/opencode-memory init --skip-skills`. The default location is `~/opencode-memory/`; set `OPENCODE_MEMORY_DIR` to use another directory.

## Install

Add this repository as a Codex marketplace:

```bash
codex plugin marketplace add matjic/codex-memory
```

Then install **Codex Memory** from that marketplace in the Codex app. Start a new session after installation. The plugin launches its MCP server with `bunx` and loads the bundled `codex-memory` skill.

For development before the upstream package is published, build the upstream checkout with `bun run build` and configure a local MCP server command as `bun <absolute-path-to-upstream>/dist/codex-mcp.js`.

## Data

Memory files stay in the local directory. `memory_save` commits changes to that directory's Git repository and starts a local `rag` index update. Knowledge bases are read-only and configured in `~/.config/opencode-memory/config.toml`; see the [upstream documentation](https://github.com/mathew-cf/opencode-memory#knowledge-bases).

## License

Apache-2.0. See [LICENSE](LICENSE).
