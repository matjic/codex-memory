#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const CATEGORIES = ["preferences", "repos", "technical", "people", "workflows", "snippets", "notes"] as const;
type Category = typeof CATEGORIES[number];
type Json = Record<string, unknown>;
type Tool = {
  description: string;
  inputSchema: Json;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  run(input: Json): Promise<string>;
};

function memoryDir(): string {
  const configured = process.env.CODEX_MEMORY_DIR?.trim();
  if (!configured) return join(homedir(), "codex-memory");
  return configured === "~" ? homedir() : configured.startsWith(`~${sep}`) ? join(homedir(), configured.slice(2)) : resolve(configured);
}

function containedPath(root: string, name: string): string {
  if (!name || name.includes("\0") || isAbsolute(name)) throw new Error("Path must be relative");
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes memory directory");
  return path;
}

async function verifiedPath(root: string, name: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(containedPath(root, name))]);
  const rel = relative(realRoot, realFile);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes memory directory");
  return realFile;
}

async function command(argv: string[], options: { cwd?: string; detached?: boolean } = {}) {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: process.env,
    stdout: options.detached ? "ignore" : "pipe",
    stderr: options.detached ? "ignore" : "pipe",
  });
  if (options.detached) return { exitCode: 0, stdout: "", stderr: "" };
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function rag(args: string[], detached = false) {
  return command(["bunx", "-p", "@mathew-cf/rag-cli", "rag", ...args], { detached });
}

async function initializeStore(downloadModel: boolean): Promise<string> {
  const root = memoryDir();
  const lines = [`Memory dir: ${root}`];
  await mkdir(root, { recursive: true });
  if (!existsSync(join(root, ".git"))) {
    const result = await command(["git", "init"], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git init failed");
    lines.push("✓ git repo initialized");
  } else lines.push("✓ git repo already exists");

  const created: string[] = [];
  for (const category of CATEGORIES) {
    const dir = join(root, category);
    if (!existsSync(dir)) created.push(category);
    await mkdir(dir, { recursive: true });
    const marker = join(dir, ".gitkeep");
    if (!existsSync(marker)) await writeFile(marker, "");
  }
  lines.push(created.length ? `✓ created category dirs: ${created.join(", ")}` : "✓ all 7 category dirs already present");

  const config = join(root, "rag.toml");
  if (!existsSync(config)) {
    await writeFile(config, '[[index]]\nname = "memory"\npath = "."\noutput = ".rag"\nexclude = ["rag.toml", ".rag.toml"]\n');
    lines.push("✓ created rag.toml for the memory corpus");
  }
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) await writeFile(ignore, ".rag/\n");

  if (downloadModel) {
    lines.push("", "Downloading embedding model...");
    const result = await rag(["download"]);
    lines.push(result.exitCode === 0 ? result.stdout.trim() || "Model downloaded." : `Model download failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
  const status = await rag(["keyword", "--help"]);
  lines.push("", `rag keyword: ${status.exitCode === 0 ? "available" : "unavailable"}`);
  return lines.join("\n");
}

function parseFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return meta;
}

function terms(query: string): string[] {
  const found = query.match(/"([^"]+)"|'([^']+)'|\S+/g) ?? [];
  return [...new Set(found.map((term) => term.replace(/^['"]|['"]$/g, "").toLowerCase()).filter((term) => term.length > 1))].slice(0, 12);
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  for await (const file of new Bun.Glob("**/*.md").scan({ cwd: root, dot: false })) files.push(file);
  return files;
}

async function memorySearch(input: Json): Promise<string> {
  const query = String(input.query ?? "").trim();
  if (!query) return "Provide a search query.";
  const category = input.category === undefined ? undefined : String(input.category);
  if (category && !CATEGORIES.includes(category as Category)) return `Invalid memory category: ${category}`;
  const root = memoryDir();
  if (!existsSync(root)) return `Memory store is not initialized. Call memory_setup first. Expected path: ${root}`;
  const parsed = terms(query);
  const candidates: Array<{ path: string; hits: number; meta: Record<string, string>; preview: string }> = [];
  for (const path of await markdownFiles(root)) {
    if (category && !path.startsWith(`${category}${sep}`) && !path.startsWith(`${category}/`)) continue;
    const content = await readFile(join(root, path), "utf8").catch(() => "");
    const lower = `${path}\n${content}`.toLowerCase();
    const hits = parsed.filter((term) => lower.includes(term)).length;
    if (!hits) continue;
    const first = parsed.map((term) => lower.indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
    candidates.push({ path: path.replaceAll(sep, "/"), hits, meta: parseFrontmatter(content), preview: content.slice(Math.max(0, first - 60), first + 180).replace(/\s+/g, " ").trim() });
  }
  candidates.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
  if (!candidates.length) return `No memories found for: "${query}"`;
  const shown = candidates.slice(0, 5);
  return [`## Results for "${query}"`, "", ...shown.map((item, index) => {
    const summary = item.meta.summary ? ` — ${item.meta.summary}` : "";
    return `${index + 1}. **${item.path}**${summary}\n   Matches: ${item.hits}/${parsed.length}\n   Preview: ${item.preview}`;
  }), "", `Read the top result with memory_read(path=${JSON.stringify(shown[0].path)}).`].join("\n");
}

