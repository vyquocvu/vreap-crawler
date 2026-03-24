/**
 * VREAP Crawler — Facebook Group Post Scraper
 *
 * Scrapes real estate posts from a public Facebook Group using Crawlee's
 * PlaywrightCrawler. Authentication is handled via injected session cookies
 * (no username/password login flow). Posts are identified through semantic
 * ARIA attributes so the scraper is resilient to Facebook's frequently
 * changing CSS class names.
 *
 * Environment variables (see .env.example):
 *   FB_COOKIE_C_USER  – Facebook numeric user ID
 *   FB_COOKIE_XS      – Facebook session token
 *   FB_GROUP_URL      – Full URL of the target Facebook Group
 *   WEBHOOK_URL       – HTTP endpoint that receives the scraped JSON array
 *   COOKIES_FILE      – (optional) Path to a Playwright-format cookies JSON file
 */

import * as fs from 'fs';
import * as path from 'path';

import { PlaywrightCrawler, Dataset, ProxyConfiguration, log } from 'crawlee';
import { Cookie } from 'playwright';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single scraped real-estate post. */
interface PostRecord {
    post_text: string;
    author: string;
    post_url: string;
    scraped_at: string;
}

/** A single proxy entry returned by the Webshare proxy list API. */
interface WebshareProxy {
    username: string;
    password: string;
    proxy_address: string;
    port: number;
    valid: boolean;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Facebook session cookies that will be injected into the browser
 * context before navigating.  Two sources are supported (in priority order):
 *
 *   1. A JSON file at the path given by the `COOKIES_FILE` env var.
 *   2. The `FB_COOKIE_C_USER` + `FB_COOKIE_XS` env vars.
 *
 * Throws if neither source provides usable credentials.
 */
function loadFacebookCookies(): Cookie[] {
    const cookiesFilePath = process.env.COOKIES_FILE;

    if (cookiesFilePath) {
        const resolved = path.resolve(cookiesFilePath);
        log.info(`Loading cookies from file: ${resolved}`);

        if (!fs.existsSync(resolved)) {
            throw new Error(`COOKIES_FILE was set but the file does not exist: ${resolved}`);
        }

        const raw = fs.readFileSync(resolved, 'utf-8');
        const parsed: Cookie[] = JSON.parse(raw);

        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('cookies.json is empty or not a valid JSON array.');
        }

        return parsed;
    }

    const cUser = process.env.FB_COOKIE_C_USER;
    const xs = process.env.FB_COOKIE_XS;

    if (!cUser || !xs) {
        throw new Error(
            'Facebook session cookies are required. ' +
            'Set FB_COOKIE_C_USER and FB_COOKIE_XS in your .env file, ' +
            'or point COOKIES_FILE to a valid cookies JSON file.',
        );
    }

    log.info('Loading cookies from environment variables.');

    // expires: -1 means the cookie persists for the browser session only
    return [
        {
            name: 'c_user',
            value: cUser,
            domain: '.facebook.com',
            path: '/',
            httpOnly: false,
            secure: true,
            sameSite: 'None' as const,
            expires: -1,
        },
        {
            name: 'xs',
            value: xs,
            domain: '.facebook.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None' as const,
            expires: -1,
        },
    ];
}

/**
 * Returns a random integer between `min` and `max` (inclusive).
 * Used to generate human-like wait intervals.
 */
function randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Minimum number of characters a post's text body must have to be considered
// a real listing (shorter content is likely a UI widget or an empty article).
const MIN_POST_TEXT_LENGTH = 20;

// ---------------------------------------------------------------------------
// Anti-detect browser helpers
// ---------------------------------------------------------------------------

/**
 * Chromium command-line flags that remove the most common automation-detection
 * signals (e.g. the AutomationControlled blink feature that sets
 * `navigator.webdriver = true`, the "Chrome is being controlled by…" infobar,
 * and various first-run nags).
 */
const ANTI_DETECT_LAUNCH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
];

/**
 * Common desktop viewport presets.  One is chosen at random per crawl so each
 * run presents a slightly different screen fingerprint.
 */
