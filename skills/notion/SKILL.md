---
name: notion
description: >
  Interact with Notion: search pages and databases, create pages, update pages,
  query databases, and append content. Trigger phrases include "notion search",
  "search notion", "create notion page", "add to notion", "update notion",
  "notion database", "query notion", "/notion search", "/notion create",
  "/notion update", "/notion query", "find in notion", "add note to notion".
---

# Notion Integration

Manage Notion pages and databases using the ClaudeClaw Notion integration.

## Setup

Notion must be configured in `.claude/claudeclaw/settings.json`:
```json
{
  "integrations": {
    "notion": {
      "token": "secret_...",
      "defaultDatabase": "database-id-here"
    }
  }
}
```

Get your integration token from https://www.notion.so/my-integrations.
Share databases/pages with the integration inside Notion.

## Commands

Use `$ARGUMENTS` to determine intent:

### /notion search <query>
Search pages and databases by keyword.
- Call `searchPages(config, query)` from `src/integrations/notion.ts`
- Display results as: title, last edited date, URL
- If no results, say so clearly

### /notion create [database|page] <title> [content]
Create a new page.
- If "database" keyword or a database ID is given, create inside a database
- If "page" keyword or a parent page ID is given, create as a child page
- If no parent specified, use `config.defaultDatabase`
- Call `createPage(config, parentId, title, content, isDatabase)`
- Confirm creation with the page URL

### /notion update <page-id-or-url> <property=value>
Update page properties.
- Extract the page ID from the argument (UUID or Notion URL)
- Parse `key=value` pairs from the arguments
- Call `updatePage(config, pageId, properties)`
- Confirm the update

### /notion query [database-id] [filter]
Query a database with filters.
- Parse optional database ID and filter conditions from arguments
- Call `queryDatabase(config, databaseId, filter, limit)`
- Display results in a table: title, key properties, last edited

### /notion append <page-id-or-url> <text>
Append text to an existing page.
- Call `appendText(config, pageId, text)`
- Confirm success

## Notes
- Always load config from settings: `getSettings().integrations?.notion`
- Skip gracefully if notion config is missing: inform user to configure it
- Page IDs can be extracted from Notion URLs: the 32-char hex at the end
- Use `listDatabases(config)` if the user doesn't know their database ID
