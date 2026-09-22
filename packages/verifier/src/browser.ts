import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { LayoutContract } from "@boxspec/shared/contracts";
import { resolveInside, sha256Bytes } from "./hash.js";
import type {
  EvidenceArtifact,
  InteractionScenario,
  NodeMeasurement,
  RenderMeasurement,
  Violation,
} from "./types.js";

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface BrowserEvidenceWriter {
  screenshot(page: Page, viewportId: string, fixtureId: string): Promise<EvidenceArtifact>;
  json(kind: "metrics" | "interaction-log", name: string, value: unknown, viewportId?: string, fixtureId?: string): Promise<EvidenceArtifact>;
}

export interface BrowserRunResult {
  readonly measurements: readonly RenderMeasurement[];
  readonly violations: readonly Violation[];
  readonly artifacts: readonly EvidenceArtifact[];
  readonly interactionPassed: boolean;
  readonly interactionMessage: string;
}

interface RenderViewport {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

function renderViewports(contract: LayoutContract): RenderViewport[] {
  const declared = contract.verification.viewports.map((viewport) => ({ ...viewport }));
  if (!contract.verification.boundaryTests) return declared;
  const fallback = declared[0] ?? { id: "default", width: 1280, height: 720, deviceScaleFactor: 1 };
  const boundary: RenderViewport[] = [];
  for (const breakpoint of contract.breakpoints) {
    if (breakpoint.minWidth <= 0) continue;
    for (const width of [breakpoint.minWidth - 1, breakpoint.minWidth, breakpoint.minWidth + 1]) {
      if (width < 160 || boundary.some((item) => item.width === width)) continue;
      boundary.push({ id: `boundary-${width}`, width, height: fallback.height, deviceScaleFactor: fallback.deviceScaleFactor });
    }
  }
  return [...declared, ...boundary];
}

async function startStaticServer(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      let relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      let filePath = resolveInside(root, relativePath);
      try {
        if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, "index.html");
      } catch {
        relativePath = "index.html";
        filePath = resolveInside(root, relativePath);
      }
      const bytes = await readFile(filePath);
      response.writeHead(200, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Static server did not allocate a TCP port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function breakpointFor(contract: LayoutContract, width: number): string | null {
  return contract.breakpoints.find((item) => width >= item.minWidth && (item.maxWidthExclusive === null || width < item.maxWidthExclusive))?.id ?? null;
}

async function prepareContext(
  browser: Browser,
  origin: string,
  viewport: { width: number; height: number; deviceScaleFactor: number },
  fixture: unknown,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  await context.addInitScript((value) => {
    Object.defineProperty(window, "__BOXSPEC_FIXTURE__", { value, configurable: false, writable: false });
    Date.now = () => 1_700_000_000_000;
    Math.random = () => 0.5;
  }, fixture);
  await context.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === origin && (target.protocol === "http:" || target.protocol === "https:")) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await context.grantPermissions([], { origin });
  return context;
}

async function securePage(page: Page, violations: Violation[]): Promise<void> {
  page.on("dialog", (dialog) => void dialog.dismiss());
  page.on("download", (download) => {
    violations.push({
      id: `browser:download:${violations.length}`,
      checkId: "layout",
      kind: "browser-download",
      severity: "error",
      blocking: true,
      message: `Candidate attempted a download: ${download.suggestedFilename()}`,
    });
    void download.cancel();
  });
  page.on("popup", (popup) => {
    violations.push({
      id: `browser:popup:${violations.length}`,
      checkId: "layout",
      kind: "browser-popup",
      severity: "error",
      blocking: true,
      message: `Candidate attempted to open a popup: ${popup.url()}`,
    });
    void popup.close();
  });
}

async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}",
  });
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
    for (const image of Array.from(document.images)) {
      if (!image.complete) await new Promise<void>((resolveImage) => image.addEventListener("load", () => resolveImage(), { once: true }));
    }
    window.scrollTo(0, 0);
  });
}

async function measure(page: Page, nodeIds: readonly string[]): Promise<Record<string, NodeMeasurement>> {
  return page.evaluate((ids) => {
    const output: Record<string, NodeMeasurement> = {};
    for (const id of ids) {
      const selector = `[data-boxspec-node="${CSS.escape(id)}"]`;
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      const centerX = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const centerY = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = visible ? document.elementFromPoint(centerX, centerY) : null;
      output[id] = {
        left: rect.left + scrollX,
        top: rect.top + scrollY,
        right: rect.right + scrollX,
        bottom: rect.bottom + scrollY,
        width: rect.width,
        height: rect.height,
        visible,
        overflowX: element.scrollWidth - element.clientWidth > 0.5,
        overflowY: element.scrollHeight - element.clientHeight > 0.5,
        scrollX,
        scrollY,
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label"),
        hitTarget: hit !== null && (hit === element || element.contains(hit)),
      };
    }
    return output;
  }, [...nodeIds]);
}

