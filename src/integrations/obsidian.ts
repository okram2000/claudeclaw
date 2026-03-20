/**
 * Obsidian vault integration — pure filesystem access on .md files.
 * No Obsidian process or plugin required; reads/writes the vault directory directly.
 */

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname, extname, basename } from "node:path";

export interface ObsidianConfig {
  vaultPath: string;
}

export interface NoteInfo {
  /** Path relative to vault root */
  path: string;
  /** Absolute filesystem path */
  fullPath: string;
  title: string;
  lastModified: Date;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

export interface SearchResult {
  note: NoteInfo;
  /** Matching line excerpts (content search only) */
  excerpts: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter from markdown content. Returns {} if none found. */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return parseYamlSimple(match[1]);
}

/** Serialize frontmatter object + remaining body into markdown. */
export function setFrontmatter(
  content: string,
  data: Record<string, unknown>
): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const fm = serializeYamlSimple(data);
  return `---\n${fm}---\n${body}`;
}

/**
 * Minimal YAML parser — handles flat key: value and key: [list] forms.
 * Good enough for typical Obsidian frontmatter; does not handle nested maps.
 */
function parseYamlSimple(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const kvMatch = line.match(/^(\w[\w\s-]*?):\s*(.*)/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1].trim();
    const rest = kvMatch[2].trim();

    if (rest === "" || rest === "|" || rest === ">") {
      // multi-line value — skip for now
      i++;
      continue;
    }

    if (rest.startsWith("[")) {
      // inline array
      const inner = rest.slice(1, rest.lastIndexOf("]"));
      result[key] = inner
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      i++;
      continue;
    }

    if (rest === "") {
      // check if next lines are list items
      const items: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].trimStart().startsWith("- ")) {
        i++;
        items.push(lines[i].replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
      }
      if (items.length > 0) { result[key] = items; i++; continue; }
    }

    result[key] = rest.replace(/^["']|["']$/g, "");
    i++;
  }

  return result;
}

function serializeYamlSimple(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else {
      const str = String(value);
      const needsQuotes = /[:#\[\]{},&*?|<>=!%@`]/.test(str) || str.includes("\n");
      lines.push(`${key}: ${needsQuotes ? `"${str.replace(/"/g, '\\"')}"` : str}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Note resolution
// ---------------------------------------------------------------------------

function noteTitle(filePath: string, frontmatter: Record<string, unknown>): string {
  if (typeof frontmatter.title === "string" && frontmatter.title) {
    return frontmatter.title;
  }
  return basename(filePath, extname(filePath));
}

function extractTags(frontmatter: Record<string, unknown>, content: string): string[] {
  const fmTags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : typeof frontmatter.tags === "string"
    ? [frontmatter.tags]
    : [];

  const inlineTags = [...content.matchAll(/#([\w/-]+)/g)].map((m) => m[1]);

  return [...new Set([...fmTags, ...inlineTags])];
}

async function noteInfo(fullPath: string, vaultPath: string): Promise<NoteInfo> {
  const content = await readFile(fullPath, "utf8");
  const frontmatter = parseFrontmatter(content);
  const stats = await stat(fullPath);
  const relPath = relative(vaultPath, fullPath);

  return {
    path: relPath,
    fullPath,
    title: noteTitle(relPath, frontmatter),
    lastModified: stats.mtime,
    tags: extractTags(frontmatter, content),
    frontmatter,
  };
}

async function collectMarkdownFiles(dir: string, files: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    // Skip hidden directories (e.g. .obsidian, .git)
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read the raw content of a note by its vault-relative path. */
export async function readNote(config: ObsidianConfig, notePath: string): Promise<string> {
  const full = join(config.vaultPath, notePath);
  return readFile(full, "utf8");
}

/** Write (create or overwrite) a note. Creates parent directories as needed. */
export async function writeNote(
  config: ObsidianConfig,
  notePath: string,
  content: string
): Promise<void> {
  const full = join(config.vaultPath, notePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

/** Search notes by filename and/or content substring (case-insensitive). */
export async function searchNotes(
  config: ObsidianConfig,
  query: string,
  options: { content?: boolean; tags?: string[] } = {}
): Promise<SearchResult[]> {
  const allFiles = await collectMarkdownFiles(config.vaultPath);
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const fullPath of allFiles) {
    let content: string;
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const info = await noteInfo(fullPath, config.vaultPath).catch(() => null);
    if (!info) continue;

    // Tag filter
    if (options.tags && options.tags.length > 0) {
      const noteTags = info.tags.map((t) => t.toLowerCase());
      if (!options.tags.every((t) => noteTags.includes(t.toLowerCase()))) continue;
    }

    const titleMatch = info.title.toLowerCase().includes(q);
    const pathMatch = info.path.toLowerCase().includes(q);
    const excerpts: string[] = [];

    if (options.content !== false) {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 1);
          excerpts.push(lines.slice(start, end + 1).join("\n"));
          if (excerpts.length >= 3) break;
        }
      }
    }

    if (titleMatch || pathMatch || excerpts.length > 0) {
      results.push({ note: info, excerpts });
    }
  }

  // Sort by last modified descending
  results.sort((a, b) => b.note.lastModified.getTime() - a.note.lastModified.getTime());
  return results;
}

/** Get metadata for a specific note. */
export async function getNoteInfo(
  config: ObsidianConfig,
  notePath: string
): Promise<NoteInfo> {
  const full = join(config.vaultPath, notePath);
  return noteInfo(full, config.vaultPath);
}

/** List notes in a folder (non-recursive). */
export async function listNotes(
  config: ObsidianConfig,
  folder = ""
): Promise<NoteInfo[]> {
  const dir = join(config.vaultPath, folder);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const notes: NoteInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const full = join(dir, entry.name);
    const info = await noteInfo(full, config.vaultPath).catch(() => null);
    if (info) notes.push(info);
  }

  notes.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return notes;
}

/** Create or return a daily note for the given date (defaults to today). */
export async function createDailyNote(
  config: ObsidianConfig,
  date: Date = new Date(),
  folder = "Daily Notes",
  template = ""
): Promise<{ path: string; created: boolean }> {
  const dateStr = formatDate(date);
  const notePath = `${folder}/${dateStr}.md`;
  const full = join(config.vaultPath, notePath);

  if (existsSync(full)) {
    return { path: notePath, created: false };
  }

  const defaultContent = template || `# ${dateStr}\n\n`;
  await writeNote(config, notePath, defaultContent);
  return { path: notePath, created: true };
}

/** Resolve a wiki-link `[[Note Name]]` to a vault-relative path, if it exists. */
export async function resolveWikiLink(
  config: ObsidianConfig,
  linkText: string
): Promise<string | null> {
  // Strip alias: [[Note|Alias]] → Note
  const name = linkText.split("|")[0].trim();
  const allFiles = await collectMarkdownFiles(config.vaultPath);

  for (const full of allFiles) {
    const base = basename(full, ".md");
    if (base.toLowerCase() === name.toLowerCase()) {
      return relative(config.vaultPath, full);
    }
  }
  return null;
}

/** Add or replace frontmatter keys in a note. */
export async function updateFrontmatter(
  config: ObsidianConfig,
  notePath: string,
  patch: Record<string, unknown>
): Promise<void> {
  const content = await readNote(config, notePath);
  const existing = parseFrontmatter(content);
  const merged = { ...existing, ...patch };
  const updated = setFrontmatter(content, merged);
  await writeNote(config, notePath, updated);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
