const express = require("express");
const { track } = require("./index");

const app = express();
app.use(express.json());

// Concurrency control — max 2 simultaneous tracking requests
const MAX_CONCURRENT = 2;
const QUEUE_TIMEOUT = 120_000;
let running = 0;
const queue = [];

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error("Queue timeout — too many concurrent requests"));
    }, QUEUE_TIMEOUT);
    const entry = { resolve, reject, timer };
    queue.push(entry);
  });
}

function releaseSlot() {
  if (queue.length > 0) {
    const next = queue.shift();
    clearTimeout(next.timer);
    next.resolve();
  } else {
    running--;
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", running, queued: queue.length });
});

app.post("/track", async (req, res) => {
  const { carrier, reference } = req.body || {};

  if (!carrier || !reference) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: "carrier" and "reference"',
    });
  }

  try {
    await acquireSlot();
  } catch (err) {
    return res.status(503).json({ success: false, error: err.message });
  }

  try {
    const result = await track(carrier, reference);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    releaseSlot();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`tracking-big-3 API listening on port ${PORT}`);
});
