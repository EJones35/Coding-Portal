const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const ADMIN_EMAIL = "ethan@garyjones.co.uk";

let cachedGoogleKeys = null;
let cachedGoogleKeysAt = 0;

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(jsonHeaders);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}

function base64url(data) {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return base64url(new Uint8Array(digest));
}

async function pkceChallenge(verifier) {
  return sha256(verifier);
}

function cookies(request) {
  const result = {};

  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name && !(name in result)) {
      result[name] = value;
    }
  }

  return result;
}

function cookieName(request, name) {
  return new URL(request.url).protocol === "https:"
    ? `__Host-${name}`
    : name;
}

function setCookie(request, name, value, options = {}) {
  const secure = new URL(request.url).protocol === "https:";
  const parts = [
    `${cookieName(request, name)}=${value}`,
    "Path=/",
    "SameSite=Lax"
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");

  return parts.join("; ");
}

function redirectResponse(url, request, extraCookies = []) {
  const headers = new Headers({
    location: url.toString(),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer"
  });

  for (const value of extraCookies) {
    headers.append("set-cookie", value);
  }

  return new Response(null, { status: 303, headers });
}

function homeRedirect(request, error) {
  const target = new URL("/", request.url);
  if (error) target.searchParams.set("auth_error", error);
  return target;
}

function safeRedirectPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    return "/";
  }

  return value;
}

async function googleKeys() {
  if (cachedGoogleKeys && Date.now() - cachedGoogleKeysAt < 60 * 60 * 1000) {
    return cachedGoogleKeys;
  }

  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
    headers: { accept: "application/json" }
  });

  if (!response.ok) throw new Error("Google signing keys unavailable");

  const data = await response.json();
  if (!Array.isArray(data.keys)) {
    throw new Error("Invalid Google signing keys");
  }

  cachedGoogleKeys = data.keys;
  cachedGoogleKeysAt = Date.now();
  return cachedGoogleKeys;
}

async function verifyGoogleIdToken(token, expectedNonce, clientId) {
  if (typeof token !== "string" || token.length > 12000) {
    throw new Error("Invalid identity token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid identity token");

  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64url(parts[0]))
  );
  const claims = JSON.parse(
    new TextDecoder().decode(decodeBase64url(parts[1]))
  );

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Unsupported identity token");
  }

  const key = (await googleKeys()).find(item => item.kid === header.kid);
  if (!key) throw new Error("Unknown Google signing key");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    key,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!validSignature) throw new Error("Invalid identity signature");

  const now = Math.floor(Date.now() / 1000);
  const validIssuer = [
    "https://accounts.google.com",
    "accounts.google.com"
  ].includes(claims.iss);

  if (
    !validIssuer ||
    claims.aud !== clientId ||
    (claims.azp && claims.azp !== clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    claims.iat < now - 3600 ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.nonce !== expectedNonce ||
    claims.email_verified !== true ||
    typeof claims.email !== "string"
  ) {
    throw new Error("Identity token claims were invalid");
  }

  return {
    subject: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === "string" ? claims.name.slice(0, 200) : null,
    picture: typeof claims.picture === "string" ? claims.picture : null
  };
}

async function getCurrentSession(request, env) {
  if (!env.DB) return null;

  const jar = cookies(request);
  const sessionToken = jar[cookieName(request, "csp_session")];

  if (!sessionToken || sessionToken.length > 200) return null;

  const idHash = await sha256(sessionToken);
  const result = await env.DB.prepare(`
    SELECT
      s.id_hash, s.csrf_token_hash, s.expires_at,
      u.id, u.provider_name, u.preferred_name, u.display_name_override,
      u.profile_picture_key, u.role, u.status, u.created_at,
      u.last_sign_in_at
    FROM server_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ?
  `).bind(idHash).first();

  if (!result) return null;

  if (
    !Number.isFinite(Date.parse(result.expires_at)) ||
    Date.parse(result.expires_at) <= Date.now() ||
    result.status !== "active"
  ) {
    await env.DB.prepare("DELETE FROM server_sessions WHERE id_hash = ?")
      .bind(idHash).run();
    return null;
  }

  return { ...result, sessionToken };
}

