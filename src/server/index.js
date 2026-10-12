const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const ADMIN_EMAIL = "ethan@garyjones.co.uk";

// Profile pictures are stored inline in D1, so the accepted payload is small.
// Enforced again on the client; both limits must stay in step.
const MAX_PICTURE_BYTES = 350 * 1024;
const MAX_PICTURE_REQUEST_BYTES = 500 * 1024;

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

// A blocked sign-in needs to carry its reason back to the page without putting
// it in the URL, where it would sit in history and in any referrer. HttpOnly
// cookie, read once by GET /api/auth/blocked and cleared in the same response.
function setBlockedCookie(request, status, reason) {
  const payload = base64url(
    new TextEncoder().encode(`${status}:${String(reason || "").slice(0, 500)}`)
  );

  return setCookie(request, "csp_blocked", payload, {
    httpOnly: true,
    maxAge: 300
  });
}

function readBlockedCookie(request) {
  const raw = cookies(request)[cookieName(request, "csp_blocked")];
  if (!raw || raw.length > 2000) return null;

  let decoded = "";
  try {
    decoded = new TextDecoder().decode(decodeBase64url(raw));
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 1) return null;

  return {
    status: decoded.slice(0, separator),
    reason: decoded.slice(separator + 1)
  };
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
      ${publicUserColumns("u")}
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

// One shared projection for the user shape returned to the browser. `{p}` is
// replaced with an optional table alias so the session join and the standalone
// user lookup can never drift apart.
const USER_PUBLIC_COLUMNS = `{p}id, {p}provider_name, {p}preferred_name,
  {p}display_name_override, {p}status, {p}role, {p}picture_version,
  ({p}profile_picture_data IS NOT NULL) AS has_profile_picture,
  length({p}profile_picture_data) AS profile_picture_length,
  {p}created_at, {p}updated_at, {p}last_sign_in_at`;

function publicUserColumns(prefix = "") {
  return USER_PUBLIC_COLUMNS.replaceAll("{p}", prefix ? `${prefix}.` : "");
}

// The picture itself never leaves D1 as a data URL. Clients receive a
// versioned URL for an authenticated image endpoint instead. The version is a
// random token rewritten on every picture change, so a new picture always
// means a new URL and a browser can never reuse an obsolete decode. The
// updated_at/length fallback only applies to rows written before that column
// existed.
function profilePictureVersion(row) {
  if (row.picture_version) return String(row.picture_version);

  const stamp = String(row.updated_at || "").replace(/[^0-9]/g, "");
  return `${stamp}-${Number(row.profile_picture_length) || 0}`;
}

function avatarUrl(row) {
  return `/api/avatars/${encodeURIComponent(row.id)}` +
    `?v=${encodeURIComponent(profilePictureVersion(row))}`;
}

// A group's picture is versioned from its row's updated_at *and* the byte
// length of the stored image. updated_at alone only has one-second resolution,
// so two pictures uploaded inside the same second would produce the same URL
// and the browser would happily reuse a stale decode. Exactly the bug the
// member avatar had.
function groupPictureUrl(group) {
  if (group.picture_version) {
    return `/api/group-avatars/${encodeURIComponent(group.id)}?v=${encodeURIComponent(group.picture_version)}`;
  }

  const stamp = String(group.updated_at || "").replace(/[^0-9]/g, "");
  const size = Number(group.picture_length) || 0;
  return `/api/group-avatars/${encodeURIComponent(group.id)}?v=${stamp}-${size}`;
}

// Resolves the data URL a stored picture was written as, with the same strict
// allow-list the upload path enforces. Anything else is treated as absent.
function decodeStoredPicture(stored) {
  if (typeof stored !== "string") return null;

  const match = stored.match(
    /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/
  );
  if (!match) return null;

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { type: match[1], bytes };
}

function pictureResponse(picture) {
  return new Response(picture.bytes, {
    headers: {
      "content-type": picture.type,
      "content-length": String(picture.bytes.length),
      // Private: rendered only for a signed-in member, and the version query
      // parameter is what defeats a stale decode.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer"
    }
  });
}

function publicUser(row) {
  const hasPicture = Boolean(row.has_profile_picture);

  return {
    id: row.id,
    name: row.display_name_override || row.preferred_name || row.provider_name || "User",
    role: row.role,
    status: row.status,
    hasProfilePicture: hasPicture,
    avatarUrl: hasPicture ? avatarUrl(row) : null,
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

  // An account that has been suspended or marked for deletion must not be
  // handed a session. Before this check a suspended member was signed out and
  // could simply sign back in, which made suspension meaningless.
  const account = await env.DB.prepare(
    "SELECT id, status, status_reason FROM users WHERE id = ?"
  ).bind(userId).first();

  if (account && account.status !== "active") {
    await env.DB.prepare(`
      INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details_json)
      VALUES (?, ?, 'auth.sign_in.blocked', 'user', ?, ?)
    `).bind(
      randomToken(18),
      userId,
      userId,
      JSON.stringify({ status: account.status })
    ).run();

    return redirectResponse(
      homeRedirect(request, `account_${account.status}`),
      request,
      [
        setCookie(request, "csp_oauth_browser", "", { maxAge: 0, httpOnly: true }),
        setBlockedCookie(request, account.status, account.status_reason)
      ]
    );
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


async function handleAccountApi(request, env, url) {
  const session = await getCurrentSession(request, env);
  if (!session) return json({ error: "Authentication required" }, 401);

  async function currentUserRow() {
    return env.DB.prepare(
      `SELECT ${publicUserColumns()} FROM users WHERE id = ?`
    ).bind(session.id).first();
  }

  if (url.pathname === "/api/account" && request.method === "GET") {
    return json({ user: publicUser(await currentUserRow()) });
  }

  if (url.pathname === "/api/account/profile" && request.method === "PATCH") {
    if (!(await requireCsrf(request, session))) {
      return json({ error: "Security token invalid. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid request" }, 400);
    }

    // The target is always the signed-in account. A caller-supplied user id is
    // refused outright rather than quietly ignored.
    if (body.userId !== undefined || body.id !== undefined) {
      return json({ error: "You can only change your own profile" }, 403);
    }

    if (typeof body.displayName !== "string") {
      return json({ error: "Enter a display name" }, 400);
    }

    const displayName = body.displayName.trim();

    if (displayName.length < 1 || displayName.length > 80) {
      return json({ error: "Display name must be between 1 and 80 characters" }, 400);
    }

    await env.DB.prepare(`
      UPDATE users
      SET display_name_override = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(displayName, session.id).run();

    await writeAudit(env, session.id, "account.profile.updated", session.id, {
      displayName
    });

    return json({ ok: true, user: publicUser(await currentUserRow()) });
  }

  if (url.pathname === "/api/account/profile-picture" && request.method === "PUT") {
    if (!(await requireCsrf(request, session))) {
      return json({ error: "Security token invalid. Refresh and try again." }, 403);
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PICTURE_REQUEST_BYTES) {
      return json({ error: "Choose an image smaller than 350 KB" }, 413);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "Choose a valid image file" }, 400);
    }

    const file = form.get("picture");

    if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") {
      return json({ error: "Choose an image file" }, 400);
    }

    if (!Number.isFinite(file.size) || file.size < 1) {
      return json({ error: "That file is empty" }, 400);
    }

    if (file.size > MAX_PICTURE_BYTES) {
      return json({ error: "Choose an image smaller than 350 KB" }, 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    // The declared type is never trusted: the signature decides.
    const type = detectImageType(bytes);

    if (!type) {
      return json({ error: "Use a PNG, JPEG, WebP or GIF image" }, 415);
    }

    // Every check has passed, so this single statement is the only thing that
    // can replace the stored image. A rejected upload never reaches it.
    await env.DB.prepare(`
      UPDATE users
      SET profile_picture_data = ?, profile_picture_key = NULL,
          picture_version = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(toDataUrl(bytes, type), randomToken(9), session.id).run();

    await writeAudit(env, session.id, "account.profile_picture.updated", session.id, {
      bytes: bytes.length,
      format: type
    });

    return json({ ok: true, user: publicUser(await currentUserRow()) });
  }

  if (url.pathname === "/api/account/profile-picture" && request.method === "DELETE") {
    if (!(await requireCsrf(request, session))) {
      return json({ error: "Security token invalid. Refresh and try again." }, 403);
    }

    await env.DB.prepare(`
      UPDATE users
      SET profile_picture_data = NULL, profile_picture_key = NULL,
          picture_version = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(randomToken(9), session.id).run();

    await writeAudit(env, session.id, "account.profile_picture.removed", session.id);

    return json({ ok: true, user: publicUser(await currentUserRow()) });
  }

  if (url.pathname === "/api/account" && request.method === "DELETE") {
    if (!(await requireCsrf(request, session))) {
      return json({ error: "Security token invalid. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Confirmation required" }, 400);
    }

    // Checked here as well as in the browser: the client is not the gate.
    if (!body || typeof body !== "object" || body.confirmation !== "DELETE") {
      return json({ error: "Type DELETE to confirm permanent account deletion" }, 400);
    }

    if (session.role === "admin") {
      const admins = await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM users WHERE role = 'admin' AND status = 'active'
      `).first();

      if (!admins || Number(admins.count) <= 1) {
        return json({
          error: "The last active administrator cannot delete their account. Promote another administrator first."
        }, 409);
      }
    }

    // Recorded while the actor still exists, then anonymised in the batch
    // below, so the audit trail survives without keeping personal data.
    await writeAudit(env, session.id, "account.deleted", session.id, {
      permanent: true,
      hadProfilePicture: Boolean(session.has_profile_picture)
    });

    const userId = session.id;

    // One transaction. Attendance rows belong to the departing account and
    // cannot exist without it; sessions they created and the marks they left
    // are kept but detached; the audit trail is detached, never erased.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session_attendance WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM group_members WHERE user_id = ? OR added_by = ?").bind(userId, userId),
      env.DB.prepare("DELETE FROM session_access WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM achievement_awards WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM achievement_user_visibility WHERE user_id = ?").bind(userId),
      env.DB.prepare("UPDATE session_attendance SET marked_by = NULL WHERE marked_by = ?").bind(userId),
      env.DB.prepare("UPDATE coding_sessions SET created_by = NULL WHERE created_by = ?").bind(userId),
      env.DB.prepare("UPDATE coding_sessions SET created_by = NULL WHERE created_by = ?").bind(userId),
      env.DB.prepare("DELETE FROM server_sessions WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM auth_identities WHERE user_id = ?").bind(userId),
      env.DB.prepare("UPDATE audit_log SET actor_user_id = NULL WHERE actor_user_id = ?").bind(userId),
      env.DB.prepare("UPDATE users SET profile_picture_data = NULL, profile_picture_key = NULL WHERE id = ?").bind(userId),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
    ]);

    const headers = new Headers(jsonHeaders);
    headers.append("set-cookie", setCookie(request, "csp_session", "", {
      httpOnly: true,
      maxAge: 0
    }));
    headers.append("set-cookie", setCookie(request, "csp_csrf", "", { maxAge: 0 }));

    return new Response(JSON.stringify({ ok: true, deleted: true }), {
      status: 200,
      headers
    });
  }

  if ([
    "/api/account/profile",
    "/api/account/profile-picture",
    "/api/account"
  ].includes(url.pathname)) {
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

function toDataUrl(bytes, type) {
  let binary = "";
  const chunk = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }

  return `data:${type};base64,${btoa(binary)}`;
}

// Only these four containers are ever accepted or served. SVG, HTML and
// anything scriptable cannot match, so they are rejected whatever the
// filename or declared MIME type says.
function detectImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
      bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) return "image/gif";
  return null;
}

async function serveProfilePicture(request, env, url) {
  const session = await getCurrentSession(request, env);
  if (!session) return json({ error: "Authentication required" }, 401);

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const match = url.pathname.match(/^\/api\/avatars\/([^/]+)$/);
  if (!match) return json({ error: "Not found" }, 404);

  const userId = decodeURIComponent(match[1]);
  if (!userId || userId.length > 200) return json({ error: "Invalid user ID" }, 400);

  const row = await env.DB.prepare(`
    SELECT ${publicUserColumns()}, profile_picture_data
    FROM users
    WHERE id = ? AND status = 'active'
  `).bind(userId).first();

  const picture = decodeStoredPicture(row?.profile_picture_data);
  if (!picture) return json({ error: "Profile picture not found" }, 404);

  return pictureResponse(picture);
}

async function serveGroupPicture(request, env, url) {
  const session = await getCurrentSession(request, env);
  if (!session) return json({ error: "Authentication required" }, 401);

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const match = url.pathname.match(/^\/api\/group-avatars\/([^/]+)$/);
  if (!match) return json({ error: "Not found" }, 404);

  const groupId = decodeURIComponent(match[1]);
  if (!groupId || groupId.length > 200) return json({ error: "Invalid group ID" }, 400);

  const row = await env.DB.prepare(
    "SELECT picture_data FROM portal_groups WHERE id = ?"
  ).bind(groupId).first();

  const picture = decodeStoredPicture(row?.picture_data);
  if (!picture) return json({ error: "Group picture not found" }, 404);

  return pictureResponse(picture);
}

async function adminSession(request, env) {
  const session = await getCurrentSession(request, env);
  if (!session) return { error: json({ error: "Authentication required" }, 401) };
  if (session.role !== "admin" || session.status !== "active") {
    return { error: json({ error: "Administrator access required" }, 403) };
  }
  return { session };
}

async function writeAudit(env, actorId, action, targetId, details = {}, targetType = "user") {
  await env.DB.prepare(`
    INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(randomToken(18), actorId, action, targetType, targetId, JSON.stringify(details)).run();
}

// State-changing calls answer with the stored record rather than a bare `ok`.
// The settings UI saves on every keystroke, so it needs the canonical values
// back to prove the change actually landed.
async function readAdminSession(env, sessionId) {
  const row = await env.DB.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM session_attendance a
       WHERE a.session_id = s.id AND a.status IN ('present', 'late'))
        AS attendance_count,
      (SELECT COUNT(*) FROM session_attendance a
       WHERE a.session_id = s.id) AS marked_count
    FROM coding_sessions s
    WHERE s.id = ?
  `).bind(sessionId).first();

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    status: row.status,
    createdAt: row.created_at,
    attendanceCount: row.attendance_count,
    markedCount: row.marked_count,
    access: await readSessionAccess(env, sessionId)
  };
}

