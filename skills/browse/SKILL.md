---
name: browse
description: >
  Browser automation for web pages. Use when asked to browse a URL, take a
  screenshot, visit a website, click an element, type into a form, extract
  content, scrape a page, or capture console logs. Trigger phrases include
  "browse", "screenshot", "visit URL", "take a screenshot", "click on",
  "type into", "extract from page", "scrape", "open browser", "/browse",
  "/screenshot", "/click", "/type", "/extract", "/console".
---

# Browse — Browser Automation

Use `$ARGUMENTS` to determine what the user wants to do with the browser.

## Available Operations

### Browse a page
`/browse <url>`

Navigate to the URL and return: page title, cleaned text content (up to 8 000 chars), and top 50 links.

**Code:** `import { browsePage } from "./src/browser.ts"; const result = await browsePage(url);`

---

### Take a screenshot
`/screenshot <url> [--full] [--selector <css>]`

Captures a screenshot and saves it to `.claude/claudeclaw/inbox/browser/`.
- `--full` → full-page screenshot
- `--selector <css>` → screenshot of a specific element

**Code:** `import { screenshotPage } from "./src/browser.ts"; const { path, filename } = await screenshotPage(url, fullPage, selector);`

---

### Click an element
`/click <url> <css-selector>`

Navigate to the URL and click the first element matching the CSS selector.

**Code:** `import { clickElement } from "./src/browser.ts"; const result = await clickElement(url, selector);`

---

### Type into a form field
`/type <url> <css-selector> <text>`

Navigate to the URL, focus the element, and type the given text into it.

**Code:** `import { typeIntoElement } from "./src/browser.ts"; const result = await typeIntoElement(url, selector, text);`

---

### Extract content
`/extract <url> <css-selector>`

Navigate to the URL and return the text content of all elements matching the CSS selector (up to 100 items).

**Code:** `import { extractContent } from "./src/browser.ts"; const { items, count } = await extractContent(url, selector);`

---

### Capture console logs
`/console <url>`

Load a page and capture all browser console messages (log, warn, error, etc.).

**Code:** `import { captureConsoleLogs } from "./src/browser.ts"; const { logs, url } = await captureConsoleLogs(url);`

---

## Notes

- Browser auto-closes after 5 minutes of inactivity (idle timeout).
- Screenshots are saved to `.claude/claudeclaw/inbox/browser/`.
- Configure in `settings.json` under the `browser` key:
  ```json
  {
    "browser": {
      "enabled": true,
      "chromePath": "",
      "headless": true,
      "userDataDir": ".claude/claudeclaw/browser-profile",
      "defaultViewport": { "width": 1280, "height": 800 }
    }
  }
  ```
- `chromePath`: path to your Chrome/Chromium binary. Leave empty to auto-detect.
- Set `headless: false` to watch the browser while it works.
- All operations have a 30-second timeout.
