/**
 * Notion API client — uses the REST API directly (no SDK).
 * API reference: https://developers.notion.com/reference
 */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionConfig {
  token: string;
  defaultDatabase: string;
}

export interface NotionPage {
  id: string;
  url: string;
  title: string;
  lastEdited: string;
  properties: Record<string, unknown>;
}

export interface NotionBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

export interface NotionDatabase {
  id: string;
  title: string;
  url: string;
}

export interface DatabaseFilter {
  property?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch<T>(
  token: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers: {
      ...headers(token),
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Notion API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

function extractTitle(page: Record<string, unknown>): string {
  const props = (page.properties as Record<string, unknown>) ?? {};
  for (const key of ["title", "Name", "Title"]) {
    const prop = props[key] as Record<string, unknown> | undefined;
    if (!prop) continue;
    const titleArr = prop.title as Array<{ plain_text: string }> | undefined;
    if (Array.isArray(titleArr) && titleArr.length > 0) {
      return titleArr.map((t) => t.plain_text).join("");
    }
  }
  return "(untitled)";
}

function mapPage(raw: Record<string, unknown>): NotionPage {
  return {
    id: raw.id as string,
    url: raw.url as string,
    title: extractTitle(raw),
    lastEdited: raw.last_edited_time as string,
    properties: (raw.properties as Record<string, unknown>) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Search pages and databases by query string. */
export async function searchPages(
  config: NotionConfig,
  query: string,
  limit = 10
): Promise<NotionPage[]> {
  const data = await notionFetch<{ results: Record<string, unknown>[] }>(
    config.token,
    "/search",
    {
      method: "POST",
      body: JSON.stringify({
        query,
        page_size: limit,
        filter: { value: "page", property: "object" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
      }),
    }
  );
  return data.results.map(mapPage);
}

/** Query a Notion database with optional filters. */
export async function queryDatabase(
  config: NotionConfig,
  databaseId?: string,
  filter?: DatabaseFilter,
  limit = 20
): Promise<NotionPage[]> {
  const dbId = databaseId ?? config.defaultDatabase;
  if (!dbId) throw new Error("No database ID provided and no defaultDatabase configured.");

  const body: Record<string, unknown> = { page_size: limit };
  if (filter) body.filter = filter;

  const data = await notionFetch<{ results: Record<string, unknown>[] }>(
    config.token,
    `/databases/${dbId}/query`,
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.results.map(mapPage);
}

/** Create a new page inside a database or parent page. */
export async function createPage(
  config: NotionConfig,
  parentId: string,
  title: string,
  content?: string,
  isDatabase = true
): Promise<NotionPage> {
  const parent = isDatabase
    ? { database_id: parentId }
    : { page_id: parentId };

  const properties: Record<string, unknown> = {
    title: { title: [{ text: { content: title } }] },
  };

  const children: NotionBlock[] = [];
  if (content) {
    // Split content into paragraphs (max 2000 chars each per Notion limits)
    for (const chunk of splitIntoChunks(content, 2000)) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
      });
    }
  }

  const body: Record<string, unknown> = { parent, properties };
  if (children.length > 0) body.children = children;

  const raw = await notionFetch<Record<string, unknown>>(config.token, "/pages", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapPage(raw);
}

/** Update page properties (e.g. title, status fields). */
export async function updatePage(
  config: NotionConfig,
  pageId: string,
  properties: Record<string, unknown>
): Promise<NotionPage> {
  const raw = await notionFetch<Record<string, unknown>>(
    config.token,
    `/pages/${pageId}`,
    { method: "PATCH", body: JSON.stringify({ properties }) }
  );
  return mapPage(raw);
}

/** Append blocks to a page (or any block that can have children). */
export async function appendBlocks(
  config: NotionConfig,
  blockId: string,
  blocks: NotionBlock[]
): Promise<void> {
  await notionFetch(config.token, `/blocks/${blockId}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children: blocks }),
  });
}

/** Append plain text paragraphs to a page. */
export async function appendText(
  config: NotionConfig,
  pageId: string,
  text: string
): Promise<void> {
  const blocks: NotionBlock[] = splitIntoChunks(text, 2000).map((chunk) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
  await appendBlocks(config, pageId, blocks);
}

/** List databases the integration can access. */
export async function listDatabases(config: NotionConfig): Promise<NotionDatabase[]> {
  const data = await notionFetch<{ results: Record<string, unknown>[] }>(
    config.token,
    "/search",
    {
      method: "POST",
      body: JSON.stringify({
        filter: { value: "database", property: "object" },
        page_size: 50,
      }),
    }
  );
  return data.results.map((db) => ({
    id: db.id as string,
    url: db.url as string,
    title: (
      (db.title as Array<{ plain_text: string }> | undefined) ?? []
    )
      .map((t) => t.plain_text)
      .join(""),
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitIntoChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxLen));
    offset += maxLen;
  }
  return chunks;
}

/** Build a rich-text block for headings/bullets/toggles/etc. */
export function richTextBlock(
  type: "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item" | "numbered_list_item" | "quote" | "code",
  text: string,
  language?: string
): NotionBlock {
  const richText = [{ type: "text", text: { content: text } }];
  const block: NotionBlock = { object: "block", type };
  if (type === "code") {
    block[type] = { rich_text: richText, language: language ?? "plain text" };
  } else {
    block[type] = { rich_text: richText };
  }
  return block;
}
