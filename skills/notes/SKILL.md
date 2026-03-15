---
name: notes
description: >
  Access and manage an Obsidian vault: search notes, create notes, open daily
  notes, read and edit markdown files with frontmatter. Trigger phrases include
  "notes search", "search notes", "find note", "create note", "new note",
  "daily note", "today's note", "open note", "read note", "edit note",
  "/notes search", "/notes create", "/notes today", "/notes list",
  "obsidian", "my vault", "in my notes".
---

# Notes (Obsidian) Integration

Read and write markdown notes in an Obsidian vault on the local filesystem.

## Setup

Obsidian must be configured in `.claude/claudeclaw/settings.json`:
```json
{
  "integrations": {
    "obsidian": {
      "vaultPath": "/path/to/your/vault"
    }
  }
}
```

## Commands

Use `$ARGUMENTS` to determine intent:

### /notes today
Open or create today's daily note.
- Call `createDailyNote(config)` from `src/integrations/obsidian.ts`
- Read the note content and display it
- If created fresh, say so; if existing, show the content
- Default folder: `Daily Notes/`, filename: `YYYY-MM-DD.md`

### /notes search <query>
Search notes by filename and content.
- Call `searchNotes(config, query, { content: true })`
- Display: note title, path, last modified, and content excerpts
- Limit to top 10 results

### /notes create <title> [content]
Create a new note.
- Determine the filename: `<title>.md` (sanitize special chars)
- If content provided, use it; otherwise create a minimal template with `# <title>`
- Call `writeNote(config, path, content)`
- Confirm creation with the vault-relative path

### /notes read <path-or-title>
Read a note by path or title.
- Try exact path first, then search by title with `searchNotes`
- Display the full note content
- Show frontmatter metadata if present

### /notes edit <path-or-title> <new-content>
Overwrite a note with new content.
- Resolve the note path
- Call `writeNote(config, path, content)`
- Confirm the edit

### /notes list [folder]
List notes in a folder (default: vault root).
- Call `listNotes(config, folder)`
- Display: title, path, last modified, tags

### /notes tag <tag> [search]
Search notes by tag.
- Call `searchNotes(config, search ?? "", { tags: [tag] })`
- Display results grouped by tag

### /notes frontmatter <path> [key=value ...]
Read or update frontmatter.
- If no key=value args: display the current frontmatter of the note
- If key=value args: call `updateFrontmatter(config, path, patch)` and confirm

## Notes
- Always load config from settings: `getSettings().integrations?.obsidian`
- Skip gracefully if obsidian config is missing: inform user to configure it
- Wiki-links `[[Note Name]]` can be resolved with `resolveWikiLink(config, name)`
- Daily note folder and format can be customized in the future
