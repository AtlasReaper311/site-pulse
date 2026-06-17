<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# site-pulse

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // site-pulse                │
│  live visitor stats on the portfolio,       │
│  straight from the edge                      │
└─────────────────────────────────────────────┘
```

![Cloudflare Worker](https://img.shields.io/badge/cloudflare-worker-f5a623?style=flat-square&labelColor=0a0a0f)
![Cache](https://img.shields.io/badge/cache-workers%20kv-4ade80?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

Read-only proxy between atlas-systems.uk and Cloudflare's GraphQL Analytics API. The site fetches one clean JSON document; the Worker handles authentication, the platform's query-window limits, and caching.

```
browser ──▶ api.atlas-systems.uk/site-pulse ──▶ KV cache (1 h)
                    │                                │ miss
                    │                                ▼
                    └◀── one JSON doc ◀── Cloudflare GraphQL Analytics API
```

Same backend-for-frontend shape as [`github-pulse`](https://github.com/AtlasReaper311/github-pulse): the analytics token never reaches the browser, and an hour of visitors costs one upstream query instead of one per page view.

## Prerequisites

- Node 22+ and `npx`
- Cloudflare Web Analytics enabled on the `atlas-systems.uk` zone (Cloudflare dashboard → the zone → Analytics & Logs → Web Analytics → Enable)
- A Cloudflare API token scoped to **Zone → Analytics → Read**, restricted to the specific `atlas-systems.uk` zone

That exact permission combination matters and is easy to get wrong: the generic "Account Analytics" permission group, despite being what Cloudflare's own general GraphQL walkthrough describes, does **not** grant access to this zone-scoped dataset. The permission that actually works is the plain **Analytics** group under a **Zone**-type resource, not an Account-type one.

## Setup

1. **Create the token.** Cloudflare dashboard → profile icon → My Profile → API Tokens → Create Token → Custom token. Resource type **Zone**, specific zone **atlas-systems.uk**, permission group **Analytics**, level **Read**. Copy it into Proton Pass immediately, it only displays once.

2. **Grab the Zone ID.** Cloudflare dashboard → the `atlas-systems.uk` zone → Overview → API section → Zone ID. Not a secret, safe to commit.

3. **Install and create the cache namespace:**
   ```bash
   npm install
   npx wrangler login
   npx wrangler kv namespace create SITE_PULSE_CACHE
   ```
   Paste the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`. The namespace title here is deliberately distinct from `github-pulse`'s `PULSE_CACHE` namespace, Cloudflare requires unique titles account-wide, the binding name in code stays `PULSE_CACHE` either way.

4. **Set the zone tag and host filter in `wrangler.toml`:**
   ```toml
   [vars]
   ZONE_TAG = "your-real-zone-id-here"
   SITE_HOST = "atlas-systems.uk"
   CACHE_TTL_SECONDS = "3600"
   ```
   `SITE_HOST` matters: the `atlas-systems.uk` zone also serves `api.atlas-systems.uk` (this Worker, `atlas-notify`, `github-pulse`) and `cv.atlas-systems.uk`. Without filtering by hostname, "visits" silently includes API call volume and the CV viewer, not just the portfolio site.

5. **Set the secret and deploy:**
   ```bash
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   npx wrangler deploy
   ```

## Usage

| Method and path | Returns |
|---|---|
| `GET /site-pulse` | Visit totals, hourly breakdown, and top pages for the last 24 hours |
| `GET /site-pulse/health` | Liveness probe (no auth) |

Response shape:

```json
{
  "generatedAt": "2026-06-17T18:51:15.536Z",
  "rangeHours": 24,
  "totalVisits": 79,
  "byHour": [{ "hour": "2026-06-17T08:00:00Z", "visits": 28 }],
  "topPages": [{ "path": "/", "requests": 58 }]
}
```

**Why 24 hours, not 30 days.** Free-tier Cloudflare zones cap `httpRequestsAdaptiveGroups` queries at a 1-day window per call. An earlier version of this Worker tried to request a rolling 30-day history in one query and was rejected outright by the platform's own quota check. Rather than fight that limit with dozens of stitched-together queries and risk a second limit (max fields per request), the honest scope here is a real 24-hour snapshot, refreshed hourly via cache. A genuine multi-day history is a real future upgrade, gated on either a paid plan or a proper multi-call aggregation, not something to fake by quietly excluding data.

**What "visits" actually counts.** Filtered to `requestSource: eyeball` (real browser-originated traffic, not Cloudflare's own edge/bot traffic) and to `clientRequestHTTPHost: atlas-systems.uk` specifically. It will still include basic automated scanners that present as ordinary browsers, paths like `/.env` or `/.aws/credentials` showing up in `topPages` are scanner noise hitting every public domain on the internet, not real visitors, and not a sign anything is misconfigured.

Caching follows the same pattern as `github-pulse`: the `x-pulse-cache` header reads `HIT` or `MISS`, entries expire after an hour (`CACHE_TTL_SECONDS`).

## How it fits into Atlas Systems

This is the visitor-facing counterpart to `github-pulse`'s commit-facing stats: one shows what you've built, this shows whether anyone's looking at it. Both share the exact same proxy-and-cache shape, and `weekly-digest.yml` in [`atlas-systems`](https://github.com/AtlasReaper311/atlas-systems) pulls a snapshot from this endpoint into the weekly Discord summary alongside commit activity.

The transferable pattern, beyond backend-for-frontend itself: platform limits discovered mid-build (a 1-day query cap, a permission group that looks right but isn't) are worth documenting in the README that ships, not just fixed quietly and forgotten. The next person debugging this exact error gets the answer in one read instead of five failed token configurations.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
