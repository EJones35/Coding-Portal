import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import worker from "../src/server/index.js";
import { migrationNames } from "./support/d1.js";
import {
  createHarness,
  expectedDataUrl,
  gifBytes,
  jpegBytes,
  oversizedBytes,
  pngBytes,
  svgBytes,
  textBytes,
  webpBytes
} from "./support/harness.js";

const ORIGIN = "https://coding-sessions.example";

function pictureForm(bytes, filename, type) {
  const form = new FormData();
  form.append("picture", new File([bytes], filename, { type }));
  return form;
}

async function call(harness, path, options = {}) {
  const response = await worker.fetch(harness.request(path, options), {
    DB: harness.DB,
    ASSETS: { fetch: async () => new Response("asset") }
  });
  return response;
}

async function json(response) {
  return response.json();
}

async function pictureRow(harness, userId) {
  const row = await harness.DB.prepare(
    "SELECT profile_picture_data FROM users WHERE id = ?"
  ).bind(userId).first();
  return row ? row.profile_picture_data : null;
}

// ---------------------------------------------------------------------------
// Profile pictures
// ---------------------------------------------------------------------------

test("profile picture uploads require a signed-in session", async () => {
  const harness = createHarness();
  const response = await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    body: pictureForm(pngBytes(), "avatar.png", "image/png")
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await json(response), { error: "Authentication required" });
});

test("profile picture uploads reject an invalid CSRF token", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    csrf: "not-the-right-token",
    body: pictureForm(pngBytes(), "avatar.png", "image/png")
  });

  assert.equal(response.status, 403);
  assert.equal(await pictureRow(harness, session.userId), null);
});

test("an upload with no file is rejected", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: new FormData()
  });

  assert.equal(response.status, 400);
  assert.equal((await json(response)).error, "Choose an image file");
});

test("SVG, HTML and other unsupported content are rejected", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  for (const [bytes, name, type] of [
    [svgBytes(), "avatar.svg", "image/svg+xml"],
    [textBytes(), "avatar.png", "image/png"],
    [Buffer.from("%PDF-1.4 not an image"), "avatar.pdf", "application/pdf"]
  ]) {
    const response = await call(harness, "/api/account/profile-picture", {
      method: "PUT",
      session,
      body: pictureForm(bytes, name, type)
    });

    assert.equal(response.status, 415, `${name} must be rejected`);
    assert.match((await json(response)).error, /PNG, JPEG, WebP or GIF/);
  }

  assert.equal(await pictureRow(harness, session.userId), null);
});

test("an oversized image is rejected before it reaches the database", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(oversizedBytes(), "big.png", "image/png")
  });

  assert.equal(response.status, 413);
  assert.match((await json(response)).error, /350 KB/);
  assert.equal(await pictureRow(harness, session.userId), null);
});

for (const [label, bytes, type] of [
  ["PNG", pngBytes(), "image/png"],
  ["JPEG", jpegBytes(), "image/jpeg"],
  ["WebP", webpBytes(), "image/webp"],
  ["GIF", gifBytes(), "image/gif"]
]) {
  test(`a valid ${label} upload is accepted and stored exactly`, async () => {
    const harness = createHarness();
    const session = await harness.signIn(await harness.addUser());

    const response = await call(harness, "/api/account/profile-picture", {
      method: "PUT",
      session,
      body: pictureForm(bytes, `avatar.${label.toLowerCase()}`, type)
    });

    assert.equal(response.status, 200);
    const result = await json(response);
    assert.equal(result.ok, true);
    assert.equal(result.user.hasProfilePicture, true);
    assert.match(result.user.avatarUrl, /^\/api\/avatars\//);

    const stored = await pictureRow(harness, session.userId);
    assert.equal(stored, expectedDataUrl(bytes, type));

    const served = await call(harness, result.user.avatarUrl, { session });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), type);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(bytes));
  });
}

test("uploading a second image replaces the first, and the newest one is served", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const first = pngBytes([0xff, 0x00, 0x00]);
  const second = jpegBytes();

  const firstResponse = await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(first, "first.png", "image/png")
  });
  const firstVersion = (await json(firstResponse)).user.avatarUrl;

  const secondResponse = await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(second, "second.jpg", "image/jpeg")
  });
  const secondUser = (await json(secondResponse)).user;

  const stored = await pictureRow(harness, session.userId);
  assert.equal(stored, expectedDataUrl(second, "image/jpeg"));
  assert.ok(!stored.includes(expectedDataUrl(first, "image/png")));

  // A different version means the browser cannot reuse the decoded first image.
  assert.notEqual(secondUser.avatarUrl, firstVersion);

  const served = await call(harness, secondUser.avatarUrl, { session });
  assert.equal(served.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(second));
});

test("the account endpoint reports the picture state after every change", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const before = await json(await call(harness, "/api/auth/me", { session }));
  assert.equal(before.user.hasProfilePicture, false);
  assert.equal(before.user.avatarUrl, null);

  await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(pngBytes(), "a.png", "image/png")
  });

  const during = await json(await call(harness, "/api/auth/me", { session }));
  assert.equal(during.user.hasProfilePicture, true);
  assert.match(during.user.avatarUrl, /^\/api\/avatars\//);

  await call(harness, "/api/account/profile-picture", { method: "DELETE", session });

  const after = await json(await call(harness, "/api/auth/me", { session }));
  assert.equal(after.user.hasProfilePicture, false);
  assert.equal(after.user.avatarUrl, null);
});

test("removing a picture clears the stored bytes and the served image", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());
  const uploaded = await json(await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(pngBytes(), "a.png", "image/png")
  }));

  const response = await call(harness, "/api/account/profile-picture", { method: "DELETE", session });
  assert.equal(response.status, 200);

  const stored = await pictureRow(harness, session.userId);
  assert.equal(stored, null);

  const served = await call(harness, uploaded.user.avatarUrl, { session });
  assert.equal(served.status, 404);
});

test("a rejected upload leaves the saved picture untouched", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());
  const good = pngBytes([0x11, 0x22, 0x33]);

  await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(good, "good.png", "image/png")
  });

  for (const [bytes, name, type] of [
    [svgBytes(), "bad.svg", "image/svg+xml"],
    [oversizedBytes(), "huge.png", "image/png"],
    [textBytes(), "fake.png", "image/png"]
  ]) {
    const response = await call(harness, "/api/account/profile-picture", {
      method: "PUT",
      session,
      body: pictureForm(bytes, name, type)
    });
    assert.equal(response.ok, false);
  }

  const stored = await pictureRow(harness, session.userId);
  assert.equal(stored, expectedDataUrl(good, "image/png"));
});

test("the avatar endpoint requires authentication and hides pictures of missing users", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const anonymous = await call(harness, `/api/avatars/${session.userId}`);
  assert.equal(anonymous.status, 401);

  const missing = await call(harness, "/api/avatars/does-not-exist", { session });
  assert.equal(missing.status, 404);
});

