const { createTrackingSession } = require("../lib/browser");

async function trackMsc(trackingNumber) {
  const session = await createTrackingSession("msc");

  try {
    const apiData = await fetchTrackingData(session.page, trackingNumber);

    if (!apiData) {
      return { success: false, error: "No tracking data received from API" };
    }

    if (!apiData.IsSuccess) {
      return { success: false, error: "MSC returned unsuccessful response" };
    }

    const bl = apiData.Data?.BillOfLadings?.[0];
    if (!bl) {
      return { success: false, error: "No bill of lading data in response" };
    }

    return { success: true, data: normalizeData(apiData.Data) };
  } finally {
    await session.close();
  }
}

async function fetchTrackingData(page, trackingNumber) {
  let apiData = null;

  // Listen for the tracking API response
  page.on("response", async (response) => {
    if (
      response.url().includes("/api/feature/tools/TrackingInfo") &&
      response.status() === 200
    ) {
      try {
        apiData = await response.json();
      } catch {}
    }
  });

  // Small random delay
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));

  await page.goto("https://www.msc.com/en/track-a-shipment?agencyPath=msc", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Cookie consent (OneTrust)
  try {
    await page
      .locator("#onetrust-accept-btn-handler")
      .click({ timeout: 5000 });
  } catch {}

  await page.waitForTimeout(1500);

  // Fill tracking number and submit
  const input = page.locator("#trackingNumber");
  await input.fill(trackingNumber);
  await input.press("Enter");

  // Poll until API data captured or timeout
  const deadline = Date.now() + 25000;
  while (!apiData && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }

  return apiData;
}

// --- Helpers ---

function parseLocation(loc) {
  // "GDYNIA, PL" → { city: "Gdynia", countryCode: "PL" }
  if (!loc) return { city: "", countryCode: "" };
  const parts = loc.split(", ");
  const city = titleCase(parts[0] || "");
  const countryCode = parts[1] || "";
  return { city, countryCode };
}

function titleCase(str) {
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseContainerType(typeStr) {
  // "40' HIGH CUBE" → { size: "40", type: "HIGH CUBE" }
  if (!typeStr) return { size: "", type: "" };
  const m = typeStr.match(/^(\d+)'?\s*(.*)$/);
  if (m) return { size: m[1], type: m[2] || "DRY" };
  return { size: "", type: typeStr };
}

function parseDate(dateStr) {
  // "07/02/2026" (DD/MM/YYYY) → "2026-02-07T00:00:00Z"
  if (!dateStr) return null;
  const [d, m, y] = dateStr.split("/");
  if (!d || !m || !y) return null;
  return `${y}-${m}-${d}T00:00:00Z`;
}

function parseVessel(detail) {
  // ["MSC DENMARK VI", "NY603R"] → { vessel, voyage }
  // ["LADEN"] or ["EMPTY"] → null
  if (!detail || detail.length === 0) return { vessel: null, voyage: null };
  if (detail.length === 1) {
    const v = detail[0];
    if (v === "LADEN" || v === "EMPTY") return { vessel: null, voyage: null };
    return { vessel: v, voyage: null };
  }
  return { vessel: detail[0], voyage: detail[1] };
}

// --- Normalizer ---

function normalizeData(data) {
  const bl = data.BillOfLadings[0];
  const info = bl.GeneralTrackingInfo;

  const origin = parseLocation(info.ShippedFrom);
  const destination = parseLocation(info.ShippedTo);

  const containers = (bl.ContainersInfo || []).map((c) => {
    const { size, type } = parseContainerType(c.ContainerType);

    // Sort events by Order ascending (chronological)
    const rawEvents = [...(c.Events || [])].sort(
      (a, b) => a.Order - b.Order
    );

    const events = rawEvents.map((evt) => {
      const loc = parseLocation(evt.Location);
      const { vessel, voyage } = parseVessel(evt.Detail);
      return {
        activity: evt.Description,
        location: loc.city,
        terminal: evt.EquipmentHandling?.Name || null,
        country: loc.countryCode,
        countryCode: loc.countryCode,
        vessel,
        voyage,
        time: parseDate(evt.Date),
        status: "ACTUAL",
      };
    });

    // ETA from PodEtaDate
    const eta = parseDate(c.PodEtaDate) || null;
    const etaLoc = eta ? `${destination.city}, ${destination.countryCode}` : null;

    // ETD: first event with vessel loaded at origin
    const loadEvent = events.find(
      (e) => e.vessel && e.activity.toLowerCase().includes("loaded")
    );
    const etd = loadEvent ? loadEvent.time : null;

    // Latest actual event (last in chronological order)
    const latestEvent = events.length > 0 ? events[events.length - 1] : null;

    // Current vessel: last event with vessel info
    const vesselEvent = [...events].reverse().find((e) => e.vessel);

    return {
      containerNumber: c.ContainerNumber,
      size,
      type,
      isoCode: null,
      sealNumber: null,
      weight: null,
      eta,
      etd,
      etaLocation: etaLoc,
      latestEvent: latestEvent
        ? {
            activity: latestEvent.activity,
            location: `${latestEvent.location}, ${latestEvent.country}`,
            time: latestEvent.time,
          }
        : null,
      vessel: vesselEvent ? vesselEvent.vessel : null,
      voyage: vesselEvent ? vesselEvent.voyage : null,
      events,
    };
  });

  return {
    carrier: "MSC",
    trackingNumber: bl.BillOfLadingNumber,
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

module.exports = { trackMsc };