const VIEWPORT_PRESETS = [
    { width: 1920, height: 1080 },
    { width: 1680, height: 1050 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
];

/**
 * A realistic Chrome on Windows user-agent string.
 * Overriding the default headless-Chrome UA avoids trivial bot-detection
 * heuristics that key on the "HeadlessChrome" token present in the default UA.
 */
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36';

/**
 * Returns a JavaScript snippet that patches the most common browser-fingerprint
 * properties leaked by headless Chromium.  The script is injected via
 * `page.addInitScript()` so it runs in the page context before any other
 * script, including anti-bot libraries.
 *
 * Patches applied:
 *  1. `navigator.webdriver` → `undefined`
 *  2. `navigator.plugins`   → realistic Chrome plugin list
 *  3. `navigator.mimeTypes` → realistic MIME-type list
 *  4. `window.chrome`       → stub object (absent in headless mode)
 *  5. `navigator.languages` → `['en-US', 'en']`
 *  6. `navigator.permissions.query` → realistic Notifications permission
 *  7. `navigator.hardwareConcurrency` → 8
 *  8. `navigator.deviceMemory`        → 8
 *  9. `screen.colorDepth` / `pixelDepth` → 24
 */
function buildStealthInitScript(): string {
    return `
(function () {
    // 1. Hide navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. Restore a realistic plugin list (empty in headless Chromium)
    const fakePlugin = (name, filename, description, mimeTypes) => {
        const plugin = { name, filename, description, length: mimeTypes.length };
        mimeTypes.forEach((m, i) => { plugin[i] = m; });
        plugin.item      = (i) => plugin[i] ?? null;
        plugin.namedItem = (n) => mimeTypes.find((m) => m.type === n) ?? null;
        return plugin;
    };
    const fakeMime = (type, suffixes, description) => ({ type, suffixes, description });
    const pdfMimes = [
        fakeMime('application/pdf', 'pdf', 'Portable Document Format'),
        fakeMime('text/pdf',        'pdf', 'Portable Document Format'),
    ];
    const fakePlugins = [
        fakePlugin('PDF Viewer',        'internal-pdf-viewer',              'Portable Document Format', pdfMimes),
        fakePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '',                         []),
        fakePlugin('Native Client',     'internal-nacl-plugin',             '',                         []),
    ];
    Object.defineProperty(navigator, 'plugins', {
        get: () => Object.assign(fakePlugins, {
            length:      fakePlugins.length,
            item:        (i) => fakePlugins[i] ?? null,
            namedItem:   (n) => fakePlugins.find((p) => p.name === n) ?? null,
            refresh:     () => {},
        }),
    });

    // 3. Realistic MIME types
    Object.defineProperty(navigator, 'mimeTypes', {
        get: () => ({ length: 2, item: () => null, namedItem: () => null }),
    });

    // 4. Inject window.chrome (absent in headless mode)
    if (!window.chrome) {
        window.chrome = {
            runtime:    {},
            loadTimes: function () {},
            csi:       function () {},
            app:        {},
        };
    }

    // 5. Spoof accepted languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // 6. Harden permissions API
    const _origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
        if (params && params.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return _origQuery(params);
    };

    // 7. Realistic hardware concurrency & device memory
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });

    // 8. Realistic screen colour depth
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
})();
`.trim();
}

// ---------------------------------------------------------------------------
// Webshare proxy helpers
// ---------------------------------------------------------------------------

/**
 * Fetches all valid proxies from the Webshare proxy list API and returns them
 * as an array of authenticated proxy URLs in the format:
 *   `http://username:password@host:port`
 *
 * Only proxies flagged as `valid` by Webshare are included.
 * Returns an empty array when no API key is configured so the crawler can
 * fall back to a direct connection.
 *
 * @see https://apidocs.webshare.io/proxy-list/list
 */
async function fetchWebshareProxies(): Promise<string[]> {
    const apiKey = process.env.WEBSHARE_API_KEY;
    if (!apiKey) {
        log.info('WEBSHARE_API_KEY is not set — skipping proxy configuration.');
        return [];
    }

    const proxyUrls: string[] = [];
    let nextUrl: string | null = 'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100';

    while (nextUrl) {
        log.info(`Fetching Webshare proxy list page: ${nextUrl}`);

        const response = await fetch(nextUrl, {
            headers: { Authorization: `Token ${apiKey}` },
        });

        if (!response.ok) {
            throw new Error(
                `Webshare proxy list API returned HTTP ${response.status} ${response.statusText}`,
            );
        }

        const data = await response.json() as {
            count: number;
            next: string | null;
            results: WebshareProxy[];
        };

        for (const proxy of data.results) {
            if (!proxy.valid) continue;
            proxyUrls.push(
                `http://${proxy.username}:${proxy.password}@${proxy.proxy_address}:${proxy.port}`,
            );
        }

        nextUrl = data.next ?? null;
    }

    log.info(`Loaded ${proxyUrls.length} valid ${proxyUrls.length === 1 ? 'proxy' : 'proxies'} from Webshare.`);
    return proxyUrls;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // ── Validate required configuration ────────────────────────────────────
    const groupUrl = process.env.FB_GROUP_URL;
    if (!groupUrl) {
        throw new Error('FB_GROUP_URL is required. Set it in your .env file.');
    }

    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
        throw new Error('WEBHOOK_URL is required. Set it in your .env file.');
    }

    const cookies = loadFacebookCookies();

    // ── Fetch Webshare proxies (optional) ──────────────────────────────────
    const proxyUrls = await fetchWebshareProxies();
    const proxyConfiguration = proxyUrls.length > 0
        ? new ProxyConfiguration({ proxyUrls })
        : undefined;

    // ── Configure crawler ──────────────────────────────────────────────────
    const crawler = new PlaywrightCrawler({
        // Limit to one request for this targeted scraping run
        maxRequestsPerCrawl: 1,

        // Rotate through Webshare proxies when available
        proxyConfiguration,

        // Use a headless Chromium browser; headless mode reduces overhead
        // while still handling JavaScript-rendered pages.
        // Anti-detect flags are passed here so they take effect for every
        // context opened within this browser instance.
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    ...ANTI_DETECT_LAUNCH_ARGS,
                    // Override the "HeadlessChrome" token in the default UA
                    `--user-agent=${USER_AGENT}`,
                ],
            },
        },

        // Inject session cookies and block heavyweight resources before the
        // first navigation so the browser already looks authenticated.
        preNavigationHooks: [
            // ── Anti-detect patches ────────────────────────────────────────
            // Runs before every navigation so all frames, including
            // those loaded by redirects, get the stealth patches.
            async ({ page, log: hookLog }) => {
                // Inject JS patches before any page script runs
                await page.addInitScript(buildStealthInitScript());

                // Randomise viewport to avoid a fixed-size fingerprint
                const viewport = VIEWPORT_PRESETS[randomBetween(0, VIEWPORT_PRESETS.length - 1)];
                await page.setViewportSize(viewport);

                // Realistic Accept-Language header
                await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

                hookLog.info(
                    `Anti-detect: stealth script injected, viewport ${viewport.width}×${viewport.height}.`,
                );
            },

            async ({ page, log: hookLog }) => {
                // ── Inject Facebook session cookies ──────────────────────
                await page.context().addCookies(cookies);
                hookLog.info('Session cookies injected.');

                // ── Block images, media, and fonts ───────────────────────
                // This reduces bandwidth usage and accelerates page load.
                await page.route(
                    '**/*',
                    async (route) => {
                        const resourceType = route.request().resourceType();
                        const blockedTypes = new Set([
                            'image',
                            'media',
                            'font',
                            'stylesheet', // optional: also block CSS to speed up further
                        ]);

                        if (blockedTypes.has(resourceType)) {
                            await route.abort();
                        } else {
                            await route.continue();
                        }
                    },
                );
                hookLog.info('Resource blocking configured (images, media, fonts, stylesheets).');
            },
        ],

        // ── Page handler ──────────────────────────────────────────────────
        async requestHandler({ page, log: reqLog }) {
            reqLog.info(`Navigating to: ${groupUrl}`);

            // Wait for the feed to render
            await page.waitForLoadState('domcontentloaded');

            // ── Scroll to trigger lazy-loading ────────────────────────────
            const scrollCount = randomBetween(3, 5);
            reqLog.info(`Scrolling ${scrollCount} times to load feed content…`);

            for (let i = 1; i <= scrollCount; i++) {
                // Human-like pause before scrolling (1 – 3 seconds)
                const delay = randomBetween(1000, 3000);
                reqLog.debug(`Scroll ${i}/${scrollCount}: waiting ${delay}ms before scroll`);
                await page.waitForTimeout(delay);

                // Scroll to the bottom of the current viewport
                await page.evaluate(() => window.scrollBy(0, window.innerHeight));

                // Wait for any new network activity to settle
                await page.waitForLoadState('networkidle').catch(() => {
                    // networkidle can time-out on very busy feeds — that's fine
                });
            }

            // ── Extract posts using ARIA roles ────────────────────────────
            // Facebook renders each post inside an element with role="article".
            // This semantic approach is robust to CSS class name changes.
            const postArticles = await page.locator('[role="article"]').all();
            reqLog.info(`Found ${postArticles.length} article element(s) on the page.`);

            const posts: PostRecord[] = [];

            for (const article of postArticles) {
                try {
                    // ── Post text ─────────────────────────────────────────
                    // The main content lives inside a <div> with the
                    // data-ad-comet-preview="message" attribute, or as the
                    // largest contiguous text block within the article.
                    // We try the semantic attribute first, then fall back to
                    // the largest visible text node.
                    let postText = '';

                    const messageDiv = article.locator('[data-ad-comet-preview="message"]');
                    if (await messageDiv.count() > 0) {
                        postText = (await messageDiv.first().innerText()).trim();
                    } else {
                        // Fallback: grab all text from the article element
                        postText = (await article.innerText()).trim();
                    }

                    // Skip empty or very short articles (likely UI widgets)
                    if (postText.length < MIN_POST_TEXT_LENGTH) continue;

                    // ── Author name ───────────────────────────────────────
                    // The author link usually has aria-label set to the name,
                    // or we can read the text of the first <a> inside a
                    // [data-hovercard-prefer-more-content-show] element.
                    let author = '';

                    const authorLink = article.locator('h2 a, h3 a, h4 a').first();
                    if (await authorLink.count() > 0) {
                        author = (await authorLink.innerText()).trim();
                    }

                    // ── Post permalink ────────────────────────────────────
                    // Permalinks to posts look like:
                    //   https://www.facebook.com/groups/<id>/posts/<postId>
                    //   https://www.facebook.com/permalink.php?story_fbid=...
                    // We search within the article for a matching href.
                    let postUrl = '';

                    const allLinks = await article.locator('a[href]').all();
                    for (const link of allLinks) {
                        const href = await link.getAttribute('href');
                        if (
                            href &&
                            (href.includes('/posts/') ||
                                href.includes('permalink.php') ||
                                href.includes('story_fbid'))
                        ) {
                            // Normalize relative URLs
                            postUrl = href.startsWith('http')
                                ? href
                                : `https://www.facebook.com${href}`;
                            break;
                        }
                    }

                    posts.push({
                        post_text: postText,
                        author,
                        post_url: postUrl,
                        scraped_at: new Date().toISOString(),
                    });
                } catch (articleErr) {
                    reqLog.warning(`Failed to parse an article element: ${String(articleErr)}`);
                }
            }

            reqLog.info(`Successfully extracted ${posts.length} post(s).`);

            // ── Save to Crawlee Dataset ────────────────────────────────────
            await Dataset.pushData(posts);
        },

        // Handle request errors gracefully
        failedRequestHandler({ request, log: failLog }, error) {
            failLog.error(`Request ${request.url} failed: ${String(error)}`);
        },
    });

    // ── Run the crawler ────────────────────────────────────────────────────
    await crawler.run([{ url: groupUrl }]);
    log.info('Crawl complete.');

    // ── Send data to Cloudflare Worker webhook ─────────────────────────────
    log.info('Reading dataset…');
    const dataset = await Dataset.open();
    const { items } = await dataset.getData();

    if (items.length === 0) {
        log.warning('Dataset is empty — nothing to send to the webhook.');
        return;
    }

    log.info(`Sending ${items.length} record(s) to webhook: ${webhookUrl}`);

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
    });

    if (!response.ok) {
        throw new Error(
            `Webhook POST failed: HTTP ${response.status} ${response.statusText}`,
        );
    }

    log.info(`Webhook responded with HTTP ${response.status}. All done!`);
}

main().catch((err) => {
    log.error(`Fatal error: ${String(err)}`);
    process.exit(1);
});