test("an administrator can see a member's picture, a signed-out visitor cannot", async () => {
  const harness = createHarness();
  const memberId = await harness.addUser({ displayName: "Member" });
  const memberSession = await harness.signIn(memberId);

  const uploaded = await json(await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session: memberSession,
    body: pictureForm(pngBytes(), "a.png", "image/png")
  }));

  const adminId = await harness.addUser({ role: "admin" });
  const adminSession = await harness.signIn(adminId);

  const seenByAdmin = await call(harness, uploaded.user.avatarUrl, { session: adminSession });
  assert.equal(seenByAdmin.status, 200);

  const seenByStranger = await call(harness, uploaded.user.avatarUrl, {});
  assert.equal(seenByStranger.status, 401);
});

test("stored values cannot inject SQL", async () => {
  const harness = createHarness();
  const hostile = "Robert'); DROP TABLE users;--";
  const session = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account/profile", {
    method: "PATCH",
    session,
    body: JSON.stringify({ displayName: hostile })
  });

  assert.equal(response.status, 200);
  assert.equal((await json(response)).user.name, hostile);

  const row = await harness.DB.prepare(
    "SELECT display_name_override FROM users WHERE id = ?"
  ).bind(session.userId).first();
  assert.equal(row.display_name_override, hostile);

  // The table is still there and still holds the account.
  const count = await harness.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
  assert.equal(count.count, 1);
});

// ---------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------

test("display name changes require authentication", async () => {
  const harness = createHarness();
  const response = await call(harness, "/api/account/profile", {
    method: "PATCH",
    body: JSON.stringify({ displayName: "Someone" })
  });

  assert.equal(response.status, 401);
});

test("display name changes require a valid CSRF token", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account/profile", {
    method: "PATCH",
    session,
    csrf: "wrong",
    body: JSON.stringify({ displayName: "Someone" })
  });

  assert.equal(response.status, 403);
});

test("empty, whitespace-only and overlong display names are rejected", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser({ displayName: "Original" }));

  for (const value of ["", "   ", "\t\n ", "x".repeat(81), 42, null]) {
    const response = await call(harness, "/api/account/profile", {
      method: "PATCH",
      session,
      body: JSON.stringify({ displayName: value })
    });
    assert.equal(response.ok, false, `${JSON.stringify(value)} must be rejected`);
    assert.equal(response.status, 400);
  }

  const row = await harness.DB.prepare(
    "SELECT display_name_override FROM users WHERE id = ?"
  ).bind(session.userId).first();
  assert.equal(row.display_name_override, "Original");
});

test("a valid display name is trimmed, saved and returned everywhere", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser({ displayName: "Old Name" }));

  const response = await call(harness, "/api/account/profile", {
    method: "PATCH",
    session,
    body: JSON.stringify({ displayName: "  Commander Jones  " })
  });

  assert.equal(response.status, 200);
  const result = await json(response);
  assert.equal(result.user.name, "Commander Jones");

  const row = await harness.DB.prepare(
    "SELECT display_name_override FROM users WHERE id = ?"
  ).bind(session.userId).first();
  assert.equal(row.display_name_override, "Commander Jones");

  const me = await json(await call(harness, "/api/auth/me", { session }));
  assert.equal(me.user.name, "Commander Jones");

  const account = await json(await call(harness, "/api/account", { session }));
  assert.equal(account.user.name, "Commander Jones");
});

test("one user cannot edit another user's profile", async () => {
  const harness = createHarness();
  const victimId = await harness.addUser({ displayName: "Victim" });
  const attacker = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account/profile", {
    method: "PATCH",
    session: attacker,
    body: JSON.stringify({ displayName: "Hacked", userId: victimId })
  });

  assert.equal(response.status, 403);

  const row = await harness.DB.prepare(
    "SELECT display_name_override FROM users WHERE id = ?"
  ).bind(victimId).first();
  assert.equal(row.display_name_override, "Victim");
});

// ---------------------------------------------------------------------------
// Permanent account deletion
// ---------------------------------------------------------------------------

test("account deletion requires authentication", async () => {
  const harness = createHarness();
  const response = await call(harness, "/api/account", {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "DELETE" })
  });

  assert.equal(response.status, 401);
});

test("account deletion requires a valid CSRF token", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const response = await call(harness, "/api/account", {
    method: "DELETE",
    session,
    csrf: "nope",
    body: JSON.stringify({ confirmation: "DELETE" })
  });

  assert.equal(response.status, 403);

  const row = await harness.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
    .bind(session.userId).first();
  assert.equal(row.count, 1);
});

test("account deletion requires the exact confirmation word", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  for (const confirmation of ["", "delete", "DELETE ", " DELETE", "REMOVE", undefined]) {
    const response = await call(harness, "/api/account", {
      method: "DELETE",
      session,
      body: JSON.stringify({ confirmation })
    });
    assert.equal(response.status, 400, `${String(confirmation)} must be rejected`);
  }

  const row = await harness.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
    .bind(session.userId).first();
  assert.equal(row.count, 1);
});

test("the last active administrator cannot delete their own account", async () => {
  const harness = createHarness();
  const adminId = await harness.addUser({ role: "admin" });
  const session = await harness.signIn(adminId);

  const response = await call(harness, "/api/account", {
    method: "DELETE",
    session,
    body: JSON.stringify({ confirmation: "DELETE" })
  });

  assert.equal(response.status, 409);
  assert.match((await json(response)).error, /last active administrator/i);

  const row = await harness.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
    .bind(adminId).first();
  assert.equal(row.count, 1);
});

test("only active administrators count towards the last-administrator guard", async () => {
  const harness = createHarness();
  const adminId = await harness.addUser({ role: "admin" });
  await harness.addUser({ role: "admin", status: "suspended" });
  const session = await harness.signIn(adminId);

  // A suspended administrator cannot administer anything, so this account is
  // still the last one that can.
  const blocked = await call(harness, "/api/account", {
    method: "DELETE",
    session,
    body: JSON.stringify({ confirmation: "DELETE" })
  });
  assert.equal(blocked.status, 409);

  await harness.addUser({ role: "admin" });

  const allowed = await call(harness, "/api/account", {
    method: "DELETE",
    session,
    body: JSON.stringify({ confirmation: "DELETE" })
  });
  assert.equal(allowed.status, 200);
});

