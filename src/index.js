const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_KEY = "site-pulse:summary";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/health")) {
  return json(200, { ok: true, service: "atlas-notify" }, { "Access-Control-Allow-Origin": "https://status.atlas-systems.uk" });
}

    if (request.method === "GET" && url.pathname.endsWith("/weekly")) {
      return await handleWeekly(env);
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

  // Runs once a day per the cron in wrangler.toml. Computes that day's
  // real 24h visit total and stores it under a dated key, working
  // around the platform's 1-day query window by accumulating daily
  // snapshots instead of trying to query a longer range in one call.
  async scheduled(event, env, ctx) {
    const summary = await fetchAnalytics(env);
    const today = new Date().toISOString().slice(0, 10);
    await env.PULSE_CACHE.put(
      `site-pulse:daily:${today}`,
      JSON.stringify({ date: today, visits: summary.totalVisits }),
      { expirationTtl: 60 * 60 * 24 * 40 } // keep 40 days, comfortably more than the 7 a rolling week needs
    );
  },
};

async function handleWeekly(env) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const entry = await env.PULSE_CACHE.get(`site-pulse:daily:${date}`, { type: "json" });
    days.push({ date, visits: entry?.visits ?? null });
  }
  days.reverse(); // oldest to newest

  const known = days.filter((d) => d.visits !== null);
  const totalVisits = known.reduce((sum, d) => sum + d.visits, 0);

  return json(200, {
    generatedAt: new Date().toISOString(),
    daysCollected: known.length,
    totalVisits,
    days,
  });
}

async function fetchAnalytics(env) {
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const host = env.SITE_HOST || "atlas-systems.uk";

  const query = `
    query SitePulse($zoneTag: string!, $start: Time!, $end: Time!, $host: string!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          total: httpRequestsAdaptiveGroups(
            limit: 1
            filter: { datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball", clientRequestHTTPHost: $host }
          ) {
            sum { visits }
          }
          byHour: httpRequestsAdaptiveGroups(
            limit: 24
            orderBy: [datetimeHour_ASC]
            filter: { datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball", clientRequestHTTPHost: $host }
          ) {
            sum { visits }
            dimensions { datetimeHour }
          }
          topPages: httpRequestsAdaptiveGroups(
            limit: 10
            orderBy: [count_DESC]
            filter: { datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball", clientRequestHTTPHost: $host }
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
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { zoneTag: env.ZONE_TAG, start: start.toISOString(), end: now.toISOString(), host },
    }),
  });

  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map((e) => e.message).join("; "));

  const zone = data?.data?.viewer?.zones?.[0];
  const totalVisits = zone?.total?.[0]?.sum?.visits ?? 0;
  const byHour = (zone?.byHour ?? []).map((row) => ({ hour: row.dimensions.datetimeHour, visits: row.sum.visits }));
  const topPages = (zone?.topPages ?? []).map((row) => ({ path: row.dimensions.clientRequestPath, requests: row.count }));

  return { generatedAt: now.toISOString(), rangeHours: 24, totalVisits, byHour, topPages };
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
