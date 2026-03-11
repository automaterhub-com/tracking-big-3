/**
 * Shared API response interception for carrier tracking pages.
 */

async function interceptApiResponse(page, options) {
  const {
    urlPattern,
    trackingUrl,
    timeout = 25000,
    consentSelector = null,
  } = options;

  let apiData = null;

  // Register response listener
  page.on("response", async (response) => {
    const url = response.url();
    const matches =
      typeof urlPattern === "string"
        ? url.startsWith(urlPattern)
        : urlPattern.test(url);

    if (matches && response.status() === 200) {
      try {
        apiData = await response.json();
      } catch {
        // not JSON
      }
    }
  });

  // Small random delay for behavioral realism
  const delay = 500 + Math.random() * 1000;
  await new Promise((r) => setTimeout(r, delay));

  // Navigate to tracking page
  await page.goto(trackingUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Handle cookie consent
  if (consentSelector) {
    try {
      await page.locator(consentSelector).first().click({ timeout: 5000 });
    } catch {
      // no banner or already dismissed (persistent profile)
    }
  }

  // Poll until API data captured or timeout
  const deadline = Date.now() + timeout;
  while (!apiData && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }

  return apiData;
}

module.exports = { interceptApiResponse };
