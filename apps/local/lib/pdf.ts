/**
 * HTML → PDF rendering. Produces a real, text-based (selectable) PDF so the
 * parse-safety axis holds — never an image export.
 *
 * On Vercel serverless we use @sparticuz/chromium + puppeteer-core. Locally we
 * fall back to a system Chrome if present. If no browser is available, the caller
 * gets a clear error (PDF is optional to the core flow).
 */
export async function htmlToPdf(html: string, paper: "letter" | "a4" = "letter"): Promise<Buffer> {
  const isServerless = Boolean(
    process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.VERCEL,
  );

  const puppeteer = (await import("puppeteer-core")).default;

  let executablePath: string | undefined;
  // Locally Chrome keeps its sandbox; serverless Chromium sets its own flags.
  let args: string[] = [];

  if (isServerless) {
    const chromium = (await import("@sparticuz/chromium")).default;
    executablePath = await chromium.executablePath();
    args = chromium.args;
  } else {
    executablePath = localChromePath();
  }

  if (!executablePath) {
    throw new Error(
      "No Chrome/Chromium executable found for PDF rendering. Set CHROME_PATH to a local Chrome, or deploy to Vercel where serverless Chromium is bundled.",
    );
  }

  const browser = await puppeteer.launch({
    args,
    executablePath,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    // The HTML carries text from the record and from postings: no scripts, and
    // nothing loaded from the network (inline data only).
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      if (u.startsWith("data:") || u === "about:blank") void req.continue();
      else void req.abort();
    });
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: paper,
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function localChromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    // Any Chromium-based browser renders identically — accept common ones.
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  // Lazy require to avoid bundling fs in edge contexts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}