// Who may see a session. No rows at all means open to every signed-in member.
async function readSessionAccess(env, sessionId) {
  const users = await env.DB.prepare(`
    SELECT u.id, u.display_name_override, u.preferred_name, u.provider_name
    FROM session_access a
    JOIN users u ON u.id = a.user_id
    WHERE a.session_id = ?
    ORDER BY COALESCE(u.display_name_override, u.preferred_name, u.provider_name) COLLATE NOCASE
  `).bind(sessionId).all();

  const groups = await env.DB.prepare(`
    SELECT g.id, g.name
    FROM session_group_access a
    JOIN portal_groups g ON g.id = a.group_id
    WHERE a.session_id = ?
    ORDER BY g.name COLLATE NOCASE
  `).bind(sessionId).all();

  const userList = (users.results || []).map(row => ({
    id: row.id,
    name: row.display_name_override || row.preferred_name || row.provider_name || "User"
  }));
  const groupList = (groups.results || []).map(row => ({ id: row.id, name: row.name }));

  return {
    restricted: userList.length > 0 || groupList.length > 0,
    users: userList,
    groups: groupList
  };
}

// ---------------------------------------------------------------------------
// The signed-in user's own profile page
// ---------------------------------------------------------------------------

// Who may see a session. Written once and reused by every count and listing,
// so the "sessions you can attend" number can never disagree with the list it
// is counting. Parameter order: {alias}, seesEverything, userId, userId.
const SESSION_VISIBILITY_SQL = `(
  ? = 1
  OR (
    NOT EXISTS (SELECT 1 FROM session_access sa WHERE sa.session_id = {a}.id)
    AND NOT EXISTS (SELECT 1 FROM session_group_access sg WHERE sg.session_id = {a}.id)
  )
  OR EXISTS (SELECT 1 FROM session_access sa
             WHERE sa.session_id = {a}.id AND sa.user_id = ?)
  OR EXISTS (SELECT 1 FROM session_group_access sg
             JOIN group_members gm ON gm.group_id = sg.group_id
             WHERE sg.session_id = {a}.id AND gm.user_id = ?)
)`;

function sessionVisibility(alias = "s") {
  return SESSION_VISIBILITY_SQL.replaceAll("{a}", alias);
}

// The audience of one session: which members are on it. Used to decide who the
// attendance register lists. No administrator bypass here on purpose - a
// register that lists the whole portal is what this exists to prevent.
const SESSION_AUDIENCE_SQL = `(
  (
    NOT EXISTS (SELECT 1 FROM session_access sa WHERE sa.session_id = ?)
    AND NOT EXISTS (SELECT 1 FROM session_group_access sg WHERE sg.session_id = ?)
  )
  OR EXISTS (SELECT 1 FROM session_access sa
             WHERE sa.session_id = ? AND sa.user_id = u.id)
  OR EXISTS (SELECT 1 FROM session_group_access sg
             JOIN group_members gm ON gm.group_id = sg.group_id
             WHERE sg.session_id = ? AND gm.user_id = u.id)
)`;