async function memoryList(input: Json): Promise<string> {
  const category = input.category === undefined ? undefined : String(input.category);
  if (category && !CATEGORIES.includes(category as Category)) return `Invalid memory category: ${category}`;
  const root = memoryDir();
  if (!category) {
    const lines = ["## Memory Categories", ""];
    for (const name of CATEGORIES) lines.push(`- **${name}/** (${(await markdownFiles(join(root, name))).length} files)`);
    return lines.join("\n");
  }
  const files = await markdownFiles(join(root, category));
  if (!files.length) return `No memories in category: ${category}`;
  const lines = [`## ${category}/ (${files.length} files)`, ""];
  for (const file of files.sort()) {
    const meta = parseFrontmatter(await readFile(join(root, category, file), "utf8"));
    lines.push(`- **${category}/${file.replaceAll(sep, "/")}**${meta.summary ? ` — ${meta.summary}` : ""}`);
  }
  return lines.join("\n");
}

function selectHeading(body: string, heading: string): string | undefined {
  const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const lines = body.split("\n");
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match && match[2].replace(/\s+#+$/, "").trim().toLowerCase() === wanted) { start = i; level = match[1].length; break; }
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

async function recordAccess(path: string): Promise<void> {
  const root = memoryDir();
  const file = join(root, ".rag", "access.json");
  await mkdir(join(root, ".rag"), { recursive: true });
  let data: Record<string, { count: number; last_accessed: string }> = {};
  try { data = JSON.parse(await readFile(file, "utf8")); } catch {}
  data[path] = { count: (data[path]?.count ?? 0) + 1, last_accessed: new Date().toISOString().slice(0, 10) };
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

async function memoryRead(input: Json): Promise<string> {
  const path = String(input.path ?? "");
  let file: string;
  try { file = await verifiedPath(memoryDir(), path); } catch { return `Could not read ${path}: path is missing or outside the memory directory`; }
  const content = await readFile(file, "utf8");
  const frontmatter = content.match(/^(---\n[\s\S]*?\n---\n?)/)?.[1] ?? "";
  const body = frontmatter ? content.slice(frontmatter.length) : content;
  const heading = input.heading === undefined ? undefined : String(input.heading);
  const selected = heading ? selectHeading(body, heading) : body;
  if (selected === undefined) return `Heading not found in ${path}: ${heading}`;
  const offset = Math.max(0, Math.trunc(Number(input.offset ?? 0)) || 0);
  const max = Math.max(1, Math.min(16_000, Math.trunc(Number(input.max_chars ?? 4_000)) || 4_000));
  const excerpt = selected.slice(offset, offset + max);
  await recordAccess(path);
  const next = offset + excerpt.length;
  return `${offset === 0 ? frontmatter : ""}${excerpt}\n\n---\n[memory_read: path=${JSON.stringify(path)}; offset=${offset}; truncated=${next < selected.length}${next < selected.length ? `; next_char=${next}` : ""}]`;
}

async function memoryAccess(input: Json): Promise<string> {
  const path = String(input.path ?? "");
  try { await verifiedPath(memoryDir(), path); await recordAccess(path); return `Recorded access for ${path}`; }
  catch { return `Could not update ${path}`; }
}

async function memorySave(): Promise<string> {
  const root = memoryDir();
  if (!existsSync(join(root, ".git"))) return "Memory store is not initialized. Call memory_setup first.";
  await command(["git", "add", "-A"], { cwd: root });
  const diff = await command(["git", "diff", "--name-only", "--cached"], { cwd: root });
  const changed = diff.stdout.trim().split("\n").filter(Boolean);
  if (!changed.length) return "No changes to sync";
  const commit = await command(["git", "commit", "-m", `memory: sync ${changed.join(", ")}`], { cwd: root });
  if (commit.exitCode !== 0) return `Could not commit memory changes: ${commit.stderr.trim() || commit.stdout.trim()}`;
  void rag(["index", "--config", join(root, "rag.toml"), "--only", "memory"], true);
  return `Synced: ${changed.join(", ")}`;
}

type KnowledgeBase = { name: string; path: string; default?: boolean };

function expandPath(path: string, base?: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith(`~${sep}`) ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base ?? process.cwd(), expanded);
}

async function knowledgeConfig(): Promise<{ path: string; bases: KnowledgeBase[] }> {
  const path = expandPath(process.env.CODEX_MEMORY_CONFIG?.trim() || join(homedir(), ".config", "codex-memory", "config.toml"));
  if (!existsSync(path)) return { path, bases: [] };
  const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as { knowledge_base?: unknown };
  const rows = Array.isArray(parsed.knowledge_base) ? parsed.knowledge_base : [];
  const bases = rows.map((row) => row as Partial<KnowledgeBase>).filter((row) => typeof row.name === "string" && typeof row.path === "string").map((row) => ({
    name: row.name!, path: expandPath(row.path!, dirname(path)), default: row.default === true,
  }));
  if (new Set(bases.map((base) => base.name)).size !== bases.length) throw new Error("Knowledge base names must be unique");
  if (bases.filter((base) => base.default).length > 1) throw new Error("Only one knowledge base may be the default");
  return { path, bases };
}

function selectKnowledgeBases(bases: KnowledgeBase[], name?: string, all?: boolean): KnowledgeBase[] {
  if (name && all) throw new Error("Use either base or all, not both");
  if (!bases.length) return [];
  if (all) return bases;
  if (name) {
    const found = bases.find((base) => base.name === name);
    if (!found) throw new Error(`Unknown knowledge base: ${name}. Available: ${bases.map((base) => base.name).join(", ")}`);
    return [found];
  }
  const selected = bases.find((base) => base.default) ?? (bases.length === 1 ? bases[0] : undefined);
  if (!selected) throw new Error(`Multiple knowledge bases are configured. Choose base (${bases.map((base) => base.name).join(", ")}) or all=true`);
  return [selected];
}

function ragJson(output: string): Json[] {
  const text = output.trimStart();
  if (!text.startsWith("[")) return [];
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) {
      try { const value = JSON.parse(text.slice(0, index + 1)); return Array.isArray(value) ? value : []; }
      catch { return []; }
    }
  }
  return [];
}