test("deletion removes the account, identity, sessions and picture, and keeps history usable", async () => {
  const harness = createHarness();

  const departingId = await harness.addUser({ role: "admin", displayName: "Departing Admin" });
  await harness.addUser({ role: "admin", displayName: "Staying Admin" });
  const memberId = await harness.addUser({ displayName: "Member" });

  const session = await harness.signIn(departingId);
  const memberSession = await harness.signIn(memberId);

  await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(pngBytes(), "me.png", "image/png")
  });

  const codingSessionId = randomUUID();
  await harness.DB.prepare(`
    INSERT INTO coding_sessions (id, title, description, starts_at, ends_at, location, status, created_by)
    VALUES (?, 'Bridge sim', 'Helm and weapons', ?, NULL, 'Bridge Command', 'scheduled', ?)
  `).bind(codingSessionId, new Date(Date.now() + 86400000).toISOString(), departingId).run();

  // Member attended the session; the departing admin marked it.
  await harness.DB.prepare(`
    INSERT INTO session_attendance (session_id, user_id, status, marked_by, notes, marked_at)
    VALUES (?, ?, 'present', ?, 'On the helm', CURRENT_TIMESTAMP)
  `).bind(codingSessionId, memberId, departingId).run();

  // The departing admin's own attendance is theirs to remove.
  await harness.DB.prepare(`
    INSERT INTO session_attendance (session_id, user_id, status, marked_by, notes, marked_at)
    VALUES (?, ?, 'late', ?, '', CURRENT_TIMESTAMP)
  `).bind(codingSessionId, departingId, departingId).run();

  await harness.DB.prepare(`
    INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details_json)
    VALUES (?, ?, 'admin.session.created', 'coding_session', ?, '{}')
  `).bind(randomUUID(), departingId, codingSessionId).run();

  const response = await call(harness, "/api/account", {
    method: "DELETE",
    session,
    body: JSON.stringify({ confirmation: "DELETE" })
  });

  assert.equal(response.status, 200);
  const result = await json(response);
  assert.deepEqual(result, { ok: true, deleted: true });

  // Signed out properly.
  const cleared = response.headers.getSetCookie();
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every(value => value.includes("Max-Age=0")));
  assert.ok(cleared.some(value => value.startsWith("__Host-csp_session=")));

  const user = await harness.DB.prepare("SELECT * FROM users WHERE id = ?").bind(departingId).first();
  assert.equal(user, null, "the account row must be gone");

  const identities = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM auth_identities WHERE user_id = ?"
  ).bind(departingId).first();
  assert.equal(identities.count, 0, "sign-in identities must be removed");

  const sessionsLeft = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM server_sessions WHERE user_id = ?"
  ).bind(departingId).first();
  assert.equal(sessionsLeft.count, 0, "every session for the account must be invalidated");

  // The old cookie must not authenticate anyone now.
  const afterDeletion = await call(harness, "/api/auth/me", { session });
  assert.deepEqual(await json(afterDeletion), { user: null });

  const keptSession = await harness.DB.prepare(
    "SELECT * FROM coding_sessions WHERE id = ?"
  ).bind(codingSessionId).first();
  assert.ok(keptSession, "the coding session itself must survive");
  assert.equal(keptSession.created_by, null, "its creator reference must be detached");

  const memberMark = await harness.DB.prepare(
    "SELECT * FROM session_attendance WHERE session_id = ? AND user_id = ?"
  ).bind(codingSessionId, memberId).first();
  assert.ok(memberMark, "another member's attendance must survive");
  assert.equal(memberMark.marked_by, null, "the marker reference must be detached");
  assert.equal(memberMark.notes, "On the helm");

  const ownMark = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_attendance WHERE user_id = ?"
  ).bind(departingId).first();
  assert.equal(ownMark.count, 0, "the departing account's own attendance must go");

  const audit = await harness.DB.prepare(
    "SELECT actor_user_id, action FROM audit_log WHERE target_id = ?"
  ).bind(departingId).all();
  const deletion = audit.results.filter(row => row.action === "account.deleted");
  assert.equal(deletion.length, 1, "the deletion itself must be recorded");
  assert.equal(deletion[0].actor_user_id, null, "the record must not keep the person");

  // The untouched member is still signed in and the database still works.
  const member = await json(await call(harness, "/api/auth/me", { session: memberSession }));
  assert.equal(member.user.name, "Member");
  const usersLeft = await harness.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
  assert.equal(usersLeft.count, 2);
});

test("a plain member's account can be deleted", async () => {
  const harness = createHarness();
  const id = await harness.addUser();
  const session = await harness.signIn(id);

  const response = await call(harness, "/api/account", {
    method: "DELETE",
    session,
    body: JSON.stringify({ confirmation: "DELETE" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, deleted: true });
  const row = await harness.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").bind(id).first();
  assert.equal(row.count, 0);
});

// ---------------------------------------------------------------------------
// Roles, admin surfaces and preview mode
// ---------------------------------------------------------------------------

test("a non-admin cannot reach administrator endpoints, whatever the client claims", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  // The preview toggle is a display concern only: the server reads the real
  // role from the database on every request.
  for (const [path, options] of [
    ["/api/admin/overview", {}],
    ["/api/admin/users", {}],
    ["/api/admin/audit", {}],
    ["/api/admin/sessions", {}],
    ["/api/admin/users/" + session.userId, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" })
    }]
  ]) {
    const response = await call(harness, path, { session, ...options });
    assert.equal(response.status, 403, `${path} must stay closed to non-admins`);
  }

  const row = await harness.DB.prepare("SELECT role FROM users WHERE id = ?").bind(session.userId).first();
  assert.equal(row.role, "user");
});

test("the account payload never carries the stored picture itself", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session,
    body: pictureForm(pngBytes(), "a.png", "image/png")
  });

  const me = await json(await call(harness, "/api/auth/me", { session }));
  const serialised = JSON.stringify(me);

  assert.ok(!serialised.includes("base64"), "no image data may be embedded in account responses");
  assert.ok(!("profilePictureKey" in me.user), "the old R2-shaped field must be gone");
  assert.equal(typeof me.user.avatarUrl, "string");
});

