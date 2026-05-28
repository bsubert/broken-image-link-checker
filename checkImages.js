// checkImages.js
const { chromium } = require("playwright");
const { parseStringPromise } = require("xml2js");
const fs = require("fs");

// ---- Configuration from environment ----
const SITEMAP_URL = process.env.SITEMAP_URL;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5", 10);
const PAGE_TIMEOUT_MS = parseInt(process.env.PAGE_TIMEOUT_MS || "30000", 10);
const REPORT_PATH = process.env.REPORT_PATH || "broken-images-report.json";
const FAIL_ON_ISSUES = process.env.FAIL_ON_ISSUES === "true";

if (!SITEMAP_URL) {
  console.error("Error: SITEMAP_URL env var is required");
  process.exit(1);
}

async function getUrlsFromSitemap(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);
  return parsed.urlset.url.map((u) => u.loc[0]);
}

async function checkPage(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 2000 },
  });
  const page = await context.newPage();
  const networkFailures = [];
  const imageRequests = new Set();

  page.on("response", (resp) => {
    if (resp.request().resourceType() === "image") {
      imageRequests.add(resp.url());
      if (resp.status() >= 400) {
        networkFailures.push({ url: resp.url(), status: resp.status() });
      }
    }
  });
  page.on("requestfailed", (req) => {
    if (req.resourceType() === "image") {
      imageRequests.add(req.url());
      networkFailures.push({ url: req.url(), error: req.failure().errorText });
    }
  });

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: PAGE_TIMEOUT_MS,
    });

    // Slow scroll to trigger IntersectionObserver-based lazy loaders
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
          }
        }, 250);
      });
    });

    // Force-promote any remaining lazy images
    await page.$$eval("img", (imgs) => {
      imgs.forEach((img) => {
        if (img.loading === "lazy") img.loading = "eager";
        if (img.dataset.src && !img.src) img.src = img.dataset.src;
        if (img.dataset.srcset && !img.srcset) img.srcset = img.dataset.srcset;
      });
    });

    // Wait for every image to finish loading or error out
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map(
            (img) =>
              new Promise((resolve) => {
                img.addEventListener("load", resolve, { once: true });
                img.addEventListener("error", resolve, { once: true });
              }),
          ),
      ),
    );

    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});

    const allDomFailures = await page.$$eval("img", (imgs) =>
      imgs
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => ({ src: img.currentSrc || img.src, alt: img.alt })),
    );

    // Only count it as a real failure if the browser actually tried to load it
    const domFailures = allDomFailures.filter(
      (f) => f.src && imageRequests.has(f.src),
    );
    const skippedLazy = allDomFailures.length - domFailures.length;

    return networkFailures.length || domFailures.length
      ? { page: url, networkFailures, domFailures, skippedLazy }
      : null;
  } catch (err) {
    return { page: url, error: err.message };
  } finally {
    await context.close();
  }
}

// ---- GitHub Actions reporting helpers ----
function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function writeGitHubReport(results, totalPages) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const isGitHubActions = !!process.env.GITHUB_ACTIONS;

  if (results.length === 0) {
    const msg = `✅ Image health check passed — ${totalPages} pages, no issues.`;
    if (summaryPath) {
      fs.appendFileSync(summaryPath, `# Image Health Check\n\n${msg}\n`);
    }
    return;
  }

  const totalNetwork = results.reduce((n, r) => n + (r.networkFailures?.length || 0), 0);
  const totalDom     = results.reduce((n, r) => n + (r.domFailures?.length || 0), 0);

  // 1. Markdown summary on the run page
  if (summaryPath) {
    let md = `# ❌ Image Health Check\n\n`;
    md += `**${results.length}** of **${totalPages}** pages have issues — `;
    md += `${totalNetwork} network failure(s), ${totalDom} DOM failure(s).\n\n`;

    for (const r of results) {
      md += `## [${r.page}](${r.page})\n\n`;

      if (r.error) {
        md += `> ⚠️ Page-level error: \`${escapeMd(r.error)}\`\n\n`;
        continue;
      }

      if (r.networkFailures?.length) {
        md += `### Network failures (${r.networkFailures.length})\n\n`;
        md += `| Image URL | Status / Error |\n|---|---|\n`;
        for (const f of r.networkFailures) {
          md += `| ${escapeMd(f.url)} | ${escapeMd(f.status ?? f.error ?? 'unknown')} |\n`;
        }
        md += `\n`;
      }

      if (r.domFailures?.length) {
        md += `### DOM failures (${r.domFailures.length})\n\n`;
        md += `| Image src | Alt text |\n|---|---|\n`;
        for (const f of r.domFailures) {
          md += `| ${escapeMd(f.src || '(empty)')} | ${escapeMd(f.alt || '')} |\n`;
        }
        md += `\n`;
      }
    }

    fs.appendFileSync(summaryPath, md);
  }

  // 2. Annotations (red/yellow callouts on the run page)
  if (isGitHubActions) {
    for (const r of results) {
      if (r.error) {
        console.log(`::error title=Page error::${r.page} — ${r.error}`);
        continue;
      }
      for (const f of r.networkFailures || []) {
        const detail = f.status ? `HTTP ${f.status}` : f.error || 'failed';
        console.log(`::error title=Broken image (${detail})::${r.page} — ${f.url}`);
      }
      for (const f of r.domFailures || []) {
        // skip if already reported as a network failure to avoid duplicates
        const dupe = (r.networkFailures || []).some(n => n.url === f.src);
        if (dupe) continue;
        console.log(`::warning title=DOM image failure::${r.page} — ${f.src || '(empty src)'}`);
      }
    }
  }
}

(async () => {
  const { default: pLimit } = await import('p-limit');

  const urls = await getUrlsFromSitemap(SITEMAP_URL);
  console.log(`Checking ${urls.length} pages with concurrency ${CONCURRENCY}...`);

  const browser = await chromium.launch();
  const limit = pLimit(CONCURRENCY);
  let done = 0;

  const tasks = urls.map(url =>
    limit(async () => {
      const result = await checkPage(browser, url);
      done += 1;
      if (done % 25 === 0 || done === urls.length) {
        console.log(`  ${done}/${urls.length} pages checked`);
      }
      return result;
    })
  );

  const results = (await Promise.all(tasks)).filter(Boolean);

  await browser.close();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));

  writeGitHubReport(results, urls.length);

  console.log(`\nDone. ${results.length} pages with issues. Report: ${REPORT_PATH}`);

  if (FAIL_ON_ISSUES && results.length > 0) {
    console.error(`Failing build: ${results.length} pages have image issues.`);
    process.exit(1);
  }
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});