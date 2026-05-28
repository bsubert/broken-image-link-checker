# Website Image Crawler

A reusable GitHub Action (and standalone Node.js script) that crawls every page listed in a website's `sitemap.xml` and reports broken or missing images. Built on top of [Playwright](https://playwright.dev/), it catches both HTTP-level failures (404s, 5xx, CORS errors) and DOM-level failures (`<img>` elements that never produced a viewable picture), while correctly handling lazy-loaded images.

## Why this exists

Manually checking image health on a site with hundreds of pages is impractical. This project automates the crawl, runs pages in parallel, and produces a JSON report you can upload as a CI artifact, diff between runs, or hand to content editors.

## Features

- Pulls the full URL list from `sitemap.xml` automatically
- Runs a real Chromium browser per page (catches JS-rendered content, `<picture>`, `srcset`, CSS `background-image`)
- **Network-level detection** — logs any image request returning HTTP 4xx/5xx or failing at the transport layer
- **DOM-level detection** — flags `<img>` elements where `naturalWidth === 0` or `complete === false`
- **Lazy-load aware** — slow-scrolls each page, promotes `loading="lazy"` to `eager`, and swaps `data-src` into `src` for common JS lazy-loaders (LazySizes, BLazy, Unveil, etc.)
- **Concurrency control** via `p-limit`
- **False-positive filtering** — only reports DOM failures the browser actually attempted to load, so lazy images inside closed accordions/tabs don't pollute the report
- Outputs a single JSON report
- Ships as a **composite GitHub Action** for drop-in use in other repos

---

## Use as a GitHub Action (recommended)

### Quick start

In the **consuming repo**:

1. Add your sitemap URL as a repository secret: **Settings → Secrets and variables → Actions → New repository secret**, name `SITEMAP_URL`.
2. Create `.github/workflows/image-check.yml`:

```yaml
name: Image Health Check

on:
  schedule:
    - cron: '0 6 * * 1'   # every Monday 06:00 UTC
  workflow_dispatch:       # allow manual runs

jobs:
  check-images:
    runs-on: ubuntu-latest
    steps:
      - name: Crawl site for broken images
        uses: your-org/website-image-crawler@v1
        with:
          sitemap-url: ${{ secrets.SITEMAP_URL }}

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: broken-images-report
          path: broken-images-report.json
```

That's it. The job will fail if any broken images are found, and the JSON report is always uploaded as an artifact.

### Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `sitemap-url` | ✅ | — | Full URL of the `sitemap.xml` to crawl |
| `concurrency` | ❌ | `5` | Number of pages crawled in parallel |
| `page-timeout-ms` | ❌ | `30000` | Per-page navigation timeout in milliseconds |
| `report-path` | ❌ | `broken-images-report.json` | Path (relative to the workspace) where the JSON report is written |
| `fail-on-issues` | ❌ | `true` | If `'true'`, the step exits with status 1 when any page has issues |

### Action outputs

| Output | Description |
|---|---|
| `report-path` | Path to the generated JSON report (echoes the input) |

### Tuning concurrency

| Value | Use case |
|---|---|
| 2–3 | Shared hosting, modest CI runner |
| 5 | Sensible default |
| 10+ | Beefy runner, your own staging server |

Each Chromium context uses ~50–100 MB of RAM.

### Advanced examples

**Passive report (don't fail the build):**

```yaml
- uses: your-org/website-image-crawler@v1
  with:
    sitemap-url: ${{ secrets.SITEMAP_URL }}
    fail-on-issues: 'false'

- uses: actions/upload-artifact@v4
  with:
    name: image-report
    path: broken-images-report.json
```

**Higher concurrency on staging:**

```yaml
- uses: your-org/website-image-crawler@v1
  with:
    sitemap-url: ${{ secrets.STAGING_SITEMAP_URL }}
    concurrency: '10'
    page-timeout-ms: '60000'
```

**Cache Playwright browser between runs (faster CI):**

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}

- uses: your-org/website-image-crawler@v1
  with:
    sitemap-url: ${{ secrets.SITEMAP_URL }}
