const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const path = require("path");
const fs = require("fs");
const https = require("https");

// Apply stealth plugin once
chromium.use(stealth);

const PROFILES_DIR = path.join(__dirname, "..", ".profiles");
const VERSION_CHECK_FILE = path.join(PROFILES_DIR, ".version-check");

// NOTE: googletagmanager.com intentionally NOT blocked — Maersk SPA depends on GTM for init
const ANALYTICS_DOMAINS = [
  "google-analytics.com",
  "facebook.net",
  "hotjar.com",
  "doubleclick.net",
  "googlesyndication.com",
  "clarity.ms",
  "newrelic.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
];

function blockAnalytics(page) {
  return page.route(
    (url) =>
      ANALYTICS_DOMAINS.some((d) => url.hostname.includes(d.split("/")[0])),
    (route) => route.abort()
  );
}

function cookiePath(carrierName) {
  return path.join(PROFILES_DIR, carrierName, "cookies.json");
}

async function loadCookies(context, carrierName) {
  const file = cookiePath(carrierName);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data) && data.length > 0) {
      await context.addCookies(data);
    }
  } catch {
    // no saved cookies
  }
}

async function saveCookies(context, carrierName) {
  const file = cookiePath(carrierName);
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const cookies = await context.cookies();
    fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
  } catch {
    // ignore save errors
  }
}

async function checkVersionStaleness() {
  try {
    const now = Date.now();
    let lastCheck = 0;
    try {
      lastCheck = parseInt(fs.readFileSync(VERSION_CHECK_FILE, "utf8"), 10);
    } catch {
      // no previous check
    }

    const ONE_DAY = 86400000;
    if (now - lastCheck < ONE_DAY) return;

    fs.mkdirSync(path.dirname(VERSION_CHECK_FILE), { recursive: true });
    fs.writeFileSync(VERSION_CHECK_FILE, String(now));

    const installed = require("playwright/package.json").version;

    const latest = await new Promise((resolve, reject) => {
      https
        .get("https://registry.npmjs.org/playwright/latest", (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data).version);
            } catch {
              reject(new Error("Failed to parse registry response"));
            }
          });
        })
        .on("error", reject);
    });

    const [iMaj, iMin] = installed.split(".").map(Number);
    const [lMaj, lMin] = latest.split(".").map(Number);
    const minorsBehind = (lMaj - iMaj) * 100 + (lMin - iMin);

    if (minorsBehind > 2) {
      console.warn(
        `[browser] playwright ${installed} is ${minorsBehind} minor versions behind ${latest}. Run: npm run update:stealth`
      );
    }
  } catch {
    // non-blocking, ignore errors
  }
}

async function createTrackingSession(carrierName, options = {}) {
  // Version check (non-blocking)
  checkVersionStaleness().catch(() => {});

  fs.mkdirSync(path.join(PROFILES_DIR, carrierName), { recursive: true });

  const proxyUrl = options.proxyUrl || process.env.TRACKER_PROXY_URL;
  const forceHeaded = process.env.TRACKER_HEADED === "true";
  const headed = process.env.TRACKER_ALLOW_HEADED === "true";

  const launchArgs = ["--disable-blink-features=AutomationControlled"];

  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
  };

  if (proxyUrl) {
    contextOptions.proxy = { server: proxyUrl };
  }

  async function launch(headless) {
    const browser = await chromium.launch({
      headless,
      args: launchArgs,
    });

    const context = await browser.newContext(contextOptions);
    await loadCookies(context, carrierName);

    const page = await context.newPage();
    await blockAnalytics(page);

    return {
      page,
      context,
      close: async () => {
        await saveCookies(context, carrierName);
        await context.close();
        await browser.close();
      },
    };
  }

  // Retry logic
  const errors = [];

  // Force headed mode — skip retries, launch once
  if (forceHeaded) {
    return await launch(false);
  }

  // Attempt 1
  try {
    return await launch(true);
  } catch (err) {
    errors.push(err);
  }

  // Attempt 2: wait 2-5s, retry
  const delay = 2000 + Math.random() * 3000;
  await new Promise((r) => setTimeout(r, delay));

  try {
    return await launch(true);
  } catch (err) {
    errors.push(err);
  }

  // Attempt 3: clear cookies, retry
  try {
    const file = cookiePath(carrierName);
    try { fs.unlinkSync(file); } catch {}
    return await launch(true);
  } catch (err) {
    errors.push(err);
  }

  // Attempt 4: headed mode (if allowed)
  if (headed) {
    try {
      return await launch(false);
    } catch (err) {
      errors.push(err);
    }
  }

  const lastErr = errors[errors.length - 1];
  throw new Error(
    `Failed to launch browser after ${errors.length} attempts: ${lastErr.message}`
  );
}

module.exports = { createTrackingSession };
