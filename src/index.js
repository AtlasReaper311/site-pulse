/**
 * site-pulse
 *
 * Read-only proxy between atlas-systems.uk and Cloudflare's GraphQL
 * Analytics API. Same backend-for-frontend shape as github-pulse: the
 * site fetches one clean JSON document; this Worker holds the
 * analytics-scoped API token and handles caching, so the token never
 * reaches the browser and a burst of visitors costs one upstream
 * query, not one per page view.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_KEY = "site-pulse:summary";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      return json(200, { ok: true, service: "site-pulse" });
    }

    if (request.method !== "GET") {
      return json(405, { ok: false, error: "GET only" }, { Allow: "GET" });
    }

    if (!env.CLOUDFLARE_API_TOKEN || !env.ZONE_TAG) {
      return json(500, { ok: false, error: "Cloudflare credentials are not configured" });
    }

    const ttlSeconds = Number(env.CACHE_TTL_SECONDS || 3600);
    const cached = await env.PULSE_CACHE.get(CACHE_KEY, { type: "json" });
    if (cached) {
      return json(200, cached, { "x-pulse-cache": "HIT" });
    }

    let summary;
    try {
      summary = await fetchAnalytics(env);
    } catch (err) {
      return json(502, {
        ok: false,
        error: "Cloudflare Analytics API request failed",
        detail: String(err?.message ?? err),
      });
    }

    await env.PULSE_CACHE.put(CACHE_KEY, JSON.stringify(summary), { expirationTtl: ttlSeconds });
    return json(200, summary, { "x-pulse-cache": "MISS" });
  },
};

async function fetchAnalytics(env) {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const query = `
    query SitePulse($zoneTag: string!, $start: Time!, $end: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          total: httpRequestsAdaptiveGroups(
            limit: 1
            filter: { datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball" }
          ) {
            sum { visits }
          }
          byDay: httpRequestsAdaptiveGroups(
            limit: 31
            orderBy: [datetimeDay_ASC]
            filter: { datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball" }
          ) {
            sum { visits }
            dimensions { datetimeDay }
          }
          topPages: httpRequestsAdaptiveGroups(
            limit: 10
            orderBy: [count_DESC]
            filter: { datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball" }
          ) {
            count
            dimensions { clientRequestPath }
          }
        }
      }
    }
  `;

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { zoneTag: env.ZONE_TAG, start: start.toISOString(), end: now.toISOString() },
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(data.errors.map((e) => e.message).join("; "));
  }

  const zone = data?.data?.viewer?.zones?.[0];
  const totalVisits = zone?.total?.[0]?.sum?.visits ?? 0;
  const byDay = (zone?.byDay ?? []).map((row) => ({
    date: row.dimensions.datetimeDay,
    visits: row.sum.visits,
  }));
  const topPages = (zone?.topPages ?? []).map((row) => ({
    path: row.dimensions.clientRequestPath,
    requests: row.count,
  }));

  return { generatedAt: now.toISOString(), rangeDays: 30, totalVisits, byDay, topPages };
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
