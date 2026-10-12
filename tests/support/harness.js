import { deflateSync } from "node:zlib";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase } from "./d1.js";

// ---------------------------------------------------------------------------
// Image fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// A genuinely decodable PNG. Different colours give byte-distinct images, so a
// test can prove which one is actually stored.
export function pngBytes(colour = [0x58, 0xd9, 0xf5]) {
  const width = 2;
  const height = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * stride;
    raw[start] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[start + 1 + x * 3] = colour[0];
      raw[start + 2 + x * 3] = colour[1];
      raw[start + 3 + x * 3] = colour[2];
    }
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// Minimal but real 1x1 JPEG.
export function jpegBytes() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64"
  );
}

// Minimal but real 1x1 GIF.
export function gifBytes() {
  return Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  );
}

// A structurally valid RIFF/WebP container. The server checks the container
// signature, never the payload, so this is exactly what it must accept.
export function webpBytes() {
  const payload = Buffer.from([0x30, 0x01, 0x00, 0x4d, 0x10, 0x1e, 0x00, 0x00, 0x41, 0x0a, 0x8f]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length + 4, 0);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(payload.length, 0);

  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    size,
    Buffer.from("WEBP", "ascii"),
    Buffer.from("VP8 ", "ascii"),
    chunkSize,
    payload
  ]);
}

// Claims to be a PNG by name and MIME type; is not one.
export function textBytes() {
  return Buffer.from("<script>alert('not an image')</script>", "utf8");
}

export function svgBytes() {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
}

export function oversizedBytes() {
  const head = pngBytes();
  const filler = Buffer.alloc(400 * 1024, 0x41);
  return Buffer.concat([head, filler]);
}

export function expectedDataUrl(bytes, type) {
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Signed-in session harness
// ---------------------------------------------------------------------------

export function sha256Base64url(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function createHarness() {
  const DB = createTestDatabase();

  async function addUser(options = {}) {
    const id = options.id || randomUUID();
    await DB.prepare(`
      INSERT INTO users (id, provider_name, preferred_name, display_name_override,
                         profile_picture_data, role, status, xp_balance, current_level,
                         created_at, updated_at, last_sign_in_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      id,
      options.providerName === undefined ? "Test User" : options.providerName,
      options.preferredName === undefined ? "Test User" : options.preferredName,
      options.displayName === undefined ? null : options.displayName,
      options.picture === undefined ? null : options.picture,
      options.role || "user",
      options.status || "active"
    ).run();

    await DB.prepare(`
      INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, last_used_at)
      VALUES (?, ?, 'google', ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      randomUUID(),
      id,
      `subject-${id}`,
      options.email || `${id}@example.test`
    ).run();

    return id;
  }

  async function signIn(userId, { csrfToken = randomBytes(24).toString("base64url") } = {}) {
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    await DB.prepare(`
      INSERT INTO server_sessions (id_hash, user_id, csrf_token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(
      sha256Base64url(sessionToken),
      userId,
      sha256Base64url(csrfToken),
      expiresAt
    ).run();

    return {
      userId,
      sessionToken,
      csrfToken,
      cookie: `__Host-csp_session=${sessionToken}; __Host-csp_csrf=${csrfToken}`
    };
  }

  function request(path, options = {}) {
    const headers = new Headers({ accept: "application/json", ...(options.headers || {}) });

    if (options.session) {
      headers.set("cookie", options.session.cookie);
      if (options.csrf === undefined || options.csrf !== null) {
        headers.set("x-csrf-token", options.csrf === undefined ? options.session.csrfToken : options.csrf);
      }
    }

    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers.set("content-type", "application/json");
    }

    return new Request(`https://coding-sessions.example${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : options.body
    });
  }

  return { DB, addUser, signIn, request };
}
