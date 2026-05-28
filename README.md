# Website Image Crawler

A Node.js script that crawls every page listed in a website's `sitemap.xml` and reports broken or missing images. Built on top of [Playwright](https://playwright.dev/), it catches both HTTP-level failures (404s, 5xx, CORS errors) and DOM-level failures (`<img>` elements that never produced a viewable picture), while correctly handling lazy-loaded images.

## Why this exists

Manually checking image health on a site with hundreds of pages is impractical. This script automates the crawl, runs pages in parallel, and produces a JSON report you can diff in CI or hand to content editors.

## Features

- Pulls the full URL list from `sitemap.xml` automatically
- Runs a real Chromium browser per page (catches JS-rendered content, `<picture>`, `srcset`, CSS `background-image`)
- **Network-level detection** — logs any image request returning HTTP 4xx/5xx or failing at the transport layer
- **DOM-level detection** — flags `<img>` elements where `naturalWidth === 0` or `complete === false`
- **Lazy-load aware** — slow-scrolls each page, promotes `loading="lazy"` to `eager`, and swaps `data-src` into `src` for common JS lazy-loaders (LazySizes, BLazy, Unveil, etc.)
- **Concurrency control** via `p-limit` — tune throughput vs. server load
- **False-positive filtering** — only reports DOM failures the browser actually attempted to load, so lazy images inside closed accordions/tabs don't pollute the report
- Outputs a single `broken-images-report.json` with per-page detail

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`)
- ~1 GB free RAM at default concurrency

## Installation

```bash
npm install --save-dev playwright xml2js p-limit@3
npx playwright install chromium
```

> **Note:** `p-limit@3` is pinned because v4+ is ESM-only and this project uses CommonJS. If you prefer ESM, install the latest `p-limit` and convert the script accordingly.

## Configuration

Open `checkImages.js` and adjust the constants at the top:

| Constant | Default | Description |
|---|---|---|
| `SITEMAP_URL` | `https://example.com/sitemap.xml` | Full URL to your sitemap |
| `CONCURRENCY` | `5` | Number of pages crawled in parallel |
| `PAGE_TIMEOUT_MS` | `30_000` | Per-page navigation timeout |

### Tuning concurrency

| Value | Use case |
|---|---|
| 2–3 | Shared hosting, modest laptop |
| 5 | Sensible default |
| 10+ | Beefy CI runner, own staging server |

Each Chromium context uses ~50–100 MB of RAM.

## Usage

```bash
node checkImages.js
```

You'll see progress every 25 pages:

```
Checking 870 pages with concurrency 5...
  25/870 pages checked
  50/870 pages checked
  ...
Done. 14 pages with issues. See broken-images-report.json
```

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

**How to triage:**

- An entry in **both** `networkFailures` and `domFailures` for the same URL → genuine broken image. The status code tells you where to fix it.
- Only in `networkFailures` → likely a CSS background or `<picture>` source. Search your stylesheets/templates for the URL.
- Only in `domFailures` (rare with filtering enabled) → the `<img>` has an empty/malformed `src`, or a data URI failed to decode.

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

## Limitations

- **Sitemap index files** (`<sitemapindex>` instead of `<urlset>`) are not recursively parsed. Extend `getUrlsFromSitemap` if your site uses one.
- **Infinite-scroll pages** are not handled — the scroller stops at the initial `document.body.scrollHeight`.
- **Carousel/slider images** that only mount on user interaction won't be checked.
- **Authenticated pages** require adding `storageState` or login steps to `newContext`.

## License

MIT
