const { createTrackingSession } = require("../lib/browser");
const { interceptApiResponse } = require("../lib/intercept");

async function trackMaersk(trackingNumber) {
  const session = await createTrackingSession("maersk");

  try {
    const apiData = await interceptApiResponse(session.page, {
      urlPattern: "https://api.maersk.com/synergy/tracking/",
      trackingUrl: `https://www.maersk.com/tracking/${trackingNumber}`,
      consentSelector: 'button:has-text("Allow all")',
    });

    if (!apiData) {
      return { success: false, error: "No tracking data received from API" };
    }

    return { success: true, data: normalizeData(apiData) };
  } finally {
    await session.close();
  }
}

function normalizeData(raw) {
  const containers = (raw.containers || []).map((c) => {
    const events = [];
    for (const loc of c.locations || []) {
      for (const evt of loc.events || []) {
        events.push({
          activity: evt.activity,
          location: loc.city,
          terminal: loc.terminal,
          country: loc.country,
          countryCode: loc.country_code,
          vessel: evt.vessel_name || null,
          voyage: evt.voyage_num || null,
          time: evt.event_time,
          status: evt.event_time_type, // ACTUAL or EXPECTED
        });
      }
    }

    events.sort((a, b) => new Date(a.time) - new Date(b.time));

    const eta = events
      .filter(
        (e) =>
          e.status === "EXPECTED" &&
          (e.activity === "CONTAINER ARRIVAL" || e.activity === "DISCHARG")
      )
      .pop();

    const etd = events
      .find((e) => e.activity === "CONTAINER DEPARTURE");

    const latestActual = events.filter((e) => e.status === "ACTUAL").pop();

    // Current or last vessel from latest event with vessel info
    const vesselEvent = [...events].reverse().find((e) => e.vessel);

    return {
      containerNumber: c.container_num,
      size: c.container_size,
      type: c.container_type,
      isoCode: c.iso_code || null,
      sealNumber: c.seal_number || null,
      weight: c.cargo_weight || null,
      eta: eta ? eta.time : null,
      etd: etd ? etd.time : null,
      etaLocation: eta ? `${eta.location}, ${eta.country}` : null,
      latestEvent: latestActual
        ? {
            activity: latestActual.activity,
            location: `${latestActual.location}, ${latestActual.country}`,
            time: latestActual.time,
          }
        : null,
      vessel: vesselEvent ? vesselEvent.vessel : null,
      voyage: vesselEvent ? vesselEvent.voyage : null,
      events,
    };
  });

  return {
    carrier: "MAERSK",
    trackingNumber: raw.tpdoc_num,
    lastUpdated: raw.last_update_time,
    origin: {
      city: raw.origin.city,
      terminal: raw.origin.terminal,
      country: raw.origin.country,
      countryCode: raw.origin.country_code,
    },
    destination: {
      city: raw.destination.city,
      terminal: raw.destination.terminal,
      country: raw.destination.country,
      countryCode: raw.destination.country_code,
    },
    containers,
  };
}

module.exports = { trackMaersk };