// Who may see an achievement. The caller is filtered by their own grants in
// SQL, exactly like session visibility, so a hidden achievement is absent from
// the response rather than hidden by the browser.
const ACHIEVEMENT_VISIBILITY_SQL = `(
  a.mode = 'everyone'
  AND NOT EXISTS (SELECT 1 FROM achievement_user_visibility uv
                  WHERE uv.achievement_id = a.id AND uv.user_id = ? AND uv.visible = 0)
  AND NOT EXISTS (SELECT 1 FROM achievement_group_visibility gv
                  JOIN group_members gm ON gm.group_id = gv.group_id
                  WHERE gv.achievement_id = a.id AND gm.user_id = ? AND gv.visible = 0)
) OR (
  a.mode = 'restricted'
  AND (
    EXISTS (SELECT 1 FROM achievement_user_visibility uv
            WHERE uv.achievement_id = a.id AND uv.user_id = ? AND uv.visible = 1)
    OR EXISTS (SELECT 1 FROM achievement_group_visibility gv
               JOIN group_members gm ON gm.group_id = gv.group_id
               WHERE gv.achievement_id = a.id AND gm.user_id = ? AND gv.visible = 1)
  )
)`;

async function readAchievement(env, row) {
  const awarded = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM achievement_awards WHERE achievement_id = ?
  `).bind(row.id).first();

  const users = await env.DB.prepare(`
    SELECT u.id, u.display_name_override, u.preferred_name, u.provider_name, uv.visible
    FROM achievement_user_visibility uv
    JOIN users u ON u.id = uv.user_id
    WHERE uv.achievement_id = ?
    ORDER BY COALESCE(u.display_name_override, u.preferred_name, u.provider_name) COLLATE NOCASE
  `).bind(row.id).all();

  const groups = await env.DB.prepare(`
    SELECT g.id, g.name, gv.visible
    FROM achievement_group_visibility gv
    JOIN portal_groups g ON g.id = gv.group_id
    WHERE gv.achievement_id = ?
    ORDER BY g.name COLLATE NOCASE
  `).bind(row.id).all();

  const winners = await env.DB.prepare(`
    SELECT u.id, u.display_name_override, u.preferred_name, u.provider_name,
      (u.profile_picture_data IS NOT NULL) AS has_profile_picture,
      length(u.profile_picture_data) AS profile_picture_length,
      u.updated_at, a.granted_at
    FROM achievement_awards a
    JOIN users u ON u.id = a.user_id
    WHERE a.achievement_id = ?
    ORDER BY COALESCE(u.display_name_override, u.preferred_name, u.provider_name) COLLATE NOCASE
  `).bind(row.id).all();

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    mode: row.mode,
    awardCount: awarded.count,
    winners: (winners.results || []).map(user => ({
      id: user.id,
      name: user.display_name_override || user.preferred_name || user.provider_name || "User",
      hasProfilePicture: Boolean(user.has_profile_picture),
      avatarUrl: user.has_profile_picture ? avatarUrl(user) : null,
      grantedAt: user.granted_at
    })),
    // These only ever leave the admin endpoints.
    userVisibility: (users.results || []).map(entry => ({
      id: entry.id,
      name: entry.display_name_override || entry.preferred_name || entry.provider_name || "User",
      visible: Boolean(entry.visible)
    })),
    groupVisibility: (groups.results || []).map(entry => ({
      id: entry.id,
      name: entry.name,
      visible: Boolean(entry.visible)
    }))
  };
}

async function handleAchievementApi(request, env, url) {
  const session = await getCurrentSession(request, env);
  if (!session) return json({ error: "Authentication required" }, 401);

  if (url.pathname === "/api/achievements") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const result = await env.DB.prepare(`
      SELECT a.id, a.name, a.description, a.icon, a.mode,
        EXISTS (SELECT 1 FROM achievement_awards aw
                WHERE aw.achievement_id = a.id AND aw.user_id = ?) AS earned
      FROM achievements a
      WHERE ${ACHIEVEMENT_VISIBILITY_SQL}
      ORDER BY a.name COLLATE NOCASE
      LIMIT 500
    `).bind(
      session.id, session.id, session.id, session.id, session.id
    ).all();

    return json({
      achievements: (result.results || []).map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        icon: row.icon,
        earned: Boolean(row.earned)
      }))
    });
  }

  return json({ error: "Not found" }, 404);
}

async function handleAdminAchievementApi(request, env, url, auth) {
  const visibilityMatch = url.pathname.match(
    /^\/api\/admin\/achievements\/([^/]+)\/visibility\/(users|groups)\/([^/]+)$/
  );

  if (visibilityMatch) {
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    const achievementId = decodeURIComponent(visibilityMatch[1]);
    const kind = visibilityMatch[2];
    const subjectId = decodeURIComponent(visibilityMatch[3]);

    if (!achievementId || achievementId.length > 200 || !subjectId || subjectId.length > 200) {
      return json({ error: "Invalid achievement or subject ID" }, 400);
    }

    const achievement = await env.DB.prepare("SELECT id FROM achievements WHERE id = ?")
      .bind(achievementId).first();
    if (!achievement) return json({ error: "Achievement not found" }, 404);

    const isUser = kind === "users";
    const table = isUser ? "achievement_user_visibility" : "achievement_group_visibility";
    const column = isUser ? "user_id" : "group_id";
    const source = isUser ? "users" : "portal_groups";

    const subject = await env.DB.prepare(
      `SELECT id FROM ${source} WHERE id = ?${isUser ? " AND status = 'active'" : ""}`
    ).bind(subjectId).first();
    if (!subject) return json({ error: `Active ${isUser ? "member" : "group"} not found` }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "visible") ||
        typeof body.visible !== "boolean") {
      return json({ error: "Invalid visibility settings" }, 400);
    }

    await env.DB.prepare(`
      INSERT INTO ${table} (achievement_id, ${column}, visible)
      VALUES (?, ?, ?)
      ON CONFLICT(achievement_id, ${column}) DO UPDATE SET visible = excluded.visible
    `).bind(achievementId, subjectId, body.visible ? 1 : 0).run();

    await writeAudit(env, auth.session.id, "admin.achievement.visibility.updated", achievementId, {
      targetType: "achievement",
      kind,
      subjectId,
      visible: body.visible
    });

    const updated = await env.DB.prepare("SELECT * FROM achievements WHERE id = ?")
      .bind(achievementId).first();

    return json({ ok: true, achievement: await readAchievement(env, updated) });
  }

  const awardMatch = url.pathname.match(
    /^\/api\/admin\/achievements\/([^/]+)\/award\/([^/]+)$/
  );

  if (awardMatch) {
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    const achievementId = decodeURIComponent(awardMatch[1]);
    const userId = decodeURIComponent(awardMatch[2]);

    if (!achievementId || achievementId.length > 200 || !userId || userId.length > 200) {
      return json({ error: "Invalid achievement or member ID" }, 400);
    }

    const achievement = await env.DB.prepare("SELECT id FROM achievements WHERE id = ?")
      .bind(achievementId).first();
    if (!achievement) return json({ error: "Achievement not found" }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "awarded") ||
        typeof body.awarded !== "boolean") {
      return json({ error: "Invalid award details" }, 400);
    }

    if (body.awarded) {
      const target = await env.DB.prepare(
        "SELECT id FROM users WHERE id = ? AND status = 'active'"
      ).bind(userId).first();
      if (!target) return json({ error: "Active member not found" }, 404);

      await env.DB.prepare(`
        INSERT INTO achievement_awards (achievement_id, user_id, granted_by)
        VALUES (?, ?, ?)
        ON CONFLICT(achievement_id, user_id) DO NOTHING
      `).bind(achievementId, userId, auth.session.id).run();
    } else {
      await env.DB.prepare(
        "DELETE FROM achievement_awards WHERE achievement_id = ? AND user_id = ?"
      ).bind(achievementId, userId).run();
    }

    await writeAudit(env, auth.session.id, "admin.achievement.award.updated", achievementId, {
      targetType: "achievement",
      userId,
      awarded: body.awarded
    });

    const updated = await env.DB.prepare("SELECT * FROM achievements WHERE id = ?")
      .bind(achievementId).first();

    return json({ ok: true, achievement: await readAchievement(env, updated) });
  }

  if (url.pathname === "/api/admin/achievements") {
    if (request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT * FROM achievements ORDER BY name COLLATE NOCASE LIMIT 500
      `).all();

      const achievements = [];
      for (const row of result.results || []) {
        achievements.push(await readAchievement(env, row));
      }

      return json({ achievements });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["name", "description", "icon", "mode"].includes(key))) {
      return json({ error: "Invalid achievement details" }, 400);
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 80) {
      return json({ error: "Achievement name must be between 1 and 80 characters" }, 400);
    }

    const description = body.description === undefined ? "" : body.description;
    if (typeof description !== "string" || description.length > 500) {
      return json({ error: "Description must be 500 characters or fewer" }, 400);
    }

    // Icons are text, and deliberately capped to plain characters so nothing
    // exotic can be stored to be rendered back at another member.
    const icon = body.icon === undefined ? "" : body.icon;
    if (typeof icon !== "string" || icon.length > 8 || /[^\x20-\x7E]/.test(icon)) {
      return json({ error: "Icon must be 8 plain characters or fewer" }, 400);
    }

    const mode = body.mode === undefined ? "everyone" : body.mode;
    if (!["everyone", "restricted"].includes(mode)) {
      return json({ error: "Invalid visibility mode" }, 400);
    }

    const id = randomToken(18);

    await env.DB.prepare(`
      INSERT INTO achievements (id, name, description, icon, mode)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, name, description.trim(), icon.trim(), mode).run();

    await writeAudit(env, auth.session.id, "admin.achievement.created", id, {
      targetType: "achievement",
      name
    });

    const created = await env.DB.prepare("SELECT * FROM achievements WHERE id = ?").bind(id).first();
    return json({ ok: true, achievement: await readAchievement(env, created) }, 201);
  }

  const achievementMatch = url.pathname.match(/^\/api\/admin\/achievements\/([^/]+)$/);

  if (achievementMatch) {
    const id = decodeURIComponent(achievementMatch[1]);
    if (!id || id.length > 200) return json({ error: "Invalid achievement ID" }, 400);

    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT * FROM achievements WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "Achievement not found" }, 404);
      return json({ achievement: await readAchievement(env, row) });
    }

    if (request.method === "DELETE") {
      if (!(await requireCsrf(request, auth.session))) {
        return json({ error: "Invalid security token. Refresh and try again." }, 403);
      }

      const row = await env.DB.prepare("SELECT id, name FROM achievements WHERE id = ?")
        .bind(id).first();
      if (!row) return json({ error: "Achievement not found" }, 404);

      await env.DB.prepare("DELETE FROM achievements WHERE id = ?").bind(id).run();
      await writeAudit(env, auth.session.id, "admin.achievement.deleted", id, {
        targetType: "achievement",
        name: row.name
      });

      return json({ ok: true, deleted: true });
    }

    if (request.method !== "PATCH") return json({ error: "Method not allowed" }, 405);
    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length === 0 ||
        Object.keys(body).some(key => !["name", "description", "icon", "mode"].includes(key))) {
      return json({ error: "Invalid achievement details" }, 400);
    }

    const current = await env.DB.prepare("SELECT * FROM achievements WHERE id = ?")
      .bind(id).first();
    if (!current) return json({ error: "Achievement not found" }, 404);

    const next = { ...current };

    if (body.name !== undefined) {
      next.name = typeof body.name === "string" ? body.name.trim() : "";
      if (next.name.length < 1 || next.name.length > 80) {
        return json({ error: "Achievement name must be between 1 and 80 characters" }, 400);
      }
    }

    if (body.description !== undefined) {
      if (typeof body.description !== "string" || body.description.length > 500) {
        return json({ error: "Description must be 500 characters or fewer" }, 400);
      }
      next.description = body.description.trim();
    }

    if (body.icon !== undefined) {
      if (typeof body.icon !== "string" || body.icon.length > 8 || /[^\x20-\x7E]/.test(body.icon)) {
        return json({ error: "Icon must be 8 plain characters or fewer" }, 400);
      }
      next.icon = body.icon.trim();
    }

    if (body.mode !== undefined) {
      if (!["everyone", "restricted"].includes(body.mode)) {
        return json({ error: "Invalid visibility mode" }, 400);
      }
      next.mode = body.mode;
    }

    await env.DB.prepare(`
      UPDATE achievements
      SET name = ?, description = ?, icon = ?, mode = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(next.name, next.description, next.icon, next.mode, id).run();

    await writeAudit(env, auth.session.id, "admin.achievement.updated", id, {
      targetType: "achievement",
      name: next.name,
      mode: next.mode
    });

    const updated = await env.DB.prepare("SELECT * FROM achievements WHERE id = ?").bind(id).first();
    return json({ ok: true, achievement: await readAchievement(env, updated) });
  }

  return json({ error: "Not found" }, 404);
}