```

### Version pinning

| Reference | Behavior |
|---|---|
| `@v1` | Floating major — receives minor/patch updates automatically (recommended) |
| `@v1.2.0` | Exact version — never updates without a code change |
| `@main` | Latest commit on main — **not recommended**, can break without warning |

---

## Use as a standalone script

If you'd rather run the crawler locally or in a non-GitHub CI:

### Requirements

- Node.js 18 or newer
- ~1 GB free RAM at default concurrency

### Installation

```bash
git clone https://github.com/your-org/website-image-crawler.git
cd website-image-crawler
npm install
npx playwright install chromium
```

### Run

All configuration comes from environment variables:

```bash
SITEMAP_URL=https://example.com/sitemap.xml node checkImages.js
```

With overrides:

```bash
SITEMAP_URL=https://example.com/sitemap.xml \
CONCURRENCY=10 \
PAGE_TIMEOUT_MS=60000 \
REPORT_PATH=./reports/images.json \
FAIL_ON_ISSUES=true \
node checkImages.js
```

| Env var | Required | Default |
|---|---|---|
| `SITEMAP_URL` | ✅ | — |
| `CONCURRENCY` | ❌ | `5` |
| `PAGE_TIMEOUT_MS` | ❌ | `30000` |
| `REPORT_PATH` | ❌ | `broken-images-report.json` |
| `FAIL_ON_ISSUES` | ❌ | `false` (script default; the Action defaults to `true`) |

### Local dev with `.env`

For convenience, add `dotenv` and require it at the top of the script:

```bash
npm install --save-dev dotenv
```

Create a `.env` (gitignored!) with your variables, then run `node checkImages.js`.

---

## Understanding the report

`broken-images-report.json` contains an array of objects, one per page with issues:

```json
[
  {
    "page": "https://example.com/about",
    "networkFailures": [
      { "url": "https://example.com/img/team.jpg", "status": 404 }
    ],
    "domFailures": [
      { "src": "https://example.com/img/team.jpg", "alt": "Our team" }
    ],
    "skippedLazy": 0
  }
]
```

| Field | Meaning |
|---|---|
| `page` | URL of the page being checked |
| `networkFailures` | Image HTTP requests that returned >= 400 or errored. Covers `<img>`, CSS backgrounds, srcset, favicons, etc. |
| `domFailures` | `<img>` elements that didn't render a viewable picture **and** were actually requested by the browser (filtered to remove lazy-load false positives) |
| `skippedLazy` | Count of `<img>` elements that looked broken but were never requested — almost always lazy images inside hidden UI (carousels, accordions, modals). Informational only. |
| `error` | If page-level navigation failed (timeout, DNS, etc.), the error message appears here instead |

### Triage guide

- Entry in **both** `networkFailures` and `domFailures` for the same URL → genuine broken image. The status code tells you where to fix it.
- Only in `networkFailures` → likely a CSS background or `<picture>` source. Search your stylesheets/templates for the URL.
- Only in `domFailures` (rare with filtering enabled) → the `<img>` has an empty/malformed `src`, or a data URI failed to decode.

---

## How it works

For each URL in the sitemap, the script:

1. Opens a fresh browser context (isolated cookies/storage).
2. Navigates to the page with `waitUntil: 'networkidle'`.
3. Logs every image request/response via Playwright's `response` and `requestfailed` events.
4. Slow-scrolls top-to-bottom in 300 px steps with a 250 ms pause, then back to the top — gives `IntersectionObserver`-based lazy loaders time to fire.
5. Promotes any remaining `loading="lazy"` images to `eager` and swaps `data-src` → `src`.
6. Waits for every `<img>` to either `load` or `error`.
7. Collects DOM failures and filters them against the set of URLs the browser actually requested.
8. Returns `null` for clean pages or a report object for pages with issues.

A shared `browser` instance is reused across all pages; one `context` per URL provides isolation without the cost of relaunching Chromium.

---

## Limitations

- **Sitemap index files** (`<sitemapindex>` instead of `<urlset>`) are not recursively parsed. Extend `getUrlsFromSitemap` if your site uses one.
- **Infinite-scroll pages** are not handled — the scroller stops at the initial `document.body.scrollHeight`.
- **Carousel/slider images** that only mount on user interaction won't be checked.
- **Authenticated pages** require adding `storageState` or login steps to `newContext`.
- **Private sitemaps** behind auth need a custom fetch header in `getUrlsFromSitemap`.

---

## Contributing

Issues and PRs welcome. For releases:

```bash
git tag v1.x.y
git push origin v1.x.y
# Move the floating major tag so consumers on @v1 get the update
git tag -f v1 && git push -f origin v1
```

## License

MIT