async function knowledgeList(): Promise<string> {
  const config = await knowledgeConfig();
  if (!config.bases.length) return `No knowledge bases configured. Add [[knowledge_base]] entries to ${config.path}`;
  return config.bases.map((base) => `${base.name}${base.default || config.bases.length === 1 ? " (default)" : ""}: ${base.path}${existsSync(join(base.path, "rag.toml")) || existsSync(join(base.path, ".rag.toml")) ? "" : " (rag.toml missing)"}`).join("\n");
}

async function knowledgeSearch(input: Json): Promise<string> {
  const query = String(input.query ?? "").trim();
  if (!query) return "Provide a knowledge search query.";
  const config = await knowledgeConfig();
  const selected = selectKnowledgeBases(config.bases, input.base === undefined ? undefined : String(input.base), input.all === true);
  if (!selected.length) return `No knowledge bases configured. Add [[knowledge_base]] entries to ${config.path}`;
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(input.limit ?? 5)) || 5));
  const sections: string[] = [];
  for (const base of selected) {
    const ragConfig = [join(base.path, "rag.toml"), join(base.path, ".rag.toml")].find(existsSync);
    if (!ragConfig) { sections.push(`## ${base.name}\nMissing rag.toml in ${base.path}`); continue; }
    const result = await rag(["search", query, "--config", ragConfig, "--group-by-source", "--json", "-k", String(limit)]);
    if (result.exitCode !== 0) { sections.push(`## ${base.name}\nSearch failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`); continue; }
    const hits = ragJson(result.stdout).filter((hit) => typeof hit.index_name === "string" && typeof hit.source === "string").slice(0, limit);
    if (!hits.length) { sections.push(`## ${base.name}\nNo matches.`); continue; }
    sections.push(`## ${base.name}\n` + hits.map((hit, index) => `${index + 1}. index=${hit.index_name} source=${hit.source}${typeof hit.score === "number" ? ` score=${hit.score.toFixed(3)}` : ""}\n   ${String(hit.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n"));
  }
  return sections.join("\n\n");
}

async function knowledgeRead(input: Json): Promise<string> {
  const config = await knowledgeConfig();
  const base = selectKnowledgeBases(config.bases, input.base === undefined ? undefined : String(input.base), false)[0];
  if (!base) return `No knowledge bases configured. Add [[knowledge_base]] entries to ${config.path}`;
  const indexName = String(input.index ?? "");
  const source = String(input.source ?? "");
  const ragConfig = [join(base.path, "rag.toml"), join(base.path, ".rag.toml")].find(existsSync);
  if (!ragConfig) return `Missing rag.toml in ${base.path}`;
  const parsed = Bun.TOML.parse(await readFile(ragConfig, "utf8")) as { index?: unknown };
  const indexes = Array.isArray(parsed.index) ? parsed.index as Array<{ name?: unknown; path?: unknown }> : [];
  const selected = indexes.find((entry) => entry.name === indexName && typeof entry.path === "string") as { name?: unknown; path: string; output?: unknown } | undefined;
  if (!selected) return `Unknown index ${indexName} in knowledge base ${base.name}`;
  const root = expandPath(selected.path, dirname(ragConfig));
  const output = selected.output === undefined
    ? join(base.path, ".rag", indexName)
    : typeof selected.output === "string"
      ? expandPath(selected.output, dirname(ragConfig))
      : undefined;
  if (!output) return `Invalid output for index ${indexName}`;
  let metadata: { file_hashes?: Record<string, unknown>; source_root_from_index?: string };
  try { metadata = JSON.parse(await readFile(join(output, "meta.json"), "utf8")); }
  catch { return `Could not read index metadata for ${base.name}/${indexName}`; }
  const normalizedSource = source.replaceAll("\\", "/");
  if (!metadata.file_hashes || !Object.prototype.hasOwnProperty.call(metadata.file_hashes, normalizedSource)) {
    return `Source is not indexed in ${base.name}/${indexName}: ${source}`;
  }
  if (typeof metadata.source_root_from_index !== "string") return `Index ${indexName} has no source root`;
  const [configuredRoot, indexedRoot] = await Promise.all([realpath(root), realpath(resolve(output, metadata.source_root_from_index))]).catch(() => [] as unknown as [string, string]);
  if (!configuredRoot || configuredRoot !== indexedRoot) return `Index ${indexName} was built from a different source directory`;
  let file: string;
  try { file = await verifiedPath(root, source); } catch { return `Could not read ${base.name}/${indexName}/${source}: source is missing or outside its index root`; }
  const content = await readFile(file, "utf8");
  const offset = Math.max(0, Math.trunc(Number(input.offset ?? 0)) || 0);
  const max = Math.max(1, Math.min(16_000, Math.trunc(Number(input.max_chars ?? 4_000)) || 4_000));
  const excerpt = content.slice(offset, offset + max);
  const next = offset + excerpt.length;
  return `${excerpt}\n\n---\n[knowledge_base_read: base=${JSON.stringify(base.name)}; index=${JSON.stringify(indexName)}; source=${JSON.stringify(source)}; offset=${offset}; truncated=${next < content.length}${next < content.length ? `; next_char=${next}` : ""}]`;
}

class CodexClient {
  private child = spawn(process.env.CODEX_CLI || "codex", ["app-server", "--stdio"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private id = 1;
  constructor() {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: Json; try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    });
  }
  request(method: string, params: Json): Promise<unknown> {
    const id = this.id++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    return promise;
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

async function codexSessionSearch(input: Json): Promise<string> {
  const query = String(input.query ?? "").trim();
  if (!query) return "Provide a session search query.";
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit ?? 10)) || 10));
  const directory = input.directory === undefined ? undefined : String(input.directory);
  const client = new CodexClient();
  try {
    await client.request("initialize", { clientInfo: { name: "codex-memory", title: "Codex Memory", version: "0.1.1" }, capabilities: { experimentalApi: true } });
    const hits = new Map<string, { thread: Json; snippet: string; terms: Set<string>; archived: boolean }>();
    for (const term of terms(query).slice(0, 8)) for (const archived of [false, true]) {
      const response = await client.request("thread/search", { searchTerm: term, limit: 100, sortKey: "updated_at", sortDirection: "desc", archived }) as { data?: Array<{ thread: Json; snippet?: string }> };
      for (const row of response.data ?? []) {
        const id = String(row.thread.id ?? ""); if (!id) continue;
        if (directory && !String(row.thread.cwd ?? "").includes(directory)) continue;
        const existing = hits.get(id);
        if (existing) existing.terms.add(term);
        else hits.set(id, { thread: row.thread, snippet: row.snippet ?? "", terms: new Set([term]), archived });
      }
    }
    const shown = [...hits.values()].sort((a, b) => b.terms.size - a.terms.size || Number(b.thread.updatedAt ?? 0) - Number(a.thread.updatedAt ?? 0)).slice(0, limit);
    if (!shown.length) return `No Codex sessions found matching "${query}".`;
    return shown.map((hit, index) => `${index + 1}. **${String(hit.thread.name ?? hit.thread.preview ?? "Untitled Codex session").replace(/\s+/g, " ").slice(0, 100)}**${hit.archived ? " [archived]" : ""}\n   id: ${hit.thread.id}\n   dir: ${hit.thread.cwd ?? "unknown"}\n   snippet: ${hit.snippet.replace(/\s+/g, " ").slice(0, 240)}`).join("\n\n");
  } finally { client.close(); }
}

const objectSchema = (properties: Json, required: string[] = []): Json => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const tools: Record<string, Tool> = {
  memory_search: { description: "Search durable local memories by keyword. Use before starting work that may have relevant saved context.", inputSchema: objectSchema({ query: { type: "string" }, category: { type: "string", enum: CATEGORIES } }, ["query"]), annotations: readOnly, run: memorySearch },
  memory_read: { description: "Read a bounded portion of one memory file and record its use.", inputSchema: objectSchema({ path: { type: "string" }, heading: { type: "string" }, offset: { type: "number" }, max_chars: { type: "number" } }, ["path"]), annotations: mutating, run: memoryRead },
  memory_list: { description: "List memory categories or the files in one category.", inputSchema: objectSchema({ category: { type: "string", enum: CATEGORIES } }), annotations: readOnly, run: memoryList },
  memory_access: { description: "Record that an existing memory file was useful.", inputSchema: objectSchema({ path: { type: "string" } }, ["path"]), annotations: mutating, run: memoryAccess },
  memory_save: { description: "Commit pending memory changes and start a local search-index update.", inputSchema: objectSchema({}), annotations: mutating, run: async () => memorySave() },
  memory_setup: { description: "Initialize ~/codex-memory with Git, category folders, search configuration, and optionally the embedding model. Safe to repeat.", inputSchema: objectSchema({ download_model: { type: "boolean", description: "Download the embedding model (default true)" } }), annotations: { ...mutating, openWorldHint: true }, run: async (input) => initializeStore(input.download_model !== false) },
  knowledge_list: { description: "List configured read-only knowledge bases and identify the default.", inputSchema: objectSchema({}), annotations: readOnly, run: async () => knowledgeList() },
  knowledge_base_search: { description: "Search one or all configured read-only knowledge bases using each base's rag.toml.", inputSchema: objectSchema({ query: { type: "string" }, base: { type: "string" }, all: { type: "boolean" }, limit: { type: "number" } }, ["query"]), annotations: readOnly, run: knowledgeSearch },
  knowledge_base_read: { description: "Read a bounded portion of a knowledge search result. Pass base, index, and source from knowledge_base_search.", inputSchema: objectSchema({ base: { type: "string" }, index: { type: "string" }, source: { type: "string" }, offset: { type: "number" }, max_chars: { type: "number" } }, ["index", "source"]), annotations: readOnly, run: knowledgeRead },
  codex_session_search: { description: "Search previous Codex sessions by keyword and return IDs, directories, and snippets.", inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" }, directory: { type: "string" } }, ["query"]), annotations: readOnly, run: codexSessionSearch },
};

async function handle(request: Json) {
  const id = request.id ?? null;
  if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-memory", version: "0.1.1" } } };
  if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })) } };
  if (request.method === "tools/call") {
    const params = request.params as Json | undefined;
    const tool = params && typeof params.name === "string" ? tools[params.name] : undefined;
    if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
    try { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: await tool.run((params.arguments as Json) ?? {}) }] } }; }
    catch (error) { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error) }], isError: true } }; }
  }
  if (request.id === undefined) return undefined;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let request: Json;
  try { request = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
  void handle(request).then((response) => { if (response) process.stdout.write(JSON.stringify(response) + "\n"); });
});