async function requireCsrf(request, session) {
  const jar = cookies(request);
  const csrf = jar[cookieName(request, "csp_csrf")];
  const supplied = request.headers.get("x-csrf-token");

  if (
    !csrf ||
    !supplied ||
    csrf.length > 200 ||
    supplied !== csrf ||
    (await sha256(csrf)) !== session.csrf_token_hash
  ) {
    return false;
  }

  return true;
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.display_name_override || row.preferred_name || row.provider_name || "User",
    role: row.role,
    profilePictureKey: row.profile_picture_key,
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at
  };
}

async function beginGoogle(request, env) {
  if (!env.DB || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: "Google sign-in is not configured" }, 503);
  }

  const url = new URL(request.url);
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const browserToken = randomToken();

  const stateHash = await sha256(state);
  const browserHash = await sha256(browserToken);
  const expiresAt = new Date(Date.now() + OAUTH_SECONDS * 1000).toISOString();
  const redirectAfter = safeRedirectPath(url.searchParams.get("next") || "/");

  await env.DB.prepare(`
    INSERT INTO oauth_transactions
      (state_hash, provider, code_verifier, redirect_after,
       expires_at, browser_token_hash, nonce)
    VALUES (?, 'google', ?, ?, ?, ?, ?)
  `).bind(
    stateHash,
    verifier,
    redirectAfter,
    expiresAt,
    browserHash,
    nonce
  ).run();

  const challenge = await pkceChallenge(verifier);
  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  authorize.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("prompt", "select_account");

  return redirectResponse(authorize, request, [
    setCookie(request, "csp_oauth_browser", browserToken, {
      httpOnly: true,
      maxAge: OAUTH_SECONDS
    })
  ]);
}

