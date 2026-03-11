# Shipment Tracking Integration — Spec

## Overview

When an SCK Zendesk agent fills the **BL Number** field (ID `29021612416914`) on a ticket, a Zendesk trigger fires a webhook to n8n. n8n detects the carrier from the BL pattern, calls the tracking API (tracking-big-3 deployed on Coolify), and posts the full tracking summary as an internal note on the ticket.

```
Zendesk (BL filled) → webhook → n8n → tracking API → n8n → Zendesk internal note
```

## Infrastructure

| Component          | Where                          | Status     |
|--------------------|--------------------------------|------------|
| Tracking API       | Coolify (new Docker service)   | To build   |
| n8n workflow       | Existing n8n on Coolify        | To build   |
| Zendesk trigger    | SCK Zendesk                    | To create  |

**Server**: 2 CPU, 8GB RAM (~4.8GB available), 62GB disk free.

---

## Milestone 1 — HTTP API Wrapper

Add Express HTTP layer to tracking-big-3.

### Endpoints

| Method | Path      | Body                                          | Response                    |
|--------|-----------|-----------------------------------------------|-----------------------------|
| POST   | `/track`  | `{ "carrier": "maersk", "reference": "266412406" }` | `{ success, data?, error? }` |
| GET    | `/health` | —                                             | `{ status: "ok" }`         |

### Concurrency control

Playwright is heavy (~500MB per browser instance). Add a semaphore limiting concurrent tracking requests to **2**. Requests beyond the limit queue and wait (with a 120s timeout).

### Files to create/modify

- `server.js` — Express server (separate from index.js to keep CLI working)
- `package.json` — add `express` dependency + `start` script

---

## Milestone 2 — Dockerize

### Dockerfile

- Base: `node:20-slim` (or `mcr.microsoft.com/playwright:v1.52.0-noble` for pre-installed browser deps)
- Install Chromium system deps + run `npx playwright install chromium`
- Copy project, `npm ci --production`
- Expose port 3000
- CMD: `node server.js`

### Files to create

- `Dockerfile`
- `.dockerignore` (exclude node_modules, .profiles, *.json test outputs)

### Test locally

```bash
docker build -t tracking-big-3 .
docker run -p 3000:3000 tracking-big-3
curl -X POST http://localhost:3000/track -H 'Content-Type: application/json' -d '{"carrier":"maersk","reference":"266412406"}'
```

---

## Milestone 3 — Deploy to Coolify

