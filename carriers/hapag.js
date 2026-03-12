const { createTrackingSession } = require("../lib/browser");
const path = require("path");
const fs = require("fs");

const TRACKING_URL =
  "https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html";
const DIAG_DIR = path.join(__dirname, "..", ".profiles", "hapag");

async function trackHapag(trackingNumber) {
  const session = await createTrackingSession("hapag");

  try {
    const data = await scrapeTracking(session.page, trackingNumber);
    if (!data) {
      return { success: false, error: "No tracking data found" };
    }
    return { success: true, data };
  } finally {
    await session.close();
  }
}

async function scrapeTracking(page, trackingNumber) {
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));

  await page.goto(TRACKING_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Handle Cloudflare Turnstile challenge if present
  await handleCloudflareChallenge(page);

  // Cookie consent
  try {
    await page
      .locator('button:has-text("Select All")')
      .first()
      .click({ timeout: 5000 });
  } catch {}

  await page.waitForTimeout(2000);

  // Fill BL in "Bill of Lading No." field
  const blInput = await findBlInput(page);
  await blInput.click();
  await blInput.fill(trackingNumber);

  // Click Find
  await page.locator('button:has-text("Find")').first().click();
  await page.waitForTimeout(8000);

  // Check for error messages
  const pageText = await page.textContent("body").catch(() => "");
  if (pageText.includes("does not exist") || pageText.includes("not a valid")) {
    return null;
  }

  // Parse container list
  const containerRows = await parseContainerList(page);
  if (containerRows.length === 0) {
    return null;
  }

  // For each container: select radio, click Details, parse events
  const containers = [];
  for (let i = 0; i < containerRows.length; i++) {
    // Select container radio via JS (hidden radios can't be clicked normally)
    await page.evaluate((idx) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      if (radios[idx]) {
        radios[idx].checked = true;
        radios[idx].dispatchEvent(new Event("change", { bubbles: true }));
        radios[idx].dispatchEvent(new Event("click", { bubbles: true }));
      }
    }, i);
    await page.waitForTimeout(500);

    // Click Details button (JSF button in table tfoot)
    await page.evaluate(() => {
      const btn = document.querySelector('button[value="Details"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);

    // Parse container detail
    const detail = await parseContainerDetail(page);
    containers.push({
      ...containerRows[i],
      ...detail,
    });

    // Go back to container list
    try {
      await page.evaluate(() => {
        const btn = document.querySelector('button[value="Close"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);
    } catch {}
  }

  // Build origin/destination from events
  const allEvents = containers.flatMap((c) => c.events || []);
  const firstEvent = allEvents[0];
  const lastVesselArrival = [...allEvents]
    .reverse()
    .find((e) => e.activity.toLowerCase().includes("vessel arrival"));

  const origin = firstEvent
    ? parsePlace(firstEvent.location)
    : { city: "", countryCode: "" };
  const destination = lastVesselArrival
    ? parsePlace(lastVesselArrival.location)
    : { city: "", countryCode: "" };

  return {
    carrier: "HAPAG",
    trackingNumber,
    lastUpdated: new Date().toISOString(),
    origin: {
      city: origin.city,
      terminal: null,
      country: origin.countryCode,
      countryCode: origin.countryCode,
    },
    destination: {
      city: destination.city,
      terminal: null,
      country: destination.countryCode,
      countryCode: destination.countryCode,
    },
    containers,
  };
}

// --- Cloudflare Turnstile ---

async function handleCloudflareChallenge(page) {
  const bodyText = await page.textContent("body").catch(() => "");
  if (!bodyText.includes("Security Check") && !bodyText.includes("Verify you are human")) {
    return; // No challenge
  }

  console.log("[hapag] Cloudflare challenge detected, attempting to solve...");

  // Attempt 1: Wait for Turnstile to auto-solve (up to 10s)
  const solved = await waitForChallengePass(page, 10000);
  if (solved) {
    console.log("[hapag] Cloudflare challenge auto-solved");
    return;
  }

  // Attempt 2: Click the Turnstile checkbox inside iframe
  console.log("[hapag] Trying to click Turnstile checkbox...");
  try {
    const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
    // The checkbox is typically a div with role or the body of the iframe
    await turnstileFrame.locator("body").click({ timeout: 5000 });
  } catch {
    // Some Turnstile versions use a different structure
    try {
      const frames = page.frames();
      for (const frame of frames) {
        if (frame.url().includes("challenges.cloudflare.com")) {
          await frame.click("body", { timeout: 3000 });
          break;
        }
      }
    } catch {}
  }

  // Wait for challenge to pass after click
  const solvedAfterClick = await waitForChallengePass(page, 15000);
  if (solvedAfterClick) {
    console.log("[hapag] Cloudflare challenge solved after click");
    return;
  }

  // 2captcha Turnstile solver does NOT work for Cloudflare managed challenges.
  // The token cannot be injected via callback — Cloudflare's encrypted protocol
  // requires the full widget flow. Use a residential proxy instead.
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIAG_DIR, "debug-challenge.png"), fullPage: true });
  throw new Error("Cloudflare Turnstile managed challenge — use a residential proxy (TRACKER_PROXY_URL)");
}

async function waitForChallengePass(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check if page navigated away from challenge
    const text = await page.textContent("body").catch(() => "");
    if (!text.includes("Security Check") && !text.includes("Verify you are human")) {
      // Wait a bit for the actual page to load
      await page.waitForTimeout(2000);
      return true;
    }
    // Check if Turnstile set the response token (means it passed)
    const hasToken = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return input && input.value && input.value.length > 0;
    }).catch(() => false);
    if (hasToken) {
      // Token set, wait for form submission / redirect
      await page.waitForTimeout(3000);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// --- BL Input Finder ---

async function findBlInput(page) {
  const selectors = [
    'input[name="tracing_by_booking_f:hl16"]',
    'input[name*="hl16"]',
    'input[name*="booking_f"][type="text"]',
    'input[id*="hl16"]',
    'input[placeholder*="Bill of Lading"]',
    'input[placeholder*="B/L"]',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 })) {
        console.log(`[hapag] Found BL input: ${sel}`);
        return loc;
      }
    } catch {}
  }

  // Last resort: enumerate visible text inputs
  const allInputs = page.locator('input[type="text"]');
  const inputCount = await allInputs.count();
  console.log(`[hapag] No BL input found with known selectors. Text inputs: ${inputCount}`);
  for (let i = 0; i < inputCount; i++) {
    const inp = allInputs.nth(i);
    const name = await inp.getAttribute("name").catch(() => "");
    const id = await inp.getAttribute("id").catch(() => "");
    console.log(`[hapag]   input[${i}]: name="${name}" id="${id}"`);
  }

  // Save diagnostic screenshot
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIAG_DIR, "debug-page.png"), fullPage: true });
  throw new Error("Could not find BL input field — check .profiles/hapag/debug-page.png");
}