test("administrator listings expose avatar details for each account", async () => {
  const harness = createHarness();
  const memberId = await harness.addUser({ displayName: "Member" });
  const memberSession = await harness.signIn(memberId);
  const adminSession = await harness.signIn(await harness.addUser({ role: "admin" }));

  await call(harness, "/api/account/profile-picture", {
    method: "PUT",
    session: memberSession,
    body: pictureForm(pngBytes(), "a.png", "image/png")
  });

  const list = await json(await call(harness, "/api/admin/users", { session: adminSession }));
  const member = list.users.find(user => user.id === memberId);
  const admin = list.users.find(user => user.id === adminSession.userId);

  assert.equal(member.hasProfilePicture, true);
  assert.match(member.avatarUrl, /^\/api\/avatars\//);
  assert.equal(admin.hasProfilePicture, false);
  assert.equal(admin.avatarUrl, null);
});

test("attendance listings expose avatar details for each member", async () => {
  const harness = createHarness();
  const memberId = await harness.addUser({ displayName: "Member" });
  const adminSession = await harness.signIn(await harness.addUser({ role: "admin" }));

  const codingSessionId = randomUUID();
  await harness.DB.prepare(`
    INSERT INTO coding_sessions (id, title, description, starts_at, ends_at, location, status, created_by)
    VALUES (?, 'Bridge sim', '', ?, NULL, '', 'scheduled', ?)
  `).bind(codingSessionId, new Date(Date.now() + 86400000).toISOString(), adminSession.userId).run();

  const attendance = await json(await call(
    harness,
    `/api/admin/sessions/${codingSessionId}/attendance`,
    { session: adminSession }
  ));

  const member = attendance.attendance.find(row => row.userId === memberId);
  assert.ok(member, "the member must appear in the attendance list");
  assert.equal(member.hasProfilePicture, false);
  assert.equal(member.avatarUrl, null);
  assert.equal(member.status, "unmarked");
});

test("the last administrator is also protected from demotion", async () => {
  const harness = createHarness();
  const adminId = await harness.addUser({ role: "admin" });
  const session = await harness.signIn(adminId);

  const response = await call(harness, `/api/admin/users/${adminId}`, {
    method: "PATCH",
    session,
    body: JSON.stringify({ role: "user" })
  });

  assert.equal(response.status, 409);
});

// ---------------------------------------------------------------------------
// Session editing and attendance, which now save themselves
// ---------------------------------------------------------------------------

async function seedCodingSession(harness, adminId) {
  const id = randomUUID();
  await harness.DB.prepare(`
    INSERT INTO coding_sessions (id, title, description, starts_at, ends_at, location, status, created_by)
    VALUES (?, 'Bridge sim', 'Helm and weapons', ?, ?, 'Bridge Command', 'scheduled', ?)
  `).bind(id, new Date(Date.now() + 86400000).toISOString(), null, adminId).run();
  return id;
}

test("a session update answers with the stored record so the form can echo it", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const sessionId = await seedCodingSession(harness, admin.userId);

  const response = await call(harness, `/api/admin/sessions/${sessionId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({
      title: "Bridge sim - full run",
      description: "Every station manned.",
      location: "Discord Call",
      status: "completed"
    })
  });

  assert.equal(response.status, 200);
  const result = await json(response);
  assert.equal(result.ok, true);
  assert.equal(result.session.title, "Bridge sim - full run");
  assert.equal(result.session.location, "Discord Call");
  assert.equal(result.session.status, "completed");

  const stored = await harness.DB.prepare(
    "SELECT title, location, status FROM coding_sessions WHERE id = ?"
  ).bind(sessionId).first();
  assert.equal(stored.title, "Bridge sim - full run");
  assert.equal(stored.location, "Discord Call");
  assert.equal(stored.status, "completed");
});

test("an invalid session update is refused and changes nothing", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const sessionId = await seedCodingSession(harness, admin.userId);

  for (const patch of [
    { title: "" },
    { title: "x".repeat(121) },
    { status: "invented" },
    { location: "x".repeat(201) },
    { description: "x".repeat(4001) },
    { unknownField: true }
  ]) {
    const response = await call(harness, `/api/admin/sessions/${sessionId}`, {
      method: "PATCH",
      session: admin,
      body: JSON.stringify(patch)
    });
    assert.equal(response.ok, false, `${JSON.stringify(patch)} must be refused`);
  }

  const stored = await harness.DB.prepare("SELECT title FROM coding_sessions WHERE id = ?")
    .bind(sessionId).first();
  assert.equal(stored.title, "Bridge sim");
});

test("marking attendance updates in place instead of piling up rows", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser({ displayName: "Member" });
  const sessionId = await seedCodingSession(harness, admin.userId);

  const url = `/api/admin/sessions/${sessionId}/attendance/${memberId}`;

  const marked = await call(harness, url, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "present", notes: "On the helm" })
  });
  assert.equal(marked.status, 200);
  const markedResult = await json(marked);
  assert.equal(markedResult.ok, true);
  assert.equal(markedResult.attendance.userId, memberId);
  assert.equal(markedResult.attendance.name, "Member");
  assert.equal(markedResult.attendance.status, "present");
  assert.equal(markedResult.attendance.notes, "On the helm");
  assert.ok(markedResult.attendance.markedAt, "the server must report when it stored the mark");

  // Marking someone again must change the row, never add another.
  const changed = await call(harness, url, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "late", notes: "Arrived late" })
  });
  const changedAttendance = (await json(changed)).attendance;
  assert.equal(changedAttendance.status, "late");
  assert.equal(changedAttendance.notes, "Arrived late");

  const rows = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_attendance WHERE session_id = ? AND user_id = ?"
  ).bind(sessionId, memberId).first();
  assert.equal(rows.count, 1, "a member must hold exactly one attendance row per session");

  const listing = await json(await call(
    harness,
    `/api/admin/sessions/${sessionId}/attendance`,
    { session: admin }
  ));
  const member = listing.attendance.find(row => row.userId === memberId);
  assert.equal(member.status, "late");
  assert.equal(member.notes, "Arrived late");

  // And the present/late count the card shows must follow it.
  const adminList = await json(await call(harness, "/api/admin/sessions", { session: admin }));
  assert.equal(adminList.sessions[0].attendanceCount, 1);
});

test("attendance refuses an unknown status or a missing member", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser();
  const sessionId = await seedCodingSession(harness, admin.userId);

  const badStatus = await call(harness, `/api/admin/sessions/${sessionId}/attendance/${memberId}`, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "maybe" })
  });
  assert.equal(badStatus.status, 400);

  const missing = await call(harness, `/api/admin/sessions/${sessionId}/attendance/does-not-exist`, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "present" })
  });
  assert.equal(missing.status, 404);

  const unknownSession = await call(harness, "/api/admin/sessions/nope/attendance", {
    session: admin
  });
  assert.equal(unknownSession.status, 404);
});

test("a created session answers with the stored record", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));

  const response = await call(harness, "/api/admin/sessions", {
    method: "POST",
    session: admin,
    body: JSON.stringify({
      title: "New session",
      description: "",
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      endsAt: null,
      location: "Discord Call"
    })
  });

  assert.equal(response.status, 201);
  const result = await json(response);
  assert.equal(result.ok, true);
  assert.equal(result.session.title, "New session");
  assert.equal(result.session.location, "Discord Call");
  assert.equal(result.session.id, result.id);
});

// ---------------------------------------------------------------------------
// My profile page
// ---------------------------------------------------------------------------

test("the profile page returns the signed-in member's own details and attendance", async () => {
  const harness = createHarness();
  const memberId = await harness.addUser({ displayName: "Robyn", email: "robyn@example.test" });
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));

  const codingSessionId = randomUUID();
  await harness.DB.prepare(`
    INSERT INTO coding_sessions (id, title, description, starts_at, ends_at, location, status, created_by)
    VALUES (?, 'Bridge sim - helm', '', ?, ?, 'Discord Call', 'completed', ?)
  `).bind(codingSessionId, new Date(Date.now() - 86400000).toISOString(), null, admin.userId).run();

  await harness.DB.prepare(`
    INSERT INTO session_attendance (session_id, user_id, status, marked_by, notes, marked_at)
    VALUES (?, ?, 'present', ?, 'On the helm', CURRENT_TIMESTAMP)
  `).bind(codingSessionId, memberId, admin.userId).run();

  const session = await harness.signIn(memberId);
  const response = await call(harness, "/api/profile", { session });

  assert.equal(response.status, 200);
  const data = await json(response);

  assert.equal(data.user.name, "Robyn");
  assert.equal(data.email, "robyn@example.test");
  assert.equal(data.stats.attended, 1);
  assert.equal(data.attendance.length, 1);
  assert.equal(data.attendance[0].sessionId, codingSessionId);
  assert.equal(data.attendance[0].title, "Bridge sim - helm");
  assert.equal(data.attendance[0].attendanceStatus, "present");
  assert.equal(data.attendance[0].location, "Discord Call");
  assert.equal(data.attendance[0].notes, "On the helm");

  // The administrator's own identity must not ride along on this payload.
  assert.ok(!JSON.stringify(data).includes(admin.userId));
});

test("the profile page requires a session and refuses writes", async () => {
  const harness = createHarness();
  const session = await harness.signIn(await harness.addUser());

  const anonymous = await call(harness, "/api/profile");
  assert.equal(anonymous.status, 401);

  const write = await call(harness, "/api/profile", { method: "POST", session, body: "{}" });
  assert.equal(write.status, 405);
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

test("groups are administrator-only and every write needs a CSRF token", async () => {
  const harness = createHarness();
  const member = await harness.signIn(await harness.addUser());
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));

  assert.equal((await call(harness, "/api/admin/groups", { session: member })).status, 403);
  assert.equal((await call(harness, "/api/admin/groups")).status, 401);

  const noToken = await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    csrf: "wrong",
    body: JSON.stringify({ name: "Helm crew" })
  });
  assert.equal(noToken.status, 403);

  const listing = await call(harness, "/api/admin/groups", { session: admin });
  assert.equal(listing.status, 200);
});

test("a group can be created, filled, emptied and deleted", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser({ displayName: "Robyn" });

  const created = await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "  Helm   crew  ", description: "Helm and weapons" })
  });

  assert.equal(created.status, 201);
  const group = (await json(created)).group;
  assert.equal(group.name, "Helm crew", "names are trimmed and collapsed");
  assert.equal(group.description, "Helm and weapons");
  assert.equal(group.members.length, 0);

  const added = await call(harness, `/api/admin/groups/${group.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: memberId })
  });
  assert.equal(added.status, 200);
  const addedGroup = (await json(added)).group;
  assert.equal(addedGroup.members.length, 1);
  assert.equal(addedGroup.members[0].name, "Robyn");

  // Adding the same person twice must not duplicate them.
  await call(harness, `/api/admin/groups/${group.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: memberId })
  });
  const rows = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?"
  ).bind(group.id).first();
  assert.equal(rows.count, 1);

  const removed = await call(harness, `/api/admin/groups/${group.id}/members/${memberId}`, {
    method: "DELETE",
    session: admin
  });
  assert.equal(removed.status, 200);
  assert.equal((await json(removed)).group.members.length, 0);

  const deleted = await call(harness, `/api/admin/groups/${group.id}`, {
    method: "DELETE",
    session: admin
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await json(deleted), { ok: true, deleted: true });

  const gone = await call(harness, `/api/admin/groups/${group.id}`, { session: admin });
  assert.equal(gone.status, 404);
});

test("group names are validated and unique", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));

  const first = await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "Helm crew" })
  });
  assert.equal(first.status, 201);

  // Same name in a different case is still the same group.
  const clash = await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "helm CREW" })
  });
  assert.equal(clash.status, 409);

  for (const name of ["", "   ", "x".repeat(81), 42, null]) {
    const response = await call(harness, "/api/admin/groups", {
      method: "POST",
      session: admin,
      body: JSON.stringify({ name })
    });
    assert.equal(response.status, 400, `${String(name)} must be refused`);
  }
});

test("groups reject unknown users and unknown groups", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const suspendedId = await harness.addUser({ status: "suspended" });

  const created = await json(await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "Helm crew" })
  }));

  const unknownUser = await call(harness, `/api/admin/groups/${created.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: "nope" })
  });
  assert.equal(unknownUser.status, 404);

  const suspended = await call(harness, `/api/admin/groups/${created.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: suspendedId })
  });
  assert.equal(suspended.status, 404, "suspended accounts cannot be added to a group");

  const unknownGroup = await call(harness, "/api/admin/groups/nope/members", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: suspendedId })
  });
  assert.equal(unknownGroup.status, 404);
});

test("deleting an account clears their group memberships", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser({ displayName: "Robyn" });
  const member = await harness.signIn(memberId);

  const group = (await json(await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "Helm crew" })
  }))).group;

  await call(harness, `/api/admin/groups/${group.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: memberId })
  });

  await call(harness, "/api/account", {
    method: "DELETE",
    session: member,
    body: JSON.stringify({ confirmation: "DELETE" })
  });

  const rows = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM group_members WHERE user_id = ?"
  ).bind(memberId).first();
  assert.equal(rows.count, 0, "no membership may outlive the account");

  // The group itself survives.
  const still = await call(harness, `/api/admin/groups/${group.id}`, { session: admin });
  assert.equal(still.status, 200);
  assert.equal((await json(still)).group.members.length, 0);
});

