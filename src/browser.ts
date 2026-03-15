import { join } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";

const SCREENSHOTS_DIR = join(process.cwd(), ".claude", "claudeclaw", "inbox", "browser");
const USER_DATA_DIR_DEFAULT = join(process.cwd(), ".claude", "claudeclaw", "browser-profile");

const DEFAULT_TIMEOUT = 30_000;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes idle before auto-close

const CHROME_PATHS = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export interface BrowserConfig {
  enabled: boolean;
  chromePath: string;
  headless: boolean;
  userDataDir: string;
  defaultViewport: { width: number; height: number };
}

export interface PageResult {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
}

export interface ScreenshotResult {
  path: string;
  filename: string;
}

export interface ExtractResult {
  items: string[];
  count: number;
}

export interface ConsoleResult {
  logs: Array<{ type: string; text: string }>;
  url: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browserInstance: any = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

let currentConfig: BrowserConfig = {
  enabled: true,
  chromePath: "",
  headless: true,
  userDataDir: USER_DATA_DIR_DEFAULT,
  defaultViewport: { width: 1280, height: 800 },
};

export function configureBrowser(config: BrowserConfig): void {
  currentConfig = config;
}

function findChromePath(configPath: string): string {
  if (configPath && existsSync(configPath)) return configPath;
  if (configPath) return configPath; // user-specified, trust them
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "No Chromium/Chrome binary found. Install chromium or set browser.chromePath in settings.json."
  );
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browserInstance) {
      console.log("[browser] Auto-closing idle browser");
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
  }, IDLE_TIMEOUT);
}

async function getBrowser(): Promise<unknown> {
  if (browserInstance) {
    resetIdleTimer();
    return browserInstance;
  }

  const puppeteer = await import("puppeteer-core");
  const executablePath = findChromePath(currentConfig.chromePath);
  const userDataDir = currentConfig.userDataDir || USER_DATA_DIR_DEFAULT;

  await mkdir(userDataDir, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  browserInstance = await puppeteer.launch({
    executablePath,
    headless: currentConfig.headless,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    defaultViewport: currentConfig.defaultViewport,
  });

  browserInstance.on("disconnected", () => {
    browserInstance = null;
    if (idleTimer) clearTimeout(idleTimer);
  });

  resetIdleTimer();
  console.log("[browser] Launched:", executablePath);
  return browserInstance;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await getBrowser() as { newPage(): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = await browser.newPage() as any;
  try {
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    resetIdleTimer();
  }
}

/** Navigate to a URL and return page title, text content, and links. */
export async function browsePage(url: string): Promise<PageResult> {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const title = document.title;
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const el of clone.querySelectorAll("script,style,noscript,svg")) {
        el.remove();
      }
      const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 8000);
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({
          text: ((a as HTMLElement).textContent ?? "").trim().slice(0, 100),
          href: (a as HTMLAnchorElement).href,
        }))
        .filter((l: { href: string }) => l.href.startsWith("http"))
        .slice(0, 50);
      return { title, text, links };
    });

    return { url: page.url(), title: data.title, text: data.text, links: data.links };
  });
}

/** Take a screenshot of a URL. Pass fullPage for full-page capture, selector for element screenshot. */
export async function screenshotPage(
  url: string,
  fullPage = false,
  selector?: string
): Promise<ScreenshotResult> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "networkidle2" });

    const filename = `screenshot-${Date.now()}.png`;
    const filePath = join(SCREENSHOTS_DIR, filename);

    if (selector) {
      const el = await page.$(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      await el.screenshot({ path: filePath });
    } else {
      await page.screenshot({ path: filePath, fullPage });
    }

    return { path: filePath, filename };
  });
}

/** Click an element identified by a CSS selector on the given URL. */
export async function clickElement(
  url: string,
  selector: string
): Promise<{ success: boolean; message: string }> {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT });
    await page.click(selector);
    return { success: true, message: `Clicked "${selector}" on ${url}` };
  });
}

/** Type text into an element on the given URL. */
export async function typeIntoElement(
  url: string,
  selector: string,
  text: string
): Promise<{ success: boolean; message: string }> {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT });
    await page.click(selector);
    await page.type(selector, text);
    return { success: true, message: `Typed into "${selector}" on ${url}` };
  });
}

/** Extract text content from all elements matching selector on the given URL. */
export async function extractContent(url: string, selector: string): Promise<ExtractResult> {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT });
    const items: string[] = await page.$$eval(
      selector,
      (els: Element[]) =>
        els
          .map((el) => (el.textContent ?? "").trim())
          .filter(Boolean)
          .slice(0, 100)
    );
    return { items, count: items.length };
  });
}

/** Capture console messages produced during page load. */
export async function captureConsoleLogs(url: string): Promise<ConsoleResult> {
  return withPage(async (page) => {
    const logs: Array<{ type: string; text: string }> = [];
    page.on("console", (msg: { type(): string; text(): string }) => {
      logs.push({ type: msg.type(), text: msg.text() });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 500));
    return { logs: logs.slice(0, 200), url: page.url() };
  });
}

/** Scroll a page to a position or element. */
export async function scrollPage(
  url: string,
  target: { x?: number; y?: number; selector?: string }
): Promise<{ success: boolean }> {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (target.selector) {
      await page.waitForSelector(target.selector, { timeout: DEFAULT_TIMEOUT });
      await page.$eval(target.selector, (el: Element) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    } else {
      await page.evaluate((x: number, y: number) => window.scrollTo(x, y), target.x ?? 0, target.y ?? 0);
    }
    return { success: true };
  });
}

/** Gracefully close the browser. */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

/** Return whether a browser instance is currently running. */
export function getBrowserStatus(): { running: boolean } {
  return { running: browserInstance !== null };
}
