const { trackMaersk } = require("./carriers/maersk");
const { trackMsc } = require("./carriers/msc");
// const { trackHapag } = require("./carriers/hapag");  // Disabled — Cloudflare managed challenge on VPS

const CARRIERS = {
  maersk: trackMaersk,
  // cmacgm: trackCmaCgm,   // TODO
  msc: trackMsc,
  // hapag: trackHapag,      // Disabled — Cloudflare managed challenge on VPS
};

const ALIASES = {
  maersk: "maersk",
  maeu: "maersk",
  cmacgm: "cmacgm",
  "cma-cgm": "cmacgm",
  cma: "cmacgm",
  msc: "msc",
  hapag: "hapag",
  "hapag-lloyd": "hapag",
  hlcu: "hapag",
};

/**
 * Track a shipment.
 * @param {string} carrier - Carrier name (maersk, cmacgm, msc)
 * @param {string} reference - BL number, booking number, or container number
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function track(carrier, reference) {
  const key = ALIASES[carrier.toLowerCase()];
  if (!key) {
    return {
      success: false,
      error: `Unknown carrier "${carrier}". Supported: ${Object.keys(ALIASES).join(", ")}`,
    };
  }

  const fn = CARRIERS[key];
  if (!fn) {
    return {
      success: false,
      error: `Carrier "${key}" is not yet implemented`,
    };
  }

  return fn(reference);
}

// CLI usage
if (require.main === module) {
  const carrier = process.argv[2];
  const reference = process.argv[3];

  if (!carrier || !reference) {
    console.error("Usage: node index.js <carrier> <tracking-number>");
    console.error("Carriers: maersk, cmacgm, msc");
    process.exit(1);
  }

  console.log(`Tracking ${reference} on ${carrier.toUpperCase()}...`);

  track(carrier, reference)
    .then((result) => {
      if (!result.success) {
        console.error("Error:", result.error);
        process.exit(1);
      }

      const d = result.data;
      console.log(`\n${"=".repeat(60)}`);
      console.log(`  ${d.carrier} — BL ${d.trackingNumber}`);
      console.log(`${"=".repeat(60)}`);
      console.log(`  Route:    ${d.origin.city} → ${d.destination.city}`);
      console.log(`  Updated:  ${d.lastUpdated}`);
      console.log();

      for (const c of d.containers) {
        console.log(`  Container: ${c.containerNumber} (${c.size}' ${c.type})`);
        if (c.vessel) {
          console.log(`  Vessel:    ${c.vessel} / ${c.voyage}`);
        }
        if (c.latestEvent) {
          console.log(
            `  Status:    ${c.latestEvent.activity} @ ${c.latestEvent.location} — ${formatDate(c.latestEvent.time)}`
          );
        }
        if (c.etd) {
          console.log(`  ETD:       ${formatDate(c.etd)}`);
        }
        if (c.eta) {
          console.log(`  ETA:       ${formatDate(c.eta)} → ${c.etaLocation}`);
        }
        if (c.sealNumber) {
          console.log(`  Seal:      ${c.sealNumber}`);
        }
        console.log();
        console.log("  Events:");
        for (const e of c.events) {
          const marker = e.status === "ACTUAL" ? "✓" : "○";
          const vessel = e.vessel ? ` (${e.vessel}/${e.voyage})` : "";
          console.log(
            `    ${marker} ${formatDate(e.time)}  ${e.activity}${vessel}`
          );
          console.log(`      ${e.terminal}, ${e.country}`);
        }
        console.log();
      }

      // Write JSON
      const outFile = `${d.carrier.toLowerCase()}-${reference}.json`;
      require("fs").writeFileSync(outFile, JSON.stringify(result.data, null, 2));
      console.log(`JSON saved: ${outFile}`);
    })
    .catch((err) => {
      console.error("Fatal:", err.message);
      process.exit(1);
    });
}

function formatDate(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

module.exports = { track };
