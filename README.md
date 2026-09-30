# Codex Memory

A local [Codex plugin](https://developers.openai.com/plugins/build/plugins) for searching and maintaining a markdown memory store across sessions. It packages a skill and a self-contained TypeScript MCP server.

## Tools

- `memory_search`, `memory_read`, `memory_list`, `memory_access`, `memory_save`, `memory_setup`
- `knowledge_list`, `knowledge_base_search`, `knowledge_base_read`
- `codex_session_search`

## Requirements

- [Bun](https://bun.sh/) on `PATH`

Call the plugin's `memory_setup` tool once after installation. It creates `~/codex-memory/` as a Git-backed store, adds the category folders and `rag.toml`, and downloads the embedding model by default. The operation is safe to repeat. Set `CODEX_MEMORY_DIR` in the MCP configuration to use another directory.

## Install

Add this repository as a Codex marketplace:

```bash
codex plugin marketplace add matjic/codex-memory
```

Then install **Codex Memory** from that marketplace in the Codex app. Start a new session after installation. The plugin launches its bundled TypeScript MCP server with Bun and loads the `codex-memory` skill.

## Data

Memory files stay in `~/codex-memory/` by default. `memory_save` commits changes to that directory's Git repository and starts a local `rag` index update.

Optional read-only knowledge bases are configured in `~/.config/codex-memory/config.toml`:

```toml
[[knowledge_base]]
name = "reference"
path = "~/knowledge/reference"
default = true
```

Each knowledge-base directory contains a `rag.toml` with its indexed source definitions. Set `CODEX_MEMORY_CONFIG` to use another configuration file.

## License

Apache-2.0. See [LICENSE](LICENSE).