// ---------------------------------------------------------------------------
// Unmarking attendance
// ---------------------------------------------------------------------------

test("a member can be put back to unmarked and the mark is really removed", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser({ displayName: "Robyn" });
  const sessionId = await seedCodingSession(harness, admin.userId);
  const url = `/api/admin/sessions/${sessionId}/attendance/${memberId}`;

  await call(harness, url, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "present", notes: "On the helm" })
  });

  const cleared = await call(harness, url, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "unmarked" })
  });

  assert.equal(cleared.status, 200);
  const result = await json(cleared);
  assert.equal(result.attendance, null, "an unmarked member has no stored mark");
  assert.equal(result.attendanceCount, 0, "the present count drops back to zero");
  assert.equal(result.markedCount, 0);

  const rows = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_attendance WHERE session_id = ? AND user_id = ?"
  ).bind(sessionId, memberId).first();
  assert.equal(rows.count, 0, "the row must be deleted, not merely flagged");

  const listing = await json(await call(
    harness,
    `/api/admin/sessions/${sessionId}/attendance`,
    { session: admin }
  ));
  assert.equal(listing.attendance.find(row => row.userId === memberId).status, "unmarked");
});

test("unmarking works for one member without touching the rest of the session", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const first = await harness.addUser({ displayName: "First" });
  const second = await harness.addUser({ displayName: "Second" });
  const sessionId = await seedCodingSession(harness, admin.userId);

  for (const userId of [first, second]) {
    await call(harness, `/api/admin/sessions/${sessionId}/attendance/${userId}`, {
      method: "PUT",
      session: admin,
      body: JSON.stringify({ status: "present" })
    });
  }

  const result = await json(await call(
    harness,
    `/api/admin/sessions/${sessionId}/attendance/${first}`,
    { method: "PUT", session: admin, body: JSON.stringify({ status: "unmarked" }) }
  ));

  assert.equal(result.attendanceCount, 1, "only the cleared member stops counting");

  const listing = await json(await call(
    harness,
    `/api/admin/sessions/${sessionId}/attendance`,
    { session: admin }
  ));
  assert.equal(listing.attendance.find(row => row.userId === first).status, "unmarked");
  assert.equal(listing.attendance.find(row => row.userId === second).status, "present");
});

test("unmarking a member who was never marked is harmless", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser();
  const sessionId = await seedCodingSession(harness, admin.userId);

  const response = await call(harness, `/api/admin/sessions/${sessionId}/attendance/${memberId}`, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ status: "unmarked" })
  });

  assert.equal(response.status, 200);
  assert.equal((await json(response)).attendance, null);
});

// ---------------------------------------------------------------------------
// Locking sessions to people and groups
// ---------------------------------------------------------------------------