async function executeScenario(page: Page, scenario: InteractionScenario): Promise<readonly string[]> {
  const log: string[] = [];
  for (const step of scenario.steps) {
    const locator = page.locator(step.selector);
    switch (step.action) {
      case "click":
        await locator.click({ timeout: 5_000 });
        break;
      case "fill":
        if (step.value === undefined) throw new Error(`Interaction ${scenario.id} fill step has no value`);
        await locator.fill(step.value);
        break;
      case "expect-count": {
        if (step.count === undefined) throw new Error(`Interaction ${scenario.id} count step has no count`);
        const actual = await locator.count();
        if (actual !== step.count) throw new Error(`Expected ${step.count} matches for ${step.selector}, received ${actual}`);
        break;
      }
      case "expect-text": {
        if (step.text === undefined) throw new Error(`Interaction ${scenario.id} text step has no text`);
        const actual = await locator.textContent();
        if (!actual?.includes(step.text)) throw new Error(`Expected ${step.selector} to contain ${JSON.stringify(step.text)}`);
        break;
      }
      case "expect-visible":
        if (!(await locator.isVisible())) throw new Error(`Expected ${step.selector} to be visible`);
        break;
    }
    log.push(`${step.action} ${step.selector}: PASS`);
  }
  return log;
}

export async function runBrowserVerification(input: {
  contract: LayoutContract;
  fixtures: Readonly<Record<string, unknown>>;
  outputDirectory: string;
  route: string;
  fixtureQueryParameter: string;
  interactions: readonly InteractionScenario[];
  executablePath?: string;
  executableSha256?: string;
  evidence: BrowserEvidenceWriter;
}): Promise<BrowserRunResult> {
  const artifacts: EvidenceArtifact[] = [];
  const measurements: RenderMeasurement[] = [];
  const violations: Violation[] = [];
  const { server, origin } = await startStaticServer(input.outputDirectory);
  let browser: Browser | undefined;
  try {
    if (input.executablePath) {
      if (!input.executableSha256) throw new Error("An explicit browser executable requires an approved SHA-256 hash");
      const actualBrowserHash = sha256Bytes(await readFile(input.executablePath));
      if (actualBrowserHash !== input.executableSha256) throw new Error("Browser executable hash does not match the approved profile");
    }
    browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}) });
    artifacts.push(
      await input.evidence.json("metrics", "browser-runtime.json", {
        engine: "chromium",
        version: browser.version(),
        headless: true,
        networkControl: "browser-context request interception; not whole-process network isolation",
      }),
    );
    for (const viewport of renderViewports(input.contract)) {
      for (const fixtureId of input.contract.verification.fixtureIds) {
        const fixture = input.fixtures[fixtureId];
        if (fixture === undefined) throw new Error(`Trusted fixture is missing: ${fixtureId}`);
        const context = await prepareContext(browser, origin, viewport, fixture);
        try {
          const page = await context.newPage();
          await securePage(page, violations);
          const url = new URL(input.route, origin);
          url.searchParams.set(input.fixtureQueryParameter, fixtureId);
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await stabilize(page);
          const nodes = await measure(page, input.contract.nodes.map((node) => node.id));
          const result: RenderMeasurement = {
            viewportId: viewport.id,
            breakpointId: breakpointFor(input.contract, viewport.width),
            fixtureId,
            url: `${url.pathname}?${url.searchParams.toString()}`,
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: viewport.deviceScaleFactor,
            nodes,
          };
          measurements.push(result);
          artifacts.push(await input.evidence.json("metrics", `${viewport.id}-${fixtureId}.metrics.json`, result, viewport.id, fixtureId));
          artifacts.push(await input.evidence.screenshot(page, viewport.id, fixtureId));
        } finally {
          await context.close();
        }
      }
    }

    let interactionPassed = true;
    const interactionMessages: string[] = [];
    for (const scenario of input.interactions) {
      const viewport = input.contract.verification.viewports.find((item) => item.id === scenario.viewportId);
      const fixture = input.fixtures[scenario.fixtureId];
      if (!viewport || fixture === undefined) throw new Error(`Interaction ${scenario.id} references an unknown viewport or fixture`);
      const context = await prepareContext(browser, origin, viewport, fixture);
      try {
        const page = await context.newPage();
        await securePage(page, violations);
        const url = new URL(input.route, origin);
        url.searchParams.set(input.fixtureQueryParameter, scenario.fixtureId);
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await stabilize(page);
        try {
          const log = await executeScenario(page, scenario);
          artifacts.push(await input.evidence.json("interaction-log", `${scenario.id}.interaction.json`, { scenarioId: scenario.id, status: "PASS", log }));
          interactionMessages.push(`${scenario.id}: PASS`);
        } catch (error) {
          interactionPassed = false;
          const message = error instanceof Error ? error.message : String(error);
          violations.push({
            id: `interaction:${scenario.id}`,
            checkId: "interactions",
            kind: "interaction",
            severity: "error",
            blocking: true,
            message,
            viewportId: scenario.viewportId,
            fixtureId: scenario.fixtureId,
          });
          artifacts.push(await input.evidence.json("interaction-log", `${scenario.id}.interaction.json`, { scenarioId: scenario.id, status: "FAIL", message }));
          interactionMessages.push(`${scenario.id}: FAIL (${message})`);
        }
      } finally {
        await context.close();
      }
    }
    return {
      measurements,
      violations,
      artifacts,
      interactionPassed,
      interactionMessage: interactionMessages.join("; ") || "No trusted interaction scenarios were supplied",
    };
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}