// --- Page Parsers ---

async function parseContainerList(page) {
  // Find all table rows across all tables, look for container rows
  const rows = [];
  const allTrs = page.locator("tr");
  const count = await allTrs.count();
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    const tr = allTrs.nth(i);
    const cells = tr.locator("> td");
    const cellCount = await cells.count();
    if (cellCount < 5) continue;

    const texts = [];
    for (let j = 0; j < cellCount; j++) {
      texts.push(
        (await cells.nth(j).textContent().catch(() => ""))
          .trim()
          .replace(/\s+/g, " ")
      );
    }

    // Match container rows: radio column may be first (empty), then ISO code
    // Find the ISO code position — could be index 0 or 1
    let isoIdx = texts.findIndex((t) => /^\d{2}[A-Z0-9]{2}$/.test(t));
    if (isoIdx < 0 || isoIdx + 1 >= texts.length) continue;
    if (texts[isoIdx + 1].length < 5) continue;

    {
      const containerNum = texts[isoIdx + 1].replace(/\s/g, "");
      if (seen.has(containerNum)) continue;
      seen.add(containerNum);

      const { size, type } = parseContainerType(texts[isoIdx]);
      rows.push({
        containerNumber: containerNum,
        size,
        type,
        isoCode: texts[isoIdx],
        sealNumber: null,
        weight: null,
        eta: null,
        etd: null,
        etaLocation: null,
        latestEvent: null,
        vessel: null,
        voyage: null,
        events: [],
      });
    }
  }

  return rows;
}