test("an unlocked session is visible to everyone, a locked one only to its members", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const allowed = await harness.addUser({ displayName: "Allowed" });
  const outsider = await harness.addUser({ displayName: "Outsider" });
  const allowedSession = await harness.signIn(allowed);
  const outsiderSession = await harness.signIn(outsider);

  const open = await seedCodingSession(harness, admin.userId);
  const locked = await seedCodingSession(harness, admin.userId);

  const lock = await call(harness, `/api/admin/sessions/${locked}/access/users/${allowed}`, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ allowed: true })
  });
  assert.equal(lock.status, 200);
  const access = (await json(lock)).access;
  assert.equal(access.restricted, true);
  assert.deepEqual(access.users.map(user => user.id), [allowed]);

  const adminList = await json(await call(harness, "/api/sessions", { session: admin }));
  assert.equal(adminList.sessions.length, 2, "an administrator sees everything");
  assert.equal(adminList.sessions.find(item => item.id === locked).restricted, true);
  assert.equal(adminList.sessions.find(item => item.id === open).restricted, false);

  const allowedList = await json(await call(harness, "/api/sessions", { session: allowedSession }));
  assert.deepEqual(allowedList.sessions.map(item => item.id).sort(), [open, locked].sort(),
    "someone on the list still sees the open session too");

  const outsiderList = await json(await call(harness, "/api/sessions", { session: outsiderSession }));
  assert.deepEqual(outsiderList.sessions.map(item => item.id), [open],
    "a locked session must not appear for anyone not on the list");
});

test("a group grant locks a session to that group's members", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const inGroup = await harness.addUser({ displayName: "In group" });
  const notInGroup = await harness.addUser({ displayName: "Not in group" });

  const group = (await json(await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "Helm crew" })
  }))).group;

  await call(harness, `/api/admin/groups/${group.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: inGroup })
  });

  const locked = await seedCodingSession(harness, admin.userId);

  await call(harness, `/api/admin/sessions/${locked}/access/groups/${group.id}`, {
    method: "PUT",
    session: admin,
    body: JSON.stringify({ allowed: true })
  });

  const memberList = await json(await call(harness, "/api/sessions", { session: await harness.signIn(inGroup) }));
  assert.deepEqual(memberList.sessions.map(item => item.id), [locked]);

  const otherList = await json(await call(harness, "/api/sessions", { session: await harness.signIn(notInGroup) }));
  assert.equal(otherList.sessions.length, 0);

  // Leaving the group closes the door again.
  await call(harness, `/api/admin/groups/${group.id}/members/${inGroup}`, {
    method: "DELETE",
    session: admin
  });
  const afterLeave = await json(await call(harness, "/api/sessions", { session: await harness.signIn(inGroup) }));
  assert.equal(afterLeave.sessions.length, 0);
});

test("a session locked to both people and groups admits either", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const named = await harness.addUser({ displayName: "Named directly" });
  const grouped = await harness.addUser({ displayName: "In the group" });
  const neither = await harness.addUser({ displayName: "Neither" });

  const group = (await json(await call(harness, "/api/admin/groups", {
    method: "POST",
    session: admin,
    body: JSON.stringify({ name: "Helm crew" })
  }))).group;
  await call(harness, `/api/admin/groups/${group.id}/members`, {
    method: "POST",
    session: admin,
    body: JSON.stringify({ userId: grouped })
  });

  const locked = await seedCodingSession(harness, admin.userId);
  await call(harness, `/api/admin/sessions/${locked}/access/users/${named}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  });
  await call(harness, `/api/admin/sessions/${locked}/access/groups/${group.id}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  });

  for (const userId of [named, grouped]) {
    const list = await json(await call(harness, "/api/sessions", { session: await harness.signIn(userId) }));
    assert.deepEqual(list.sessions.map(item => item.id), [locked]);
  }

  const outsider = await json(await call(harness, "/api/sessions", { session: await harness.signIn(neither) }));
  assert.equal(outsider.sessions.length, 0);
});

test("locking requires an administrator, a session, a real member and a CSRF token", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const member = await harness.signIn(await harness.addUser());
  const target = await harness.addUser();
  const suspended = await harness.addUser({ status: "suspended" });
  const sessionId = await seedCodingSession(harness, admin.userId);

  const url = `/api/admin/sessions/${sessionId}/access/users/${target}`;

  assert.equal((await call(harness, url, {
    method: "PUT", session: member, body: JSON.stringify({ allowed: true })
  })).status, 403);
  assert.equal((await call(harness, url, {
    method: "PUT", body: JSON.stringify({ allowed: true })
  })).status, 401);
  assert.equal((await call(harness, url, {
    method: "PUT", session: admin, csrf: "wrong", body: JSON.stringify({ allowed: true })
  })).status, 403);
  assert.equal((await call(harness, `/api/admin/sessions/nope/access/users/${target}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  })).status, 404);
  assert.equal((await call(harness, `/api/admin/sessions/${sessionId}/access/users/nobody`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  })).status, 404);
  assert.equal((await call(harness, `/api/admin/sessions/${sessionId}/access/users/${suspended}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  })).status, 404, "a suspended account cannot be granted access");
  assert.equal((await call(harness, url, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: "yes" })
  })).status, 400);
});

test("clearing the access list puts a session back in front of everyone", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const outsider = await harness.addUser({ displayName: "Outsider" });
  const outsiderSession = await harness.signIn(outsider);
  const sessionId = await seedCodingSession(harness, admin.userId);

  await call(harness, `/api/admin/sessions/${sessionId}/access/users/${outsider}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  });
  await call(harness, `/api/admin/sessions/${sessionId}/access/users/${outsider}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: false })
  });

  const access = (await json(await call(
    harness, `/api/admin/sessions/${sessionId}/access`, { session: admin }
  ))).access;
  assert.equal(access.restricted, false);
  assert.equal(access.users.length, 0);

  const cleared = await call(harness, `/api/admin/sessions/${sessionId}/access`, {
    method: "DELETE", session: admin
  });
  assert.equal(cleared.status, 200);
  assert.equal((await json(cleared)).access.restricted, false);
});

test("locking the same person twice does not duplicate the grant", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const target = await harness.addUser();
  const sessionId = await seedCodingSession(harness, admin.userId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await call(harness, `/api/admin/sessions/${sessionId}/access/users/${target}`, {
      method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
    });
  }

  const rows = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_access WHERE session_id = ? AND user_id = ?"
  ).bind(sessionId, target).first();
  assert.equal(rows.count, 1);
});

test("deleting a session removes it and everything attached to it", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const member = await harness.addUser({ displayName: "Member" });
  const memberSession = await harness.signIn(member);

  const sessionId = await seedCodingSession(harness, admin.userId);
  const other = await seedCodingSession(harness, admin.userId);

  await harness.DB.prepare(`
    INSERT INTO session_attendance (session_id, user_id, status, marked_by, notes, marked_at)
    VALUES (?, ?, 'present', ?, '', CURRENT_TIMESTAMP)
  `).bind(sessionId, member, admin.userId).run();
  await harness.DB.prepare(`
    INSERT INTO session_access (session_id, user_id, granted_by) VALUES (?, ?, ?)
  `).bind(sessionId, member, admin.userId).run();

  // Authentication and authorisation first.
  assert.equal((await call(harness, `/api/admin/sessions/${sessionId}`, { method: "DELETE", session: memberSession })).status, 403);
  assert.equal((await call(harness, `/api/admin/sessions/${sessionId}`, { method: "DELETE" })).status, 401);
  assert.equal((await call(harness, `/api/admin/sessions/${sessionId}`, {
    method: "DELETE", session: admin, csrf: "wrong"
  })).status, 403);

  const response = await call(harness, `/api/admin/sessions/${sessionId}`, {
    method: "DELETE", session: admin
  });

  assert.equal(response.status, 200);
  const result = await json(response);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(result.removed.attendance, 1);
  assert.equal(result.removed.userGrants, 1);

  const gone = await harness.DB.prepare("SELECT * FROM coding_sessions WHERE id = ?").bind(sessionId).first();
  assert.equal(gone, null);

  const marks = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_attendance WHERE session_id = ?"
  ).bind(sessionId).first();
  assert.equal(marks.count, 0, "attendance marks must go with the session");

  const grants = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_access WHERE session_id = ?"
  ).bind(sessionId).first();
  assert.equal(grants.count, 0, "access grants must go with the session");

  // The other session and the member are untouched.
  const survivor = await harness.DB.prepare("SELECT title FROM coding_sessions WHERE id = ?").bind(other).first();
  assert.equal(survivor.title, "Bridge sim");
  const still = await json(await call(harness, "/api/auth/me", { session: memberSession }));
  assert.equal(still.user.name, "Member");

  // And it is really gone for everyone.
  const list = await json(await call(harness, "/api/sessions", { session: admin }));
  assert.deepEqual(list.sessions.map(item => item.id), [other]);
});

test("deleting a session that does not exist says so", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));

  const response = await call(harness, "/api/admin/sessions/not-a-session", {
    method: "DELETE",
    session: admin
  });

  assert.equal(response.status, 404);
});

test("deleting an account clears the access grants it held", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const member = await harness.addUser({ displayName: "Member" });
  const memberSession = await harness.signIn(member);
  const sessionId = await seedCodingSession(harness, admin.userId);

  await call(harness, `/api/admin/sessions/${sessionId}/access/users/${member}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  });

  await call(harness, "/api/account", {
    method: "DELETE", session: memberSession, body: JSON.stringify({ confirmation: "DELETE" })
  });

  const grants = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM session_access WHERE user_id = ?"
  ).bind(member).first();
  assert.equal(grants.count, 0, "a deleted account must leave no dangling grant");

  const access = (await json(await call(
    harness, `/api/admin/sessions/${sessionId}/access`, { session: admin }
  ))).access;
  assert.equal(access.restricted, false, "the session reopens once the last grant is gone");
});