async function completeGoogle(request, env) {
  const url = new URL(request.url);
  const failure = homeRedirect(request, "google_signin_failed");

  if (url.searchParams.has("error")) {
    return redirectResponse(homeRedirect(request, "google_signin_cancelled"), request, [
      setCookie(request, "csp_oauth_browser", "", { maxAge: 0, httpOnly: true })
    ]);
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const jar = cookies(request);
  const browserToken = jar[cookieName(request, "csp_oauth_browser")];

  if (
    !state ||
    !code ||
    !browserToken ||
    state.length > 500 ||
    code.length > 4000
  ) {
    return redirectResponse(failure, request);
  }

  const stateHash = await sha256(state);
  const browserHash = await sha256(browserToken);

  // Atomically consume a valid transaction so only one callback can use it.
  const transaction = await env.DB.prepare(`
    DELETE FROM oauth_transactions
    WHERE state_hash = ?
      AND provider = 'google'
      AND browser_token_hash = ?
      AND nonce IS NOT NULL
      AND expires_at > ?
    RETURNING state_hash, code_verifier, redirect_after, expires_at,
              browser_token_hash, nonce
  `).bind(stateHash, browserHash, new Date().toISOString()).first();

  if (!transaction) {
    return redirectResponse(failure, request);
  }

  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: transaction.code_verifier
    })
  });

  if (!tokenResponse.ok) {
    return redirectResponse(failure, request);
  }

  const tokenData = await tokenResponse.json();
  const identity = await verifyGoogleIdToken(
    tokenData.id_token,
    transaction.nonce,
    env.GOOGLE_CLIENT_ID
  );

  const existing = await env.DB.prepare(`
    SELECT u.id
    FROM auth_identities a
    JOIN users u ON u.id = a.user_id
    WHERE a.provider = 'google' AND a.provider_subject = ?
  `).bind(identity.subject).first();

  let userId = existing?.id;

  if (!userId) {
    userId = crypto.randomUUID();

    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO users (id, provider_name, preferred_name, last_sign_in_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(userId, identity.name, identity.name),
        env.DB.prepare(`
          INSERT INTO auth_identities
            (id, user_id, provider, provider_subject, provider_username, provider_email, last_used_at)
          VALUES (?, ?, 'google', ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(crypto.randomUUID(), userId, identity.subject, identity.name, identity.email)
      ]);
    } catch {
      const raced = await env.DB.prepare(`
        SELECT user_id FROM auth_identities
        WHERE provider = 'google' AND provider_subject = ?
      `).bind(identity.subject).first();

      if (!raced) throw new Error("Unable to create user identity");
      userId = raced.user_id;
    }
  } else {
    await env.DB.prepare(`
      UPDATE auth_identities
      SET provider_username = ?, provider_email = ?, last_used_at = CURRENT_TIMESTAMP
      WHERE provider = 'google' AND provider_subject = ?
    `).bind(identity.name, identity.email, identity.subject).run();

    await env.DB.prepare(`
      UPDATE users SET last_sign_in_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(userId).run();
  }

  // The one-time bootstrap can only be triggered by the verified configured email.
  if (identity.email === ADMIN_EMAIL) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO app_settings (key, value_json)
      VALUES ('initial_admin_claimed', ?)
    `).bind(JSON.stringify(userId)).run();

    const claim = await env.DB.prepare(`
      SELECT value_json FROM app_settings WHERE key = 'initial_admin_claimed'
    `).first();

    if (claim?.value_json === JSON.stringify(userId)) {
      await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
        .bind(userId).run();
    }
  }

  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO server_sessions (id_hash, user_id, csrf_token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(
    await sha256(sessionToken),
    userId,
    await sha256(csrfToken),
    expiresAt
  ).run();

  await env.DB.prepare(`
    INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
    VALUES (?, ?, 'auth.google.sign_in', 'user', ?)
  `).bind(crypto.randomUUID(), userId, userId).run();

  const target = new URL(
    safeRedirectPath(transaction.redirect_after),
    url.origin
  );

  return redirectResponse(target, request, [
    setCookie(request, "csp_oauth_browser", "", { maxAge: 0, httpOnly: true }),
    setCookie(request, "csp_session", sessionToken, {
      httpOnly: true,
      maxAge: SESSION_SECONDS
    }),
    setCookie(request, "csp_csrf", csrfToken, {
      maxAge: SESSION_SECONDS
    })
  ]);
}

async function logout(request, env) {
  const session = await getCurrentSession(request, env);
  const headers = new Headers(jsonHeaders);

  headers.append("set-cookie", setCookie(request, "csp_session", "", {
    httpOnly: true,
    maxAge: 0
  }));
  headers.append("set-cookie", setCookie(request, "csp_csrf", "", {
    maxAge: 0
  }));

  if (!session) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers
    });
  }

  if (!(await requireCsrf(request, session))) {
    return json({ error: "Invalid CSRF token" }, 403);
  }

  await env.DB.prepare("DELETE FROM server_sessions WHERE id_hash = ?")
    .bind(session.id_hash).run();

  await env.DB.prepare(`
    INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
    VALUES (?, ?, 'auth.sign_out', 'user', ?)
  `).bind(crypto.randomUUID(), session.id, session.id).run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return json({ error: "Method not allowed" }, 405, {
          allow: "GET, POST"
        });
      }

      if (url.pathname === "/api/health") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        return json({
          status: "ok",
          service: "coding-sessions-portal-api",
          stage: "google-authentication"
        });
      }

      if (url.pathname === "/api/auth/google") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        try {
          return await beginGoogle(request, env);
        } catch {
          return json({ error: "Unable to start Google sign-in" }, 500);
        }
      }

      if (url.pathname === "/api/auth/google/callback") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        try {
          if (!env.DB || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
            return json({ error: "Google sign-in is not configured" }, 503);
          }

          return await completeGoogle(request, env);
        } catch {
          return redirectResponse(
            homeRedirect(request, "google_signin_failed"),
            request,
            [
              setCookie(request, "csp_oauth_browser", "", {
                maxAge: 0,
                httpOnly: true
              })
            ]
          );
        }
      }

      if (url.pathname === "/api/auth/me") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        const session = await getCurrentSession(request, env);
        if (!session) return json({ user: null });

        return json({ user: publicUser(session) });
      }

      if (url.pathname === "/api/auth/logout") {
        if (request.method !== "POST") {
          return json({ error: "Method not allowed" }, 405);
        }

        try {
          return await logout(request, env);
        } catch {
          return json({ error: "Unable to sign out" }, 500);
        }
      }

      return json({ error: "Not found" }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Coding Sessions Portal assets are not configured.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
