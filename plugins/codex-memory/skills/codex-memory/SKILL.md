---
name: codex-memory
description: Search the local memory store and previous Codex sessions for reusable context, then save durable discoveries. Use when starting work in an unfamiliar repo, debugging a recurring issue, or when the user asks to recall or remember something.
---

# Codex Memory

Use the `memory_*`, `knowledge_*`, and `codex_session_search` MCP tools supplied by this plugin.

## Find context

1. Search `memory_search` for the repo, tool, or problem. Read promising hits with `memory_read`; use `heading` for a focused section.
2. Use `codex_session_search` when the user refers to a previous Codex conversation or the memory store lacks context. Session results include IDs and snippets; open a full session with Codex's native session interface when needed.
3. Use `knowledge_list` and `knowledge_base_search` for configured reference collections. Read a result with `knowledge_base_read`, passing its `base`, `index`, and `source` values unchanged.
4. Verify facts that may have changed against their current source.

## Save discoveries

Save a concise markdown file under `~/opencode-memory/` (or `$OPENCODE_MEMORY_DIR`) when a future session would otherwise have to rediscover a durable fact. Prefer updating a related existing file. Useful examples are repo build commands, non-obvious architecture, tool quirks, and debugging root causes. Keep task status and live data out of memory.

Use a category such as `repos/`, `technical/`, or `workflows/`. Include provenance in frontmatter:

```yaml
---
title: Short descriptive title
tags: [relevant, terms]
summary: One sentence that helps search results
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: File path or primary source URL
source_date: YYYY-MM-DD
---
```

Call `memory_save` after editing a memory file. It commits changes in the memory store and starts reindexing. Call `memory_setup` if search backends appear unavailable.