// ---------------------------------------------------------------------------
// Suspension, its reason, and masked emails
// ---------------------------------------------------------------------------

test("a suspended account cannot hold a session, even with a valid cookie", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser({ displayName: "Member" });
  const member = await harness.signIn(memberId);

  // The cookie works right up until the account is suspended.
  const before = await call(harness, "/api/auth/me", { session: member });
  assert.equal((await json(before)).user.name, "Member");

  const saved = await call(harness, `/api/admin/users/${memberId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({
      status: "suspended",
      statusReason: "Repeated attendance warnings. Email the crew lead."
    })
  });
  assert.equal(saved.status, 200);

  const sessionsLeft = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM server_sessions WHERE user_id = ?"
  ).bind(memberId).first();
  assert.equal(sessionsLeft.count, 0, "suspending must invalidate every open session");

  // The old cookie is now worthless, even before it is cleared.
  const after = await call(harness, "/api/auth/me", { session: member });
  assert.deepEqual(await json(after), { user: null });

  // And nothing administrative answers for them either.
  assert.equal((await call(harness, "/api/admin/users", { session: member })).status, 401);
});

test("the block notice carries the reason once, then forgets it", async () => {
  const harness = createHarness();

  // Exactly what the server writes when a blocked sign-in is turned away.
  const payload = Buffer.from(
    "suspended:Repeated attendance warnings. Email the crew lead.",
    "utf8"
  ).toString("base64url");

  const first = await call(harness, "/api/auth/blocked", {
    headers: { cookie: `__Host-csp_blocked=${payload}` }
  });

  assert.equal(first.status, 200);
  assert.deepEqual(await json(first), {
    blocked: {
      status: "suspended",
      reason: "Repeated attendance warnings. Email the crew lead."
    }
  });

  const cleared = first.headers.getSetCookie();
  assert.equal(cleared.length, 1);
  assert.ok(cleared[0].startsWith("__Host-csp_blocked="));
  assert.ok(cleared[0].includes("HttpOnly"), "the notice cookie must never be readable by scripts");
  assert.ok(cleared[0].includes("Max-Age=0"), "the notice is one-shot");

  // Nothing there, nothing claimed.
  const second = await call(harness, "/api/auth/blocked");
  assert.deepEqual(await json(second), { blocked: null });

  // Rubbish in the cookie must not crash the endpoint.
  const rubbish = await call(harness, "/api/auth/blocked", {
    headers: { cookie: "__Host-csp_blocked=!!!not-base64!!!" }
  });
  assert.equal(rubbish.status, 200);
  assert.deepEqual(await json(rubbish), { blocked: null });
});

test("an account pending deletion is blocked with its own wording", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser();
  const member = await harness.signIn(memberId);

  await call(harness, `/api/admin/users/${memberId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ status: "pending_deletion", statusReason: "Requested by the member." })
  });

  const after = await call(harness, "/api/auth/me", { session: member });
  assert.deepEqual(await json(after), { user: null });

  const notice = await call(harness, "/api/auth/blocked", {
    headers: {
      cookie: `__Host-csp_blocked=${Buffer.from("pending_deletion:Requested by the member.", "utf8").toString("base64url")}`
    }
  });
  assert.deepEqual((await json(notice)).blocked, {
    status: "pending_deletion",
    reason: "Requested by the member."
  });
});

test("reinstating an account clears the stored reason", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser();

  await call(harness, `/api/admin/users/${memberId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ status: "suspended", statusReason: "On hold." })
  });

  await call(harness, `/api/admin/users/${memberId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ status: "active" })
  });

  const row = await harness.DB.prepare(
    "SELECT status, status_reason FROM users WHERE id = ?"
  ).bind(memberId).first();

  assert.equal(row.status, "active");
  assert.equal(row.status_reason, null, "a live account must not carry a stale reason");
});