async function parseContainerDetail(page) {
  // Parse container info: Type, Description, Dimension, Tare, Max Payload
  const containerInfo = {};
  const infoText = await page
    .locator("text=Container Information")
    .locator("..")
    .textContent()
    .catch(() => "");

  const tareMatch = infoText.match(/Tare\s*\(kg\)\s*(\d+)/);
  const descMatch = infoText.match(/Description\s+([\w\s.]+?)(?=Dimension|$)/);

  if (tareMatch) containerInfo.tare = parseInt(tareMatch[1]);
  if (descMatch) containerInfo.description = descMatch[1].trim();

  // Parse events: find all TRs with 6+ TDs where one column is a YYYY-MM-DD date
  const events = [];
  const allTrs = page.locator("tr");
  const trCount = await allTrs.count();
  const seenEvents = new Set();

  for (let r = 0; r < trCount; r++) {
    const cells = allTrs.nth(r).locator("> td");
    const cellCount = await cells.count();
    if (cellCount < 5) continue;

    const texts = [];
    for (let c = 0; c < cellCount; c++) {
      texts.push(
        (await cells.nth(c).textContent().catch(() => ""))
          .trim()
          .replace(/\s+/g, " ")
      );
    }

    // Find the date column (YYYY-MM-DD)
    const dateIdx = texts.findIndex((t) => /^\d{4}-\d{2}-\d{2}$/.test(t));
    if (dateIdx < 2) continue;

    const activity = texts[dateIdx - 2];
    const location = texts[dateIdx - 1];
    const date = texts[dateIdx];
    const time = texts[dateIdx + 1] || "";
    const transport = texts[dateIdx + 2] || null;
    const voyage = texts[dateIdx + 3] || null;

    // Skip header rows
    if (activity === "Status") continue;

    // Deduplicate
    const key = `${activity}|${location}|${date}|${time}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);

    const isVessel =
      transport &&
      transport !== "Truck" &&
      transport !== "Rail" &&
      transport !== "Barge";

    events.push({
      activity,
      location,
      terminal: null,
      country: parsePlace(location).countryCode,
      countryCode: parsePlace(location).countryCode,
      vessel: isVessel ? transport : null,
      voyage: isVessel ? voyage : null,
      time: `${date}T${time || "00:00"}:00Z`,
      status: isFutureEvent(activity) ? "EXPECTED" : "ACTUAL",
    });
  }

  // Derive fields from events
  const latestActual = [...events]
    .reverse()
    .find((e) => e.status === "ACTUAL");

  const etaEvent = [...events]
    .reverse()
    .find(
      (e) =>
        e.status === "EXPECTED" &&
        e.activity.toLowerCase().includes("vessel arrival")
    );

  const etdEvent = events.find(
    (e) =>
      e.vessel &&
      (e.activity.toLowerCase().includes("departed") ||
        e.activity.toLowerCase().includes("loaded"))
  );

  const vesselEvent = [...events].reverse().find((e) => e.vessel);

  return {
    eta: etaEvent ? etaEvent.time : null,
    etd: etdEvent ? etdEvent.time : null,
    etaLocation: etaEvent ? etaEvent.location : null,
    latestEvent: latestActual
      ? {
          activity: latestActual.activity,
          location: latestActual.location,
          time: latestActual.time,
        }
      : null,
    vessel: vesselEvent ? vesselEvent.vessel : null,
    voyage: vesselEvent ? vesselEvent.voyage : null,
    events,
  };
}

// --- Helpers ---

function parsePlace(location) {
  // "MONTREAL, QC" or "TANGER MED" → { city, countryCode }
  if (!location) return { city: "", countryCode: "" };
  const parts = location.split(", ");
  const city = titleCase(parts[0] || "");
  const countryCode = parts[1] || "";
  return { city, countryCode };
}

function titleCase(str) {
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseContainerType(isoCode) {
  // "45GP" → { size: "40", type: "HIGH CUBE" }
  // "20GP" → { size: "20", type: "DRY" }
  const sizeMap = { "20": "20", "22": "20", "40": "40", "42": "40", "45": "40" };
  const typeMap = {
    GP: "DRY",
    HC: "HIGH CUBE",
    RE: "REEFER",
    OT: "OPEN TOP",
    FR: "FLAT RACK",
    TK: "TANK",
  };
  const sizeCode = isoCode.slice(0, 2);
  const typeCode = isoCode.slice(2, 4);
  return {
    size: sizeMap[sizeCode] || sizeCode,
    type: typeMap[typeCode] || typeCode,
  };
}

function isFutureEvent(activity) {
  const lower = activity.toLowerCase();
  return (
    lower.includes("vessel arrival") ||
    lower.includes("vessel departure") ||
    lower.includes("estimated")
  );
}

module.exports = { trackHapag };