1. Push repo to Git (GitHub or Coolify's built-in Git)
2. Create new service in Coolify:
   - Type: Dockerfile
   - Port: 3000
   - Domain: `tracking.automerhub.com` (add A record in Hostinger → Coolify server IP)
   - Environment vars: `TRACKER_ALLOW_HEADED=false`
3. Verify deployment: `curl https://tracking.automerhub.com/health`

---

## Milestone 4 — Carrier Detection Logic (n8n Code Node)

Pattern matching on BL number:

| Pattern                        | Carrier  | Example           |
|--------------------------------|----------|-------------------|
| Starts with `HLCU`             | hapag    | HLCUTOR251233330  |
| Starts with `MEDU`             | msc      | MEDUYK515565      |
| Starts with `MAEU`             | maersk   | MAEU266412406     |
| Purely numeric                 | maersk   | 266412406         |
| Starts with `MSCU` / `MSDU`   | msc      | MSCU1234567       |
| No match                       | skip     | —                 |

```js
function detectCarrier(bl) {
  bl = bl.trim().toUpperCase();
  if (bl.startsWith('HLCU')) return 'hapag';
  if (bl.startsWith('MEDU') || bl.startsWith('MSCU') || bl.startsWith('MSDU')) return 'msc';
  if (bl.startsWith('MAEU')) return 'maersk';
  if (/^\d+$/.test(bl)) return 'maersk';
  return null; // unknown
}
```

---

## Milestone 5 — n8n Workflow

### Nodes

1. **Webhook** (POST) — receives Zendesk payload
2. **Code: Extract & Detect** — pull BL from payload, detect carrier, bail if unknown
3. **HTTP Request** — `POST https://tracking.automerhub.com/track` with `{ carrier, reference }`
4. **Code: Format Note** — transform tracking response into human-readable internal note (markdown-ish)
5. **HTTP Request** — `PUT /api/v2/tickets/{id}.json` on SCK Zendesk, add internal note

### Webhook payload from Zendesk

Zendesk triggers send JSON with placeholders. We'll configure:

```json
{
  "ticket_id": "{{ticket.id}}",
  "bl_number": "{{ticket.ticket_field_29021612416914}}"
}
```

### Internal note format

```
📦 Shipment Tracking — MAERSK
BL: 266412406
Route: Mundra, India → Douala, Cameroon
Updated: 2026-03-10T14:30:00Z

Container: MSKU4636948 (45' DRY)
Vessel: MAERSK SELETAR / 609S
ETD: 15 Feb 2026
ETA: 10 Mar 2026 → Douala, Cameroon
Status: DISCHARG @ Douala, Cameroon — 09 Mar 2026

Events:
  ✓ 12 Feb 2026 — GATE-IN @ Mundra, India
  ✓ 15 Feb 2026 — LOAD @ Mundra, India (MAERSK SELETAR/609S)
  ✓ 09 Mar 2026 — DISCHARG @ Douala, Cameroon
  ○ 12 Mar 2026 — GATE-OUT @ Douala, Cameroon (expected)
```

---

## Milestone 6 — Zendesk Trigger

Create a Zendesk trigger in SCK:

- **Name**: "BL Tracking — Send to n8n"
- **Conditions (ALL)**:
  - Ticket is Updated
  - BL Number field changed
  - BL Number field is Present (not empty)
  - Current tags does not contain `bl_tracked`
- **Actions**:
  - Notify webhook: `POST https://<n8n-webhook-url>` with JSON body
  - Add tag: `bl_tracked` (prevents re-triggering on subsequent edits)

The `bl_tracked` tag is key — it ensures the webhook fires only on first fill.

---

## Milestone 7 — Testing & Hardening

1. End-to-end test: fill BL on a test ticket, verify internal note appears
2. Test each carrier: Maersk (numeric BL), MSC (MEDU prefix), Hapag (HLCU prefix)
3. Test edge cases:
   - Invalid BL → silent fail (no note posted)
   - Unrecognized carrier prefix → silent fail
   - Tracking API timeout → silent fail
   - Empty BL field → Zendesk trigger doesn't fire (condition: "is present")
4. Monitor server resources during tracking (Playwright memory usage)

---

## Architecture Diagram

```
┌─────────────┐     webhook      ┌──────────┐     HTTP POST      ┌──────────────────┐
│   Zendesk   │ ──────────────→  │   n8n    │ ──────────────→   │  tracking-big-3  │
│  (SCK)      │                  │ workflow │                    │  (Coolify/Docker) │
│             │  ← PUT note ──  │          │  ← JSON result ── │  Express + PW     │
└─────────────┘                  └──────────┘                    └──────────────────┘
      │                                                                │
      │  trigger: BL field filled                                      │
      │  + tag: bl_tracked                                             │
      │  condition: !bl_tracked                          Playwright headless
                                                         browser scraping
```

---

## Decisions (Resolved)

1. **Domain**: `tracking.automerhub.com`
2. **Zendesk credentials in n8n**: Already saved as "sck"
3. **Timeout**: Synchronous — n8n waits for tracking API response inline

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Playwright OOM on 2-CPU/8GB server | Concurrency limit of 2; monitor with Grafana (already on server) |
| Anti-bot blocks after deployment | Cookie persistence via Docker volume for `.profiles/` dir |
| Zendesk trigger fires on BL edit (not just first fill) | `bl_tracked` tag prevents re-triggering |
| n8n webhook timeout (tracking takes 15-30s) | Set n8n webhook timeout to 120s; or use async pattern |
| BL carrier mismatch (wrong detection) | Log carrier detection in n8n for debugging; agent can manually re-trigger later |