test("a reason is only accepted on an account that is actually blocked", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const activeId = await harness.addUser();

  const onActive = await call(harness, `/api/admin/users/${activeId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ statusReason: "I was told to do this." })
  });
  assert.equal(onActive.status, 400);

  const tooLong = await call(harness, `/api/admin/users/${activeId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ status: "suspended", statusReason: "x".repeat(501) })
  });
  assert.equal(tooLong.status, 400);

  // The same update with a status is fine.
  const fine = await call(harness, `/api/admin/users/${activeId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ status: "suspended", statusReason: "On hold." })
  });
  assert.equal(fine.status, 200);
});

test("a non-admin cannot set a suspension reason", async () => {
  const harness = createHarness();
  const member = await harness.signIn(await harness.addUser());
  const target = await harness.addUser();

  const response = await call(harness, `/api/admin/users/${target}`, {
    method: "PATCH",
    session: member,
    body: JSON.stringify({ status: "suspended", statusReason: "I made this up." })
  });

  assert.equal(response.status, 403);
});

test("the admin user list carries the email and the reason for the panel to mask", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const memberId = await harness.addUser({ displayName: "Robyn", email: "robyn@example.test" });

  await call(harness, `/api/admin/users/${memberId}`, {
    method: "PATCH",
    session: admin,
    body: JSON.stringify({ status: "suspended", statusReason: "Contact the crew lead." })
  });

  const list = await json(await call(harness, "/api/admin/users?q=robyn", { session: admin }));
  const member = list.users.find(user => user.id === memberId);

  assert.equal(member.emails, "robyn@example.test");
  assert.equal(member.statusReason, "Contact the crew lead.");

  // A signed-out visitor still cannot see any of it.
  assert.equal((await call(harness, "/api/admin/users")).status, 401);
});

test("the profile's scheduled count only includes sessions that member can attend", async () => {
  const harness = createHarness();
  const admin = await harness.signIn(await harness.addUser({ role: "admin" }));
  const invited = await harness.addUser({ displayName: "Invited" });
  const outsider = await harness.addUser({ displayName: "Outsider" });
  const grouped = await harness.addUser({ displayName: "In group" });

  const open = await seedCodingSession(harness, admin.userId);
  const locked = await seedCodingSession(harness, admin.userId);
  const groupLocked = await seedCodingSession(harness, admin.userId);
  const past = await seedCodingSession(harness, admin.userId);

  await harness.DB.prepare(
    "UPDATE coding_sessions SET status = 'completed', starts_at = ? WHERE id = ?"
  ).bind(new Date(Date.now() - 86400000).toISOString(), past).run();

  await call(harness, `/api/admin/sessions/${locked}/access/users/${invited}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  });

  const group = (await json(await call(harness, "/api/admin/groups", {
    method: "POST", session: admin, body: JSON.stringify({ name: "Helm crew" })
  }))).group;
  await call(harness, `/api/admin/groups/${group.id}/members`, {
    method: "POST", session: admin, body: JSON.stringify({ userId: grouped })
  });
  await call(harness, `/api/admin/sessions/${groupLocked}/access/groups/${group.id}`, {
    method: "PUT", session: admin, body: JSON.stringify({ allowed: true })
  });

  const invitedStats = (await json(await call(
    harness, "/api/profile", { session: await harness.signIn(invited) }
  ))).stats;
  assert.equal(invitedStats.upcoming, 2, "the open one plus the one locked to them, not the whole portal");

  const groupedStats = (await json(await call(
    harness, "/api/profile", { session: await harness.signIn(grouped) }
  ))).stats;
  assert.equal(groupedStats.upcoming, 2);

  const outsiderStats = (await json(await call(
    harness, "/api/profile", { session: await harness.signIn(outsider) }
  ))).stats;
  assert.equal(outsiderStats.upcoming, 1, "only the open session is attendable");

  const adminStats = (await json(await call(
    harness, "/api/profile", { session: admin }
  ))).stats;
  assert.equal(adminStats.upcoming, 3, "an administrator can attend every scheduled session");

  // The number must agree with the list it is counting.
  const list = await json(await call(harness, "/api/sessions", { session: await harness.signIn(outsider) }));
  const scheduled = list.sessions.filter(item => item.status === "scheduled");
  assert.equal(outsiderStats.upcoming, scheduled.length);
});

// ---------------------------------------------------------------------------
// Deployment shape
// ---------------------------------------------------------------------------

test("no shipped source file is byte-order-marked or mis-encoded", () => {
  const files = [
    "../src/server/index.js",
    "../public/app.js",
    "../public/index.html",
    "../public/styles.css",
    "../wrangler.toml",
    "../package.json",
    "../.github/workflows/deploy.yml",
    "../.github/workflows/ci.yml",
    ...migrationNames().map(name => `../migrations/${name}`)
  ];

  // A UTF-8 byte-order mark, and the classic signature of a file that was read
  // and rewritten through a legacy code page: the two-byte lead characters for
  // A-circumflex, a-lowercase-circumflex and a-tilde. A bullet (U+2022) that
  // survives that round trip becomes the three characters a-circumflex,
  // euro sign, quotedblbase, which is what an administrator's masked email
  // address turned into in production once already.
  const misencoded = Buffer.from([0xc3, 0x82]);
  const misencoded2 = Buffer.from([0xc3, 0xa2]);
  const misencoded3 = Buffer.from([0xc3, 0xa3]);

  for (const file of files) {
    const bytes = readFileSync(fileURLToPath(new URL(file, import.meta.url)));

    assert.ok(
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      `${file} starts with a UTF-8 byte-order mark`
    );

    for (const signature of [misencoded, misencoded2, misencoded3]) {
      const at = bytes.indexOf(signature);
      if (at >= 0) {
        assert.fail(
          `${file} contains mis-encoded text at byte ${at}: ` +
          `${bytes.subarray(at, at + 8).toString("latin1")}`
        );
      }
    }
  }
});

test("the email mask is built from characters that cannot be mis-encoded", async () => {
  const app = readFileSync(
    fileURLToPath(new URL("../public/app.js", import.meta.url)),
    "utf8"
  );

  const body = app.match(/function maskEmail\(value\) \{[\s\S]*?\n\}/);
  assert.ok(body, "maskEmail must exist");

  assert.equal(Buffer.from(body[0], "utf8").every(byte => byte < 128), true,
    "maskEmail must be pure ASCII so no code page can corrupt the mask");

  // And it must actually mask: first letter only, no domain.
  assert.ok(body[0].includes('@'), "the mask must keep the @ separator");
});

test("migration files are unique, ordered and include the profile picture column", () => {
  const names = migrationNames();

  assert.equal(new Set(names).size, names.length, "no duplicate migration files");
  assert.deepEqual([...names].sort(), names, "migrations must be applied in order");
  assert.ok(names.includes("0006_account_settings.sql"), "0006 must be preserved");
  assert.ok(names.includes("0007_profile_picture_data.sql"), "0007 must exist");
  assert.ok(names.includes("0008_groups.sql"), "0008 must exist");
  assert.ok(names.includes("0009_session_access.sql"), "0009 must exist");
  assert.ok(names.includes("0010_status_reason.sql"), "0010 must exist");

  const seven = readFileSync(
    fileURLToPath(new URL("../migrations/0007_profile_picture_data.sql", import.meta.url)),
    "utf8"
  );
  assert.equal((seven.match(/ALTER TABLE users ADD COLUMN/g) || []).length, 1);
  assert.match(seven, /profile_picture_data TEXT/);
});

test("no R2 binding or code path survives anywhere in the shipped source", () => {
  const files = [
    "../wrangler.toml",
    "../src/server/index.js",
    "../public/app.js",
    "../public/index.html",
    "../package.json"
  ];

  const forbidden = /PROFILE_PICTURES|coding-sessions-profile-pictures|r2_buckets|\br2\b/;

  for (const file of files) {
    const contents = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.ok(!forbidden.test(contents), `${file} still references R2`);
  }

  const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
  assert.match(toml, /database_id = "66574faa-06ae-412d-9244-d44003014964"/);
  assert.match(toml, /binding = "DB"/);
});

test("the deployed origin serves the portal shell for non-API paths", async () => {
  const harness = createHarness();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/settings`),
    { DB: harness.DB, ASSETS: { fetch: async () => new Response("asset:/settings", { status: 200 }) } }
  );

  assert.equal(response.status, 200);
});