// The signed-in user's own profile page
async function handleProfileApi(request, env, url) {
  const session = await getCurrentSession(request, env);
  if (!session) return json({ error: "Authentication required" }, 401);

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const email = await env.DB.prepare(`
    SELECT provider_email FROM auth_identities
    WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 1
  `).bind(session.id).first();

  const attendance = await env.DB.prepare(`
    SELECT s.id, s.title, s.description, s.starts_at, s.ends_at,
           s.location, s.status,
           a.status AS attendance_status, a.notes, a.marked_at
    FROM session_attendance a
    JOIN coding_sessions s ON s.id = a.session_id
    WHERE a.user_id = ?
    ORDER BY s.starts_at DESC
    LIMIT 200
  `).bind(session.id).all();

  // "Scheduled" means scheduled *and attendable by this member*: an open
  // session, or one locked to them directly or through one of their groups.
  // Counting every scheduled session regardless of locking was misleading.
  // Deliberately no administrator bypass: this is a personal page, so it
  // answers what this person can actually attend.
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM coding_sessions s
       WHERE s.status = 'scheduled' AND ${sessionVisibility("s")}) AS upcoming,
      (SELECT COUNT(*) FROM session_attendance
        WHERE user_id = ? AND status IN ('present', 'late')) AS attended,
      (SELECT COUNT(*) FROM session_attendance
        WHERE user_id = ? AND status = 'excused') AS excused
  `).bind(0, session.id, session.id, session.id, session.id).first();

  const xp = await env.DB.prepare(`
    SELECT xp_enabled, levels_enabled, xp_balance, current_level
    FROM users WHERE id = ?
  `).bind(session.id).first();

  return json({
    user: publicUser(session),
    email: email?.provider_email || "",
    stats: {
      upcoming: counts.upcoming,
      attended: counts.attended,
      excused: counts.excused,
      xpEnabled: Boolean(xp?.xp_enabled),
      levelsEnabled: Boolean(xp?.levels_enabled),
      xpBalance: xp?.xp_balance ?? 0,
      currentLevel: xp?.current_level ?? 1
    },
    attendance: (attendance.results || []).map(row => ({
      sessionId: row.id,
      title: row.title,
      description: row.description,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      location: row.location,
      status: row.status,
      attendanceStatus: row.attendance_status,
      notes: row.notes || "",
      markedAt: row.marked_at
    }))
  });
}

// ---------------------------------------------------------------------------
// Administrator-managed groups
// ---------------------------------------------------------------------------

function cleanGroupName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) return null;
  return name;
}

async function readGroup(env, groupId) {
  const group = await env.DB.prepare(`
    SELECT id, name, description, picture_data, picture_version, created_at, updated_at,
      length(picture_data) AS picture_length,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = portal_groups.id) AS member_count
    FROM portal_groups WHERE id = ?
  `).bind(groupId).first();

  if (!group) return null;

  const members = await env.DB.prepare(`
    SELECT u.id, u.display_name_override, u.preferred_name, u.provider_name,
      u.role, u.status,
      (u.profile_picture_data IS NOT NULL) AS has_profile_picture,
      length(u.profile_picture_data) AS profile_picture_length,
      u.updated_at,
      m.added_at
    FROM group_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ?
    ORDER BY COALESCE(u.display_name_override, u.preferred_name, u.provider_name) COLLATE NOCASE
  `).bind(groupId).all();

  return {
    id: group.id,
    name: group.name,
    description: group.description,
    hasPicture: Boolean(group.picture_data),
    pictureUrl: group.picture_data ? groupPictureUrl(group) : null,
    createdAt: group.created_at,
    memberCount: group.member_count,
    members: (members.results || []).map(row => ({
      id: row.id,
      name: row.display_name_override || row.preferred_name || row.provider_name || "User",
      role: row.role,
      status: row.status,
      hasProfilePicture: Boolean(row.has_profile_picture),
      avatarUrl: row.has_profile_picture ? avatarUrl(row) : null,
      addedAt: row.added_at
    }))
  };
}

async function handleGroupApi(request, env, url, auth) {
  // Reads are fine without a token; every write needs one.
  if (request.method !== "GET" && !(await requireCsrf(request, auth.session))) {
    return json({ error: "Invalid security token. Refresh and try again." }, 403);
  }

  // /api/admin/groups
  if (url.pathname === "/api/admin/groups") {
    if (request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT id, name, description, picture_data, picture_version, created_at, updated_at,
          length(picture_data) AS picture_length,
          (SELECT COUNT(*) FROM group_members m WHERE m.group_id = portal_groups.id) AS member_count
        FROM portal_groups
        ORDER BY name COLLATE NOCASE
      `).all();

      return json({
        groups: (result.results || []).map(group => ({
          id: group.id,
          name: group.name,
          description: group.description,
          hasPicture: Boolean(group.picture_data),
          pictureUrl: group.picture_data ? groupPictureUrl(group) : null,
          createdAt: group.created_at,
          memberCount: group.member_count
        }))
      });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["name", "description"].includes(key))) {
      return json({ error: "Invalid group details" }, 400);
    }

    const name = cleanGroupName(body.name);
    if (!name) return json({ error: "Group name must be between 1 and 80 characters" }, 400);

    const description = body.description === undefined ? "" : body.description;
    if (typeof description !== "string" || description.length > 500) {
      return json({ error: "Description must be 500 characters or fewer" }, 400);
    }

    const id = randomToken(18);

    try {
      await env.DB.prepare(`
        INSERT INTO portal_groups (id, name, description)
        VALUES (?, ?, ?)
      `).bind(id, name, description.trim()).run();
    } catch {
      return json({ error: "A group with that name already exists" }, 409);
    }

    await writeAudit(env, auth.session.id, "admin.group.created", id, {
      name,
      targetType: "group"
    });

    return json({ ok: true, id, group: await readGroup(env, id) }, 201);
  }

  const memberMatch = url.pathname.match(
    /^\/api\/admin\/groups\/([^/]+)\/members(?:\/([^/]+))?$/
  );

  if (memberMatch) {
    const groupId = decodeURIComponent(memberMatch[1]);
    const userId = memberMatch[2] ? decodeURIComponent(memberMatch[2]) : null;

    if (!groupId || groupId.length > 200 || (userId && userId.length > 200)) {
      return json({ error: "Invalid group or user ID" }, 400);
    }

    const group = await env.DB.prepare("SELECT id FROM portal_groups WHERE id = ?")
      .bind(groupId).first();
    if (!group) return json({ error: "Group not found" }, 404);

    if (request.method === "GET" && !userId) {
      return json({ group: await readGroup(env, groupId) });
    }

    if (request.method === "POST" && !userId) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      if (!body || typeof body !== "object" || typeof body.userId !== "string") {
        return json({ error: "Choose a member to add" }, 400);
      }

      const target = await env.DB.prepare(
        "SELECT id FROM users WHERE id = ? AND status = 'active'"
      ).bind(body.userId.trim().slice(0, 200)).first();
      if (!target) return json({ error: "Active user not found" }, 404);

      await env.DB.prepare(`
        INSERT INTO group_members (group_id, user_id, added_by)
        VALUES (?, ?, ?)
        ON CONFLICT(group_id, user_id) DO NOTHING
      `).bind(groupId, target.id, auth.session.id).run();

      await writeAudit(env, auth.session.id, "admin.group.member.added", groupId, {
        userId: target.id,
        targetType: "group"
      });

      return json({ ok: true, group: await readGroup(env, groupId) });
    }

    if (request.method === "DELETE" && userId) {
      await env.DB.prepare(
        "DELETE FROM group_members WHERE group_id = ? AND user_id = ?"
      ).bind(groupId, userId).run();

      await writeAudit(env, auth.session.id, "admin.group.member.removed", groupId, {
        userId,
        targetType: "group"
      });

      return json({ ok: true, group: await readGroup(env, groupId) });
    }

    return json({ error: "Method not allowed" }, 405);
  }

  const pictureMatch = url.pathname.match(/^\/api\/admin\/groups\/([^/]+)\/picture$/);

  if (pictureMatch) {
    const groupId = decodeURIComponent(pictureMatch[1]);
    if (!groupId || groupId.length > 200) return json({ error: "Invalid group ID" }, 400);

    const group = await env.DB.prepare("SELECT id FROM portal_groups WHERE id = ?")
      .bind(groupId).first();
    if (!group) return json({ error: "Group not found" }, 404);

    if (request.method === "PUT") {
      let form;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "Choose a valid image file" }, 400);
      }

      const file = form.get("picture");
      if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") {
        return json({ error: "Choose an image file" }, 400);
      }
      if (!Number.isFinite(file.size) || file.size < 1) {
        return json({ error: "That file is empty" }, 400);
      }
      if (file.size > MAX_PICTURE_BYTES) {
        return json({ error: "Choose an image smaller than 350 KB" }, 413);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = detectImageType(bytes);
      if (!type) return json({ error: "Use a PNG, JPEG, WebP or GIF image" }, 415);

      await env.DB.prepare(`
        UPDATE portal_groups
        SET picture_data = ?, picture_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(toDataUrl(bytes, type), randomToken(9), groupId).run();

      await writeAudit(env, auth.session.id, "admin.group.picture.updated", groupId, {
        targetType: "group",
        format: type
      });

      return json({ ok: true, group: await readGroup(env, groupId) });
    }

    if (request.method === "DELETE") {
      await env.DB.prepare(`
        UPDATE portal_groups
        SET picture_data = NULL, picture_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(randomToken(9), groupId).run();

      await writeAudit(env, auth.session.id, "admin.group.picture.removed", groupId, {
        targetType: "group"
      });

      return json({ ok: true, group: await readGroup(env, groupId) });
    }

    return json({ error: "Method not allowed" }, 405);
  }

  const groupMatch = url.pathname.match(/^\/api\/admin\/groups\/([^/]+)$/);

  if (groupMatch) {
    const groupId = decodeURIComponent(groupMatch[1]);
    if (!groupId || groupId.length > 200) return json({ error: "Invalid group ID" }, 400);

    if (request.method === "GET") {
      const group = await readGroup(env, groupId);
      if (!group) return json({ error: "Group not found" }, 404);
      return json({ group });
    }

    // Rename and re-describe.
    if (request.method === "PATCH") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length === 0 ||
          Object.keys(body).some(key => !["name", "description"].includes(key))) {
        return json({ error: "Invalid group details" }, 400);
      }

      const current = await env.DB.prepare(
        "SELECT name, description FROM portal_groups WHERE id = ?"
      ).bind(groupId).first();
      if (!current) return json({ error: "Group not found" }, 404);

      let name = current.name;
      if (body.name !== undefined) {
        name = cleanGroupName(body.name);
        if (!name) return json({ error: "Group name must be between 1 and 80 characters" }, 400);
      }

      let description = current.description;
      if (body.description !== undefined) {
        if (typeof body.description !== "string" || body.description.length > 500) {
          return json({ error: "Description must be 500 characters or fewer" }, 400);
        }
        description = body.description.trim();
      }

      if (name === current.name && description === current.description) {
        return json({ ok: true, group: await readGroup(env, groupId) });
      }

      try {
        await env.DB.prepare(`
          UPDATE portal_groups
          SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(name, description, groupId).run();
      } catch {
        return json({ error: "A group with that name already exists" }, 409);
      }

      await writeAudit(env, auth.session.id, "admin.group.updated", groupId, {
        targetType: "group",
        name
      });

      return json({ ok: true, group: await readGroup(env, groupId) });
    }

    if (request.method === "DELETE") {
      const group = await env.DB.prepare("SELECT id FROM portal_groups WHERE id = ?")
        .bind(groupId).first();
      if (!group) return json({ error: "Group not found" }, 404);

      await env.DB.prepare("DELETE FROM portal_groups WHERE id = ?").bind(groupId).run();
      await writeAudit(env, auth.session.id, "admin.group.deleted", groupId, {
        targetType: "group"
      });

      return json({ ok: true, deleted: true });
    }

    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

async function handleAdminApi(request, env, url) {
  const auth = await adminSession(request, env);
  if (auth.error) return auth.error;

  if (url.pathname.startsWith("/api/admin/achievements")) {
    try {
      return await handleAdminAchievementApi(request, env, url, auth);
    } catch {
      return json({ error: "Achievement request failed" }, 500);
    }
  }

  if (url.pathname.startsWith("/api/admin/groups")) {
    try {
      return await handleGroupApi(request, env, url, auth);
    } catch {
      return json({ error: "Group request failed" }, 500);
    }
  }


  if (url.pathname === "/api/admin/overview") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const [total, active, suspended, pending, admins] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'suspended'").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'pending_deletion'").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").first()
    ]);
    return json({
      totalUsers: total.count,
      activeUsers: active.count,
      suspendedUsers: suspended.count,
      pendingDeletionUsers: pending.count,
      activeAdmins: admins.count
    });
  }

  if (url.pathname === "/api/admin/users") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const search = (url.searchParams.get("q") || "").trim().slice(0, 100);
    const pattern = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
    const result = await env.DB.prepare(`
      SELECT u.id, u.provider_name, u.preferred_name, u.display_name_override,
        u.role, u.status, u.status_reason, u.created_at, u.updated_at, u.last_sign_in_at,
        (u.profile_picture_data IS NOT NULL) AS has_profile_picture,
        length(u.profile_picture_data) AS profile_picture_length,
        (SELECT GROUP_CONCAT(DISTINCT ai.provider_email)
         FROM auth_identities ai WHERE ai.user_id = u.id) AS emails
      FROM users u
      WHERE (? = '' OR u.id LIKE ? ESCAPE '\\'
        OR COALESCE(u.provider_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(u.preferred_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(u.display_name_override, '') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM auth_identities ai
                   WHERE ai.user_id = u.id AND COALESCE(ai.provider_email, '') LIKE ? ESCAPE '\\'))
      ORDER BY u.created_at DESC LIMIT 200
    `).bind(search, pattern, pattern, pattern, pattern, pattern).all();

    return json({
      users: (result.results || []).map(user => ({
        id: user.id,
        name: user.display_name_override || user.preferred_name || user.provider_name || "User",
        providerName: user.provider_name || "",
        preferredName: user.preferred_name || "",
        displayNameOverride: user.display_name_override || "",
        emails: user.emails || "",
        role: user.role,
        status: user.status,
        statusReason: user.status_reason || "",
        hasProfilePicture: Boolean(user.has_profile_picture),
        avatarUrl: user.has_profile_picture ? avatarUrl(user) : null,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at
      }))
    });
  }

  if (url.pathname === "/api/admin/audit") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const result = await env.DB.prepare(`
      SELECT a.id, a.action, a.target_type, a.target_id, a.details_json,
        a.created_at, u.display_name_override, u.preferred_name, u.provider_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.created_at DESC LIMIT 50
    `).all();

    return json({
      events: (result.results || []).map(event => ({
        id: event.id,
        action: event.action,
        targetType: event.target_type,
        targetId: event.target_id,
        details: event.details_json,
        createdAt: event.created_at,
        actor: event.display_name_override || event.preferred_name || event.provider_name || "Deleted account"
      }))
    });
  }

  if (url.pathname === "/api/admin/sessions") {
    if (request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM session_attendance a
           WHERE a.session_id = s.id AND a.status IN ('present', 'late'))
            AS attendance_count,
          (SELECT COUNT(*) FROM session_attendance a
           WHERE a.session_id = s.id) AS marked_count
        FROM coding_sessions s
        ORDER BY CASE WHEN s.status = 'scheduled' THEN 0 ELSE 1 END,
          CASE WHEN s.status = 'scheduled' THEN s.starts_at END ASC,
          CASE WHEN s.status != 'scheduled' THEN s.starts_at END DESC
      `).all();

      return json({
        sessions: (result.results || []).map(s => ({
          id: s.id,
          title: s.title,
          description: s.description,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
          location: s.location,
          status: s.status,
          createdAt: s.created_at,
          attendanceCount: s.attendance_count,
          markedCount: s.marked_count
        }))
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const allowed = new Set([
      "title", "description", "startsAt", "endsAt", "location"
    ]);

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !allowed.has(key))) {
      return json({ error: "Invalid session fields" }, 400);
    }

    if (typeof body.title !== "string" ||
        body.title.trim().length < 1 || body.title.trim().length > 120) {
      return json({ error: "Title must be between 1 and 120 characters" }, 400);
    }

    if (typeof body.startsAt !== "string" ||
        !Number.isFinite(Date.parse(body.startsAt))) {
      return json({ error: "A valid start date and time is required" }, 400);
    }

    if (body.endsAt != null &&
        (typeof body.endsAt !== "string" ||
         !Number.isFinite(Date.parse(body.endsAt)) ||
         Date.parse(body.endsAt) <= Date.parse(body.startsAt))) {
      return json({ error: "End time must be later than start time" }, 400);
    }

    if (body.description !== undefined &&
        (typeof body.description !== "string" || body.description.length > 4000)) {
      return json({ error: "Description must be 4000 characters or fewer" }, 400);
    }

    if (body.location !== undefined &&
        (typeof body.location !== "string" || body.location.length > 200)) {
      return json({ error: "Location must be 200 characters or fewer" }, 400);
    }

    const id = randomToken(18);

    await env.DB.prepare(`
      INSERT INTO coding_sessions
        (id, title, description, starts_at, ends_at, location, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      body.title.trim(),
      (body.description || "").trim(),
      body.startsAt,
      body.endsAt || null,
      (body.location || "").trim(),
      auth.session.id
    ).run();

    await writeAudit(env, auth.session.id, "admin.session.created", id, {
      title: body.title.trim(),
      startsAt: body.startsAt
    });

    return json({ ok: true, id, session: await readAdminSession(env, id) }, 201);
  }

  const attendanceMatch = url.pathname.match(
    /^\/api\/admin\/sessions\/([^/]+)\/attendance(?:\/([^/]+))?$/
  );

  if (attendanceMatch) {
    const sessionId = decodeURIComponent(attendanceMatch[1]);
    const userId = attendanceMatch[2]
      ? decodeURIComponent(attendanceMatch[2])
      : null;

    if (!sessionId || sessionId.length > 200 ||
        (userId && userId.length > 200)) {
      return json({ error: "Invalid session or user ID" }, 400);
    }

    const codingSession = await env.DB.prepare(
      "SELECT id FROM coding_sessions WHERE id = ?"
    ).bind(sessionId).first();

    if (!codingSession) return json({ error: "Session not found" }, 404);

    if (request.method === "GET" && !userId) {
      const result = await env.DB.prepare(`
        SELECT u.id,
          COALESCE(u.display_name_override, u.preferred_name,
                   u.provider_name, 'User') AS name,
          u.status AS account_status,
          (u.profile_picture_data IS NOT NULL) AS has_profile_picture,
          length(u.profile_picture_data) AS profile_picture_length,
          u.updated_at,
          a.status AS attendance_status,
          a.notes,
          a.marked_at
        FROM users u
        LEFT JOIN session_attendance a
          ON a.user_id = u.id AND a.session_id = ?
        WHERE u.status = 'active'
          AND ${SESSION_AUDIENCE_SQL}
        ORDER BY name COLLATE NOCASE
        LIMIT 500
      `).bind(
        sessionId,
        sessionId, sessionId, sessionId, sessionId
      ).all();

      const access = await readSessionAccess(env, sessionId);

      return json({
        // Told to the client so an empty register can explain itself instead of
        // just looking like a bug.
        restricted: access.restricted,
        lockedTo: access,
        attendance: (result.results || []).map(row => ({
          userId: row.id,
          name: row.name,
          status: row.attendance_status || "unmarked",
          hasProfilePicture: Boolean(row.has_profile_picture),
          avatarUrl: row.has_profile_picture ? avatarUrl(row) : null,
          notes: row.notes || "",
          markedAt: row.marked_at
        }))
      });
    }

    if (request.method !== "PUT" || !userId) {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["status", "notes"].includes(key))) {
      return json({ error: "Invalid attendance details" }, 400);
    }

    // `unmarked` is a real instruction, not a missing value: it clears the
    // mark entirely so the member is back in the unmarked pool.
    if (body.status === "unmarked") {
      await env.DB.prepare(
        "DELETE FROM session_attendance WHERE session_id = ? AND user_id = ?"
      ).bind(sessionId, userId).run();

      await writeAudit(env, auth.session.id, "admin.session.attendance.cleared", sessionId, {
        userId,
        targetType: "session_attendance"
      });

      const counts = await env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM session_attendance
            WHERE session_id = ? AND status IN ('present', 'late')) AS attendance_count,
          (SELECT COUNT(*) FROM session_attendance WHERE session_id = ?) AS marked_count
      `).bind(sessionId, sessionId).first();

      return json({
        ok: true,
        attendance: null,
        attendanceCount: counts.attendance_count,
        markedCount: counts.marked_count
      });
    }

    if (!["present", "absent", "late", "excused"].includes(body.status)) {
      return json({ error: "Invalid attendance details" }, 400);
    }

    if (body.notes !== undefined &&
        (typeof body.notes !== "string" || body.notes.length > 500)) {
      return json({ error: "Attendance notes must be 500 characters or fewer" }, 400);
    }

    const targetUser = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND status = 'active'"
    ).bind(userId).first();

    if (!targetUser) return json({ error: "Active user not found" }, 404);

    // A restricted session only accepts marks from its own audience, so the
    // register and what can be saved to it can never disagree.
    if (body.status !== "unmarked") {
      const onSession = await env.DB.prepare(`
        SELECT 1 AS present FROM users u
        WHERE u.id = ? AND ${SESSION_AUDIENCE_SQL}
      `).bind(
        userId,
        sessionId, sessionId, sessionId, sessionId
      ).first();

      if (!onSession) {
        return json({
          error: "That member is not on this session. Add them to it first."
        }, 409);
      }
    }

    await env.DB.prepare(`
      INSERT INTO session_attendance
        (session_id, user_id, status, marked_by, notes, marked_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id, user_id) DO UPDATE SET
        status = excluded.status,
        marked_by = excluded.marked_by,
        notes = excluded.notes,
        marked_at = CURRENT_TIMESTAMP
    `).bind(
      sessionId,
      userId,
      body.status,
      auth.session.id,
      (body.notes || "").trim()
    ).run();

    await writeAudit(env, auth.session.id, "admin.session.attendance.updated", sessionId, {
      userId,
      status: body.status
    });

    const saved = await env.DB.prepare(`
      SELECT u.id, u.display_name_override, u.preferred_name, u.provider_name,
        a.status, a.notes, a.marked_at
      FROM users u
      JOIN session_attendance a ON a.user_id = u.id AND a.session_id = ?
      WHERE u.id = ?
    `).bind(sessionId, userId).first();

    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM session_attendance
          WHERE session_id = ? AND status IN ('present', 'late')) AS attendance_count,
        (SELECT COUNT(*) FROM session_attendance WHERE session_id = ?) AS marked_count
    `).bind(sessionId, sessionId).first();

    return json({
      ok: true,
      attendance: {
        userId,
        name: saved.display_name_override || saved.preferred_name || saved.provider_name || "User",
        status: saved.status,
        notes: saved.notes || "",
        markedAt: saved.marked_at
      },
      attendanceCount: counts.attendance_count,
      markedCount: counts.marked_count
    });
  }

  const accessMatch = url.pathname.match(
    /^\/api\/admin\/sessions\/([^/]+)\/access(?:\/(users|groups)\/([^/]+))?$/
  );

  if (accessMatch) {
    const sessionId = decodeURIComponent(accessMatch[1]);
    const kind = accessMatch[2] || null;
    const targetId = accessMatch[3] ? decodeURIComponent(accessMatch[3]) : null;

    if (!sessionId || sessionId.length > 200 || (targetId && targetId.length > 200)) {
      return json({ error: "Invalid session or member ID" }, 400);
    }

    const codingSession = await env.DB.prepare("SELECT id FROM coding_sessions WHERE id = ?")
      .bind(sessionId).first();
    if (!codingSession) return json({ error: "Session not found" }, 404);

    if (request.method === "GET" && !kind) {
      return json({ access: await readSessionAccess(env, sessionId) });
    }

    // Clear every restriction and put the session back in front of everyone.
    if (request.method === "DELETE" && !kind) {
      if (!(await requireCsrf(request, auth.session))) {
        return json({ error: "Invalid security token. Refresh and try again." }, 403);
      }

      await env.DB.batch([
        env.DB.prepare("DELETE FROM session_access WHERE session_id = ?").bind(sessionId),
        env.DB.prepare("DELETE FROM session_group_access WHERE session_id = ?").bind(sessionId)
      ]);

      await writeAudit(env, auth.session.id, "admin.session.access.cleared", sessionId, {
        targetType: "coding_session"
      });

      return json({ ok: true, access: await readSessionAccess(env, sessionId) });
    }

    if (request.method !== "PUT" || !kind || !targetId) {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "allowed") ||
        typeof body.allowed !== "boolean") {
      return json({ error: "Invalid access details" }, 400);
    }

    const table = kind === "users" ? "session_access" : "session_group_access";
    const column = kind === "users" ? "user_id" : "group_id";
    const source = kind === "users" ? "users" : "portal_groups";
    const label = kind === "users" ? "user" : "group";

    const target = await env.DB.prepare(
      `SELECT id FROM ${source} WHERE id = ?${kind === "users" ? " AND status = 'active'" : ""}`
    ).bind(targetId).first();

    if (!target) {
      return json({ error: `Active ${label} not found` }, kind === "users" ? 404 : 404);
    }

    if (body.allowed) {
      await env.DB.prepare(`
        INSERT INTO ${table} (session_id, ${column}, granted_by)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id, ${column}) DO NOTHING
      `).bind(sessionId, targetId, auth.session.id).run();
    } else {
      await env.DB.prepare(
        `DELETE FROM ${table} WHERE session_id = ? AND ${column} = ?`
      ).bind(sessionId, targetId).run();
    }

    await writeAudit(env, auth.session.id, "admin.session.access.updated", sessionId, {
      targetType: "coding_session",
      kind,
      subjectId: targetId,
      allowed: body.allowed
    });

    return json({ ok: true, access: await readSessionAccess(env, sessionId) });
  }

  const sessionMatch = url.pathname.match(
    /^\/api\/admin\/sessions\/([^/]+)$/
  );

  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);

    if (!sessionId || sessionId.length > 200) {
      return json({ error: "Invalid session ID" }, 400);
    }

    // Deletion. Cascades take the attendance marks, the access rows and the
    // access grants with it; the coding session's own history is the thing
    // being destroyed, so that is what gets confirmed.
    if (request.method === "DELETE") {
      if (!(await requireCsrf(request, auth.session))) {
        return json({ error: "Invalid security token. Refresh and try again." }, 403);
      }

      const existing = await env.DB.prepare(
        "SELECT id, title FROM coding_sessions WHERE id = ?"
      ).bind(sessionId).first();

      if (!existing) return json({ error: "Session not found" }, 404);

      const marked = await env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM session_attendance WHERE session_id = ?) AS attendance_count,
          (SELECT COUNT(*) FROM session_access WHERE session_id = ?) AS user_grants,
          (SELECT COUNT(*) FROM session_group_access WHERE session_id = ?) AS group_grants
      `).bind(sessionId, sessionId, sessionId).first();

      await env.DB.prepare("DELETE FROM coding_sessions WHERE id = ?").bind(sessionId).run();

      await writeAudit(env, auth.session.id, "admin.session.deleted", sessionId, {
        targetType: "coding_session",
        title: existing.title,
        attendanceRemoved: marked.attendance_count
      });

      return json({
        ok: true,
        deleted: true,
        removed: {
          attendance: marked.attendance_count,
          userGrants: marked.user_grants,
          groupGrants: marked.group_grants
        }
      });
    }

    if (request.method !== "PATCH") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const allowed = new Set([
      "title", "description", "startsAt", "endsAt", "location", "status"
    ]);

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length === 0 ||
        Object.keys(body).some(key => !allowed.has(key))) {
      return json({ error: "Invalid session fields" }, 400);
    }

    const current = await env.DB.prepare(
      "SELECT * FROM coding_sessions WHERE id = ?"
    ).bind(sessionId).first();

    if (!current) return json({ error: "Session not found" }, 404);

    const next = {
      title: body.title === undefined ? current.title : (typeof body.title === "string" ? body.title.trim() : body.title),
      description: body.description === undefined ? current.description : (typeof body.description === "string" ? body.description.trim() : body.description),
      startsAt: body.startsAt === undefined ? current.starts_at : body.startsAt,
      endsAt: body.endsAt === undefined ? current.ends_at : body.endsAt,
      location: body.location === undefined ? current.location : (typeof body.location === "string" ? body.location.trim() : body.location),
      status: body.status === undefined ? current.status : body.status
    };

    if (body.title !== undefined &&
        (typeof body.title !== "string" ||
         body.title.trim().length < 1 || body.title.trim().length > 120)) {
      return json({ error: "Title must be between 1 and 120 characters" }, 400);
    }

    if (body.description !== undefined &&
        (typeof body.description !== "string" || body.description.length > 4000)) {
      return json({ error: "Description must be 4000 characters or fewer" }, 400);
    }

    if (body.location !== undefined &&
        (typeof body.location !== "string" || body.location.length > 200)) {
      return json({ error: "Location must be 200 characters or fewer" }, 400);
    }

    if (body.startsAt !== undefined &&
        (typeof body.startsAt !== "string" ||
         !Number.isFinite(Date.parse(body.startsAt)))) {
      return json({ error: "Invalid start date and time" }, 400);
    }

    if (next.endsAt != null &&
        (typeof next.endsAt !== "string" ||
         !Number.isFinite(Date.parse(next.endsAt)) ||
         Date.parse(next.endsAt) <= Date.parse(next.startsAt))) {
      return json({ error: "End time must be later than start time" }, 400);
    }

    if (!["scheduled", "completed", "cancelled"].includes(next.status)) {
      return json({ error: "Invalid session status" }, 400);
    }

    await env.DB.prepare(`
      UPDATE coding_sessions
      SET title = ?, description = ?, starts_at = ?, ends_at = ?,
          location = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      next.title,
      next.description,
      next.startsAt,
      next.endsAt,
      next.location,
      next.status,
      sessionId
    ).run();

    await writeAudit(env, auth.session.id, "admin.session.updated", sessionId, {
      status: next.status
    });

    return json({ ok: true, session: await readAdminSession(env, sessionId) });
  }

  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (match && request.method === "PATCH") {
    if (!(await requireCsrf(request, auth.session))) {
      return json({ error: "Invalid security token. Refresh and try again." }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const allowed = new Set(["displayName", "role", "status", "statusReason"]);
    if (!body || typeof body !== "object" ||
        Object.keys(body).length === 0 ||
        Object.keys(body).some(key => !allowed.has(key))) {
      return json({ error: "Invalid update fields" }, 400);
    }

    const targetId = decodeURIComponent(match[1]);
    if (!targetId || targetId.length > 200) return json({ error: "Invalid user ID" }, 400);

    const current = await env.DB.prepare(
      "SELECT id, role, status, display_name_override, status_reason FROM users WHERE id = ?"
    ).bind(targetId).first();
    if (!current) return json({ error: "User not found" }, 404);

    if (body.displayName !== undefined &&
        (typeof body.displayName !== "string" || body.displayName.trim().length > 80)) {
      return json({ error: "Displayed name must be 80 characters or fewer" }, 400);
    }
    if (body.role !== undefined && !["user", "admin"].includes(body.role)) {
      return json({ error: "Invalid role" }, 400);
    }
    if (body.status !== undefined &&
        !["active", "suspended", "pending_deletion"].includes(body.status)) {
      return json({ error: "Invalid account status" }, 400);
    }

    if (body.statusReason !== undefined) {
      if (typeof body.statusReason !== "string" || body.statusReason.length > 500) {
        return json({ error: "Reason must be 500 characters or fewer" }, 400);
      }
      if (body.statusReason.trim() && body.status === undefined &&
          (current.status === "active" || body.status === "active")) {
        return json({ error: "A reason only makes sense on a suspended account" }, 400);
      }
    }

    const nextRole = body.role ?? current.role;
    const nextStatus = body.status ?? current.status;
    if (targetId === auth.session.id &&
        (nextRole !== current.role || nextStatus !== current.status)) {
      return json({ error: "You cannot change your own role or account status" }, 409);
    }

    if (current.role === "admin" && current.status === "active" &&
        (nextRole !== "admin" || nextStatus !== "active")) {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'"
      ).first();
      if (count.count <= 1) {
        return json({ error: "You cannot remove or suspend the last active administrator" }, 409);
      }
    }

    const changes = [];
    const values = [];
    const details = {};

    if (body.displayName !== undefined) {
      const value = body.displayName.trim() || null;
      changes.push("display_name_override = ?");
      values.push(value);
      details.displayName = { from: current.display_name_override, to: value };
    }
    if (body.role !== undefined) {
      changes.push("role = ?");
      values.push(nextRole);
      details.role = { from: current.role, to: nextRole };
    }
    if (body.status !== undefined) {
      changes.push("status = ?");
      values.push(nextStatus);
      details.status = { from: current.status, to: nextStatus };
    }

    // The reason belongs to the blocked state, so it is cleared the moment the
    // account goes active again rather than lingering on a live account.
    if (body.statusReason !== undefined) {
      const reason = nextStatus === "active"
        ? null
        : (body.statusReason.trim() || null);
      if (reason !== current.status_reason) {
        changes.push("status_reason = ?");
        values.push(reason);
        details.statusReason = { from: current.status_reason, to: reason };
      }
    } else if (body.status !== undefined && nextStatus === "active" &&
               current.status_reason) {
      changes.push("status_reason = NULL");
      details.statusReason = { from: current.status_reason, to: null };
    }

    if (changes.length) {
      changes.push("updated_at = CURRENT_TIMESTAMP");
      values.push(targetId);
      await env.DB.prepare("UPDATE users SET " + changes.join(", ") + " WHERE id = ?")
        .bind(...values).run();
      await writeAudit(env, auth.session.id, "admin.user.updated", targetId, details);

      if (nextStatus !== "active") {
        await env.DB.prepare("DELETE FROM server_sessions WHERE user_id = ?")
          .bind(targetId).run();
      }
    }

    return json({ ok: true });
  }

  if (match && request.method !== "PATCH") {
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
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

      if (url.pathname === "/api/auth/blocked") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        const blocked = readBlockedCookie(request);
        const headers = new Headers(jsonHeaders);
        headers.append("set-cookie", setCookie(request, "csp_blocked", "", {
          httpOnly: true,
          maxAge: 0
        }));

        return new Response(JSON.stringify({ blocked }), { status: 200, headers });
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

      if (url.pathname === "/api/sessions") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        const session = await getCurrentSession(request, env);

        if (!session) {
          return json({ error: "Authentication required" }, 401);
        }

        try {
          // Administrators see every session so they can manage them. Asking for
          // the member view drops that privilege: the caller then sees only
          // what they would see as an ordinary member. It can only ever
          // *reduce* what is returned, so it cannot be used to gain anything.
          const memberView = url.searchParams.get("view") === "member";
          const seesEverything = !memberView && session.role === "admin";

          const result = await env.DB.prepare(`
            SELECT
              s.id, s.title, s.description, s.starts_at, s.ends_at,
              s.location, s.status, s.created_at,
              (SELECT COUNT(*)
               FROM session_attendance a
               WHERE a.session_id = s.id
                 AND a.status IN ('present', 'late')) AS attendance_count,
              (SELECT a.status
               FROM session_attendance a
               WHERE a.session_id = s.id
                 AND a.user_id = ?) AS my_attendance,
              EXISTS (SELECT 1 FROM session_access sa
                      WHERE sa.session_id = s.id) AS locked_users,
              EXISTS (SELECT 1 FROM session_group_access sg
                      WHERE sg.session_id = s.id) AS locked_groups
            FROM coding_sessions s
            WHERE ${sessionVisibility("s")}
            ORDER BY
              CASE WHEN s.status = 'scheduled' THEN 0 ELSE 1 END,
              CASE WHEN s.status = 'scheduled'
                   THEN s.starts_at END ASC,
              CASE WHEN s.status != 'scheduled'
                   THEN s.starts_at END DESC
          `).bind(session.id, seesEverything ? 1 : 0, session.id, session.id).all();

          return json({
            sessions: (result.results || []).map(item => ({
              id: item.id,
              title: item.title,
              description: item.description,
              startsAt: item.starts_at,
              endsAt: item.ends_at,
              location: item.location,
              status: item.status,
              createdAt: item.created_at,
              attendanceCount: item.attendance_count,
              myAttendance: item.my_attendance || "unmarked",
              restricted: Boolean(item.locked_users || item.locked_groups)
            }))
          });
        } catch {
          return json({ error: "Unable to load sessions" }, 500);
        }
      }

      if (url.pathname === "/api/achievements") {
        try {
          return await handleAchievementApi(request, env, url);
        } catch {
          return json({ error: "Achievement request failed" }, 500);
        }
      }

      if (url.pathname === "/api/profile") {
        try {
          return await handleProfileApi(request, env, url);
        } catch {
          return json({ error: "Profile request failed" }, 500);
        }
      }

      if (url.pathname.startsWith("/api/group-avatars/")) {
        try {
          return await serveGroupPicture(request, env, url);
        } catch {
          return json({ error: "Group picture request failed" }, 500);
        }
      }

      if (url.pathname.startsWith("/api/avatars/")) {
        try {
          return await serveProfilePicture(request, env, url);
        } catch {
          return json({ error: "Avatar request failed" }, 500);
        }
      }

      if (url.pathname.startsWith("/api/account")) {
        try {
          return await handleAccountApi(request, env, url);
        } catch {
          return json({ error: "Account request failed" }, 500);
        }
      }

      if (url.pathname.startsWith("/api/admin/")) {
        try {
          return await handleAdminApi(request, env, url);
        } catch {
          return json({ error: "Admin request failed" }, 500);
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

