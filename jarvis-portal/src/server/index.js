const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      return json({
        status: "ok",
        service: "jarvis-portal-api",
        stage: "foundation"
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("JARVIS Portal assets are not configured.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
