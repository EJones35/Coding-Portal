const MAX_PICTURE_BYTES = 350 * 1024;
const ALLOWED_PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const THEME_KEY = "csp-theme";

const el = selector => document.querySelector(selector);

const statusElement = el("#api-status");
const authMessage = el("#auth-message");
const notice = el("#notice");
const googleSignIn = el("#google-sign-in");
const signedInActions = el("#signed-in-actions");
const accountName = el("#account-name");
const accountRole = el("#account-role");
const accountAvatar = el("#account-avatar");
const signOutButton = el("#sign-out");
const adminNav = el("#admin-nav");
const settingsNav = el("#settings-nav");
const profileNav = el("#profile-nav");
const adminPanel = el("#admin-panel");
const adminMessage = el("#admin-message");
const adminUsers = el("#admin-users");
const adminUsersTable = el("#admin-users-table");
const adminAudit = el("#admin-audit");
const adminSearch = el("#admin-search");
const groupsList = el("#groups-list");
const groupsMessage = el("#groups-message");
const groupCreateForm = el("#group-create-form");
const profilePanel = el("#profile-panel");
const profileAvatar = el("#profile-avatar");
const adminStatsHidden = ["#stat-total", "#stat-active", "#stat-suspended", "#stat-admins"];
const previewBanner = el("#preview-banner");
const previewExit = el("#preview-exit");
const previewToggle = el("#preview-toggle");
const adminPreferences = el("#admin-preferences");
const homeSection = el("#home");
const pageTitle = el("#page-title");
const settingsPanel = el("#settings-panel");
const settingsMessage = el("#settings-message");
const settingsAvatar = el("#settings-avatar");
const profileForm = el("#profile-form");
const displayNameInput = el("#display-name-input");
const profilePictureInput = el("#profile-picture-input");
const pictureFile = el("#picture-file");
const cancelPictureButton = el("#cancel-picture");
const removePictureButton = el("#remove-picture");
const saveChangesButton = el("#save-changes");
const themeRadios = [...document.querySelectorAll('input[name="theme"]')];
const openDeleteAccount = el("#open-delete-account");
const deleteModal = el("#delete-modal");
const deleteCancel = el("#delete-cancel");
const deleteConfirmation = el("#delete-confirmation");
const deleteConfirm = el("#delete-confirm");

const sessionsPanel = el("#sessions-panel");
const sessionsList = el("#sessions-list");
const sessionsMessageElement = el("#sessions-message");
const sessionCreatePanel = el("#session-create-panel");
const sessionCreateForm = el("#session-create-form");
const sessionAttendancePanel = el("#session-attendance-panel");
const sessionAttendanceTitle = el("#session-attendance-title");
const sessionAttendanceContent = el("#session-attendance-content");
const sessionEditPanel = el("#session-edit-panel");
const sessionEditState = el("#session-edit-state");
const editTitleInput = el("#edit-title");
const editDescriptionInput = el("#edit-description");
const editStartsInput = el("#edit-starts");
const editEndsInput = el("#edit-ends");
const editLocationInput = el("#edit-location");
const editStatusInput = el("#edit-status");
const sessionSearch = el("#session-search");
const sessionSearchEmpty = el("#session-search-empty");
const sessionsNavCount = el("#sessions-nav-count");
const buildStatus = el("#build-status");
const nextSessionCard = el("#next-session-card");
const nextSessionTitle = el("#next-session-title");
const nextSessionMeta = el("#next-session-meta");

// Live "N present" text on each card, kept in step with attendance changes.
const attendanceCountNodes = new Map();

let currentUser = null;
let accountResolved = false;
let userPreviewMode = false;
let sessionsCache = [];

// The file the user has chosen but not yet saved. Kept apart from the input so
// a cleared input can never be mistaken for "no file chosen", and so a stale
// File object from an earlier selection can never be uploaded by accident.
let pendingPicture = null;
let pendingPreviewUrl = null;

let loadedRoute = null;
let removeArmed = false;
let removeArmTimer = null;
let settingsBusy = false;
let searchTimer = null;
let sessionSearchTimer = null;
let groupsCache = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCookie(name) {
  const secureName = `__Host-${name}`;

  for (const part of document.cookie.split(";")) {
    const item = part.trim();
    const separator = item.indexOf("=");
    if (separator < 0) continue;

    const key = item.slice(0, separator);
    if (key === name || key === secureName) return item.slice(separator + 1);
  }

  return null;
}

function initialFor(name) {
  return String(name || "User").trim().charAt(0).toUpperCase() || "U";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Every avatar in the app goes through here: one image element, one fallback.
// If the image cannot be decoded the initials take over rather than leaving a
// broken-image placeholder on screen.
function fillAvatar(container, avatarUrl, name) {
  const initial = initialFor(name);
  container.replaceChildren();
  container.classList.remove("has-image");

  if (!avatarUrl) {
    container.textContent = initial;
    return;
  }

  const image = document.createElement("img");
  image.alt = "";
  image.decoding = "async";
  image.addEventListener("error", () => {
    container.replaceChildren();
    container.classList.remove("has-image");
    container.textContent = initial;
  }, { once: true });
  image.src = avatarUrl;

  container.append(image);
  container.classList.add("has-image");
}

function renderAvatar(container, user) {
  fillAvatar(container, user && user.avatarUrl, user && user.name);
}

function createAvatarChip(user) {
  const chip = document.createElement("span");
  chip.className = "account-avatar chip-avatar";
  chip.setAttribute("aria-hidden", "true");
  fillAvatar(chip, user && user.avatarUrl, user && user.name);
  return chip;
}

function showAuthMessage(message) {
  authMessage.textContent = message;
  authMessage.hidden = !message;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("notice-error", Boolean(isError));
  notice.hidden = !message;
}

function showSettingsMessage(message, isError = false) {
  settingsMessage.textContent = message;
  settingsMessage.classList.toggle("error", isError);
}

function sessionsMessage(text, error = false) {
  sessionsMessageElement.textContent = text;
  sessionsMessageElement.classList.toggle("error", error);
}

async function apiFetch(path, options = {}, kind = "Request") {
  const headers = { accept: "application/json", ...(options.headers || {}) };

  if (options.method && options.method !== "GET") {
    const token = getCookie("csp_csrf");
    if (!token) throw new Error("Security token missing. Refresh the page and try again.");
    headers["x-csrf-token"] = token;
    if (options.body && !(options.body instanceof FormData)) {
      headers["content-type"] = "application/json";
    }
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });

  let result = {};
  try {
    result = await response.json();
  } catch {
    if (!response.ok) throw new Error(`${kind} failed.`);
  }

  if (!response.ok) throw new Error(result.error || `${kind} failed.`);
  return result;
}

// ---------------------------------------------------------------------------
// Cookie consent
//
// Every cookie this portal sets is essential to signing in, so this is a
// notice and a record of consent rather than a gate. Nothing is blocked until
// a choice is made, because blocking sign-in would break the site for no
// privacy gain. Bumping CONSENT_VERSION asks again when the policy changes.
// ---------------------------------------------------------------------------

const CONSENT_KEY = "csp-consent";
const CONSENT_VERSION = 1;

function readConsent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONSENT_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== CONSENT_VERSION) return null;
    if (parsed.decidedAt && Date.now() - Number(parsed.decidedAt) > 365 * 24 * 60 * 60 * 1000) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function showCookieBanner() {
  const banner = el("#cookie-banner");
  if (!banner) return;
  banner.hidden = false;
  // Move focus so the dialog is reachable and announced, not stranded.
  requestAnimationFrame(() => el("#cookie-accept")?.focus());
}

function recordConsent(choice) {
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({
      version: CONSENT_VERSION,
      choice,
      decidedAt: Date.now(),
      // Deliberately no identifying data. This is a preference, not a record.
      essentialOnly: true
    }));
  } catch {
    // Storage unavailable: the choice simply will not be remembered.
  }
  el("#cookie-banner").hidden = true;
}

el("#cookie-accept").addEventListener("click", () => recordConsent("accepted"));
el("#cookie-essential").addEventListener("click", () => recordConsent("essential"));

el("#cookie-reopen").addEventListener("click", event => {
  event.preventDefault();
  showCookieBanner();
});

if (!readConsent()) showCookieBanner();

// ---------------------------------------------------------------------------
// Remembered interface state
//
// Which sections are minimised, and which emails are revealed, are facts about
// how this browser likes the portal, not about the account. They live in
// localStorage alongside the theme so a refresh or a navigation puts the admin
// panel back exactly as they left it.
// ---------------------------------------------------------------------------

const UI_KEY = "csp-ui";

function readUiState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeUiState(patch) {
  const next = { ...readUiState(), ...patch };

  try {
    localStorage.setItem(UI_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable. The interface still works, it just will not remember.
  }

  return next;
}

const COLLAPSIBLE = {
  users: "#admin-users-section",
  groups: "#admin-groups-section",
  audit: "#admin-audit",
  achievements: "#profile-achievements",
  "achievements-admin": "#admin-achievements-section"
};

function applyCollapse(name, collapsed, { persist = true } = {}) {
  const target = document.querySelector(COLLAPSIBLE[name]);
  const button = document.querySelector(`[data-collapse-toggle="${name}"]`);
  if (!target || !button) return;

  target.hidden = collapsed;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.textContent = collapsed ? "Show" : "Hide";

  if (persist) {
    const collapsed_now = readUiState().collapsed || {};
    writeUiState({ collapsed: { ...collapsed_now, [name]: collapsed } });
  }
}

function restoreCollapses() {
  const state = readUiState().collapsed || {};
  for (const name of Object.keys(COLLAPSIBLE)) {
    if (typeof state[name] === "boolean") applyCollapse(name, state[name], { persist: false });
  }
}

function revealedEmails() {
  const revealed = readUiState().revealedEmails;
  return revealed && typeof revealed === "object" ? revealed : {};
}

function setEmailRevealed(userId, revealed) {
  const state = readUiState();
  const current = state.revealedEmails || {};

  if (revealed) current[userId] = true;
  else delete current[userId];

  writeUiState({ revealedEmails: current });
}

for (const button of document.querySelectorAll("[data-collapse-toggle]")) {
  button.addEventListener("click", () => {
    const name = button.dataset.collapseToggle;
    const target = document.querySelector(COLLAPSIBLE[name]);
    if (!target) return;
    applyCollapse(name, !target.hidden);
  });
}

restoreCollapses();

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  const value = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = value;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = value === "light" ? "#eef3f9" : "#080d18";
  for (const radio of themeRadios) radio.checked = radio.value === value;
}

function loadStoredTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  applyTheme(stored === "light" ? "light" : "dark");
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    showSettingsMessage("This browser will not remember your theme choice.", true);
    return false;
  }
}

for (const radio of themeRadios) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    applyTheme(radio.value);
    saveTheme(radio.value);
    showSettingsMessage(`Appearance updated: ${radio.value} theme.`);
  });
}

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

function releasePendingPreview() {
  if (pendingPreviewUrl) {
    URL.revokeObjectURL(pendingPreviewUrl);
    pendingPreviewUrl = null;
  }
}

function clearPendingPicture() {
  releasePendingPreview();
  pendingPicture = null;
  profilePictureInput.value = "";
  pictureFile.hidden = true;
  pictureFile.textContent = "";
  cancelPictureButton.hidden = true;
}

function renderSavedAvatar() {
  if (currentUser) renderAvatar(settingsAvatar, currentUser);
  else settingsAvatar.textContent = "U";
}

function renderPendingPreview() {
  if (!pendingPreviewUrl) {
    renderSavedAvatar();
    return;
  }

  settingsAvatar.classList.add("has-image");
  settingsAvatar.replaceChildren();

  const image = document.createElement("img");
  image.alt = "";
  image.addEventListener("error", () => {
    clearPendingPicture();
    renderSavedAvatar();
    showSettingsMessage("That file could not be previewed. Try a different image.", true);
  }, { once: true });
  image.src = pendingPreviewUrl;
  settingsAvatar.append(image);
}

function armRemoveButton() {
  removeArmed = true;
  removePictureButton.textContent = "Confirm remove";
  removePictureButton.classList.add("armed");
  clearTimeout(removeArmTimer);
  removeArmTimer = setTimeout(disarmRemoveButton, 5000);
}

function disarmRemoveButton() {
  removeArmed = false;
  removePictureButton.textContent = "Remove picture";
  removePictureButton.classList.remove("armed");
}

function showSignedOut() {
  currentUser = null;
  userPreviewMode = false;
  clearPendingPicture();
  disarmRemoveButton();

  adminNav.hidden = true;
  settingsNav.hidden = true;
  adminPanel.hidden = true;
  settingsPanel.hidden = true;
  previewBanner.hidden = true;

  googleSignIn.hidden = false;
  signedInActions.hidden = true;
  accountName.textContent = "Account";
  accountRole.textContent = "Member";
  renderAvatar(accountAvatar, null);

  loadedRoute = null;
}

function showSignedIn(user) {
  currentUser = user;
  adminPreferences.hidden = user.role !== "admin";
  if (user.role !== "admin") userPreviewMode = false;

  googleSignIn.hidden = true;
  signedInActions.hidden = false;

  accountName.textContent = user.name || "User";
  accountRole.textContent = user.role === "admin" ? "Administrator" : "Member";

  // Same URL every time would let the browser reuse a decoded, obsolete
  // image. avatarUrl carries a version that changes with the stored bytes.
  renderAvatar(accountAvatar, user);
  renderAvatar(settingsAvatar, user);

  displayNameInput.value = user.name || "";
  removePictureButton.hidden = !user.hasProfilePicture;
  disarmRemoveButton();

  previewBanner.hidden = !(user.role === "admin" && userPreviewMode);
  adminNav.hidden = !(user.role === "admin" && !userPreviewMode);
}

async function loadAccount() {
  try {
    const result = await apiFetch("/api/auth/me", {}, "Account lookup");
    accountResolved = true;
    if (result.user) showSignedIn(result.user);
    else showSignedOut();
    updatePageView();
  } catch {
    accountResolved = true;
    showSignedOut();
    updatePageView();
    showAuthMessage("Unable to check your account. Please refresh and try again.");
  }
}

async function checkApiStatus() {
  try {
    const result = await apiFetch("/api/health", {}, "Health check");
    if (result.status !== "ok") throw new Error("unhealthy");
    statusElement.textContent = "Portal services connected";
    renderBuildStatus("PORTAL ONLINE", false);
  } catch {
    statusElement.textContent = "Portal services unavailable";
    renderBuildStatus("SERVICES UNAVAILABLE", true);
  }
}

// ---------------------------------------------------------------------------
// Sign in and sign out
// ---------------------------------------------------------------------------
function showRedirectMessage() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("auth_error");
  if (!error) return;

  const messages = {
    google_signin_failed: "Google sign-in could not be completed. Please try again.",
    google_signin_cancelled: "Google sign-in was cancelled.",
    account_suspended: "Your account is suspended.",
    account_pending_deletion: "Your account is pending deletion."
  };

  const blocked = error.startsWith("account_");
  if (!blocked) showAuthMessage(messages[error] || "Sign-in failed. Please try again.");

  params.delete("auth_error");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);

  // The reason is kept in a cookie rather than the URL, so it is fetched
  // separately and never sits in history or a referrer.
  if (blocked) showBlockNotice(error, messages[error]);
}

async function showBlockNotice(error, fallback) {
  let status = error.replace("account_", "");
  let reason = "";

  try {
    const result = await apiFetch("/api/auth/blocked", {}, "Sign-in notice");
    if (result.blocked) {
      status = result.blocked.status || status;
      reason = result.blocked.reason || "";
    }
  } catch {
    // The generic message still goes up below.
  }

  const headline = status === "pending_deletion"
    ? "Your account is pending deletion."
    : "Your account is suspended.";

  showAuthMessage(headline + (reason ? " Reason: " + reason : ""));
  showNotice(headline + (reason ? " Reason: " + reason : " Please contact an administrator."), true);
}

// ASCII on purpose. This mask is generated from user data at runtime, and a
// non-ASCII character here can be destroyed by any editor that round-trips the
// file through a legacy code page - which is exactly what happened once.
function maskEmail(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes("@")) return "";

  const local = trimmed.slice(0, trimmed.indexOf("@"));
  return local.slice(0, 1) +
    "*".repeat(Math.min(4, Math.max(2, local.length - 1))) +
    "@" + "*".repeat(6);
}

googleSignIn.addEventListener("click", event => {
  event.preventDefault();
  window.location.assign("/api/auth/google?next=%2F");
});

signOutButton.addEventListener("click", async () => {
  signOutButton.disabled = true;
  showAuthMessage("");

  try {
    const csrfToken = getCookie("csp_csrf");
    if (!csrfToken) throw new Error("Your security token is missing. Refresh the page and try again.");

    await apiFetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": csrfToken } }, "Sign out");
    showSignedOut();
    updatePageView();
    showAuthMessage("You have signed out successfully.");
    showNotice("");
  } catch (error) {
    showAuthMessage(error.message || "Unable to sign out. Please try again.");
  } finally {
    signOutButton.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Profile picture selection
// ---------------------------------------------------------------------------

function pictureProblem(file) {
  if (!file) return "Choose an image file first.";
  if (file.size < 1) return "That file is empty.";
  if (file.size > MAX_PICTURE_BYTES) {
    return `Choose an image smaller than ${formatBytes(MAX_PICTURE_BYTES)}. That one is ${formatBytes(file.size)}.`;
  }
  if (file.type && !ALLOWED_PICTURE_TYPES.includes(file.type)) {
    return "Use a PNG, JPEG, WebP or GIF image.";
  }
  return null;
}

// Every picture input outside the profile page shows the chosen image itself,
// not just the file name a native file input leaves you with. One helper for
// all of them, so the three cannot drift apart.
//
// The object URL is revoked the moment it is replaced or cleared. A decoded
// image kept alive by a stale URL is a leak, and the profile preview already
// works this way - this is the same pattern, generalised.
function createPicturePreview(input, options = {}) {
  const { clearable = true, onClear = null } = options;

  const tile = document.createElement("div");
  tile.className = "picture-preview";
  tile.hidden = true;
  tile.setAttribute("aria-hidden", "true");

  const note = document.createElement("p");
  note.className = "settings-help picture-preview-note";
  note.hidden = true;

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "text-button";
  clear.textContent = "Clear selection";
  clear.hidden = true;

  let url = null;

  function reset() {
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
    tile.replaceChildren();
    tile.hidden = true;
    note.classList.remove("error");
    note.textContent = "";
    note.hidden = true;
    clear.hidden = true;
  }

  /** Show a chosen file, or explain why it was refused. */
  function show(file, problem) {
    reset();

    if (problem) {
      note.classList.add("error");
      note.textContent = problem;
      note.hidden = false;
      return;
    }
    if (!file) return;

    note.textContent = `${file.name} (${formatBytes(file.size)})`;
    note.hidden = false;

    url = URL.createObjectURL(file);
    const image = document.createElement("img");
    image.alt = "";
    image.addEventListener("error", () => {
      reset();
      note.classList.add("error");
      note.textContent = "That file could not be previewed. Try a different image.";
      note.hidden = false;
    }, { once: true });
    image.src = url;

    tile.append(image);
    tile.hidden = false;
    if (clearable) clear.hidden = false;
  }

  clear.addEventListener("click", () => {
    reset();
    input.value = "";
    if (onClear) onClear();
  });

  return { tile, note, clear, show, reset };
}

profilePictureInput.addEventListener("change", () => {
  const file = profilePictureInput.files && profilePictureInput.files[0];

  // Cleared straight away so choosing the very same file again still fires a
  // change event instead of appearing to do nothing.
  profilePictureInput.value = "";

  clearPendingPicture();

  if (!file) {
    renderSavedAvatar();
    return;
  }

  const problem = pictureProblem(file);
  if (problem) {
    renderSavedAvatar();
    showSettingsMessage(problem, true);
    return;
  }

  pendingPicture = file;
  pendingPreviewUrl = URL.createObjectURL(file);

  pictureFile.textContent = `Selected: ${file.name} (${formatBytes(file.size)}) - not saved yet`;
  pictureFile.hidden = false;
  cancelPictureButton.hidden = false;

  // The preview shows the file just chosen, not the picture already saved.
  renderPendingPreview();
  showSettingsMessage("Picture selected. Choose Save changes to upload it.");
});

cancelPictureButton.addEventListener("click", () => {
  clearPendingPicture();
  renderSavedAvatar();
  showSettingsMessage("Picture selection cancelled. Your saved picture is unchanged.");
});

profileForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (settingsBusy) return;

  const wantedName = displayNameInput.value.trim();
  const currentName = (currentUser && currentUser.name) || "";

  if (!wantedName) {
    showSettingsMessage("Enter a display name.", true);
    displayNameInput.focus();
    return;
  }
  if (wantedName.length > 80) {
    showSettingsMessage("Display name must be 80 characters or fewer.", true);
    displayNameInput.focus();
    return;
  }

  const nameChanged = wantedName !== currentName;
  if (!nameChanged && !pendingPicture) {
    showSettingsMessage("Nothing to save yet.");
    return;
  }

  settingsBusy = true;
  saveChangesButton.disabled = true;

  try {
    if (nameChanged) {
      const result = await apiFetch(
        "/api/account/profile",
        { method: "PATCH", body: JSON.stringify({ displayName: wantedName }) },
        "Profile update"
      );
      if (result.user) showSignedIn(result.user);
    }

    if (pendingPicture) {
      const file = pendingPicture;
      const form = new FormData();
      form.append("picture", file);

      const result = await apiFetch(
        "/api/account/profile-picture",
        { method: "PUT", body: form },
        "Upload"
      );

      // Only now is the new picture the saved one.
      clearPendingPicture();
      if (result.user) showSignedIn(result.user);
      renderSavedAvatar();
      showSettingsMessage(nameChanged ? "Display name and profile picture saved." : "Profile picture saved.");
    } else {
      showSettingsMessage("Display name saved.");
    }
  } catch (error) {
    // The previously saved picture is untouched: nothing was cleared and no
    // local state pretends the upload happened.
    showSettingsMessage(error.message || "Unable to save your changes.", true);
  } finally {
    settingsBusy = false;
    saveChangesButton.disabled = false;
  }
});

removePictureButton.addEventListener("click", async () => {
  if (!removeArmed) {
    armRemoveButton();
    showSettingsMessage("Choose Remove picture again to confirm.");
    return;
  }

  disarmRemoveButton();
  clearPendingPicture();

  try {
    const result = await apiFetch("/api/account/profile-picture", { method: "DELETE" }, "Remove picture");
    if (result.user) showSignedIn(result.user);
    renderSavedAvatar();
    showSettingsMessage("Profile picture removed. Your initials are back.");
  } catch (error) {
    showSettingsMessage(error.message || "Unable to remove your profile picture.", true);
  }
});

// ---------------------------------------------------------------------------
// Permanent account deletion
// ---------------------------------------------------------------------------

let previouslyFocused = null;

function openDeleteModal() {
  previouslyFocused = document.activeElement;
  deleteConfirmation.value = "";
  deleteConfirm.disabled = true;
  deleteModal.hidden = false;
  document.body.classList.add("modal-open");
  deleteConfirmation.focus();
}

function closeDeleteModal() {
  deleteModal.hidden = true;
  document.body.classList.remove("modal-open");
  deleteConfirmation.value = "";
  deleteConfirm.disabled = true;
  if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
}

openDeleteAccount.addEventListener("click", openDeleteModal);
deleteCancel.addEventListener("click", closeDeleteModal);

deleteModal.addEventListener("mousedown", event => {
  if (event.target === deleteModal) closeDeleteModal();
});

// Escape backs out of whatever is open, innermost first. It used to answer only
// the delete dialog, so every other panel had to be closed by hunting for its own
// close button - and the one that mattered, an accidental edit form, was the
// hardest to find.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (!deleteModal.hidden) {
    closeDeleteModal();
    return;
  }
  for (const toggle of document.querySelectorAll('[data-access-toggle][aria-expanded="true"]')) {
    toggle.click();
    return;
  }
  if (!sessionAttendancePanel.hidden) {
    closeAttendancePanel();
    return;
  }
  if (!sessionEditPanel.hidden) {
    closeEditPanel();
    return;
  }
});

deleteConfirmation.addEventListener("input", () => {
  deleteConfirm.disabled = deleteConfirmation.value.trim() !== "DELETE";
});

el("#delete-account-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (deleteConfirmation.value.trim() !== "DELETE") {
    showSettingsMessage("Type DELETE exactly to confirm.", true);
    return;
  }

  deleteConfirm.disabled = true;
  deleteConfirm.textContent = "Deleting...";

  try {
    // The server checks the confirmation and the session again; this dialog is
    // a courtesy, not the control.
    const result = await apiFetch(
      "/api/account",
      { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) },
      "Account deletion"
    );

    if (!result.ok || !result.deleted) {
      throw new Error("The account was not deleted. Nothing has been changed.");
    }

    closeDeleteModal();
    deleteConfirm.textContent = "Permanently delete account";
    showSignedOut();
    showNotice("Your account has been permanently deleted. Your profile picture and sign-in identity have been removed.");
    window.location.hash = "home";
    updatePageView();
  } catch (error) {
    deleteConfirm.disabled = false;
    deleteConfirm.textContent = "Permanently delete account";
    showSettingsMessage(error.message || "Unable to delete your account.", true);
  }
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const ROUTE_TITLES = {
  home: "Overview",
  sessions: "Sessions",
  profile: "My profile",
  settings: "Settings",
  admin: "Admin panel"
};

function currentRoute() {
  const raw = (window.location.hash || "#home").replace(/^#/, "");
  return Object.prototype.hasOwnProperty.call(ROUTE_TITLES, raw) ? raw : "home";
}

function updatePageView() {
  const route = currentRoute();
  const isAdmin = Boolean(currentUser && currentUser.role === "admin" && currentUser.status === "active");
  const previewing = isAdmin && userPreviewMode;

  if (!isAdmin) userPreviewMode = false;

  // The account check has not answered yet, so anything that depends on it
  // cannot be decided. Bail out and wait - loadAccount() calls this again.
  // Without this, opening the portal straight at #admin bounces to #home,
  // because the first run sees nobody signed in.
  if (!accountResolved && ["admin", "settings", "profile", "sessions"].includes(route)) {
    adminPanel.hidden = true;
    sessionsPanel.hidden = true;
    settingsPanel.hidden = true;
    profilePanel.hidden = true;
    return;
  }

  if (route === "admin" && !isAdmin) {
    window.location.hash = "home";
    return;
  }
  if (route === "settings" && !currentUser) {
    window.location.hash = "home";
    return;
  }
  if (route === "profile" && !currentUser) {
    window.location.hash = "home";
    return;
  }
  if (route === "admin" && userPreviewMode) {
    window.location.hash = "settings";
    return;
  }

  previewBanner.hidden = !previewing;
  adminNav.hidden = !(isAdmin && !userPreviewMode);
  settingsNav.hidden = !currentUser;
  profileNav.hidden = !currentUser;
  adminPreferences.hidden = !isAdmin;
  previewToggle.textContent = userPreviewMode ? "Switch to admin view" : "Switch to user view";

  for (const link of document.querySelectorAll(".nav-item[data-route]")) {
    link.classList.toggle("active", link.dataset.route === route);
  }

  homeSection.hidden = route !== "home";
  profilePanel.hidden = route !== "profile";
  sessionsPanel.hidden = route !== "sessions";
  settingsPanel.hidden = route !== "settings";
  adminPanel.hidden = !(route === "admin" && isAdmin && !userPreviewMode);
  pageTitle.textContent = ROUTE_TITLES[route];

  if (route !== "home") showNotice("");
  if (route === "settings" && currentUser) {
    displayNameInput.value = currentUser.name || "";
    renderSavedAvatar();
    removePictureButton.hidden = !currentUser.hasProfilePicture;
    showSettingsMessage("");
  }

  if (loadedRoute !== route) {
    loadedRoute = route;
    if (route === "admin") {
      loadAdmin();
      loadGroups();
      loadAchievements();
    }
    // The overview shows what is next, so it needs the sessions. It runs the
    // same loader rather than a second, summary-only fetch: two code paths
    // reading the same endpoint is how the overview and the list start to
    // disagree about what is scheduled. Panel visibility is the routing's job,
    // which is why the loader no longer un-hides anything itself.
    if (route === "sessions" || route === "home") loadSessions();
    if (route === "profile") {
      loadProfile();
      loadMyAchievements();
    }
  }
}

function setPreviewMode(enabled) {
  userPreviewMode = Boolean(enabled) && Boolean(currentUser && currentUser.role === "admin");
  if (userPreviewMode && currentUser) {
    adminPanel.hidden = true;
    adminPreferences.hidden = false;
    previewBanner.hidden = false;
  }
  refreshRouteData();
}

previewToggle.addEventListener("click", () => setPreviewMode(!userPreviewMode));
previewExit.addEventListener("click", () => setPreviewMode(false));

// Switching view changes which sessions exist for this account, so the list
// has to be rebuilt rather than merely re-shown.
function refreshRouteData() {
  loadedRoute = null;
  updatePageView();
}

window.addEventListener("hashchange", updatePageView);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionDate(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const SESSION_STATUS_LABELS = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled"
};

function sessionStatusLabel(value) {
  return SESSION_STATUS_LABELS[value] || value || "Scheduled";
}

// "Thu 20 Nov, 18:00" answers *when*. It does not answer *how soon*, which is the
// question somebody actually opens a sessions page with. This is the second
// reading, shown next to the first rather than replacing it.
function relativeTime(value, now) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";

  const reference = Number(now);
  let seconds = Math.round((date.getTime() - (Number.isFinite(reference) ? reference : Date.now())) / 1000);
  const past = seconds < 0;
  seconds = Math.abs(seconds);

  // Within a minute either way is "now", not "in 0 seconds".
  if (seconds < 60) return "Happening now";

  let label = "minute";
  let size = 60;
  for (const [unit, unitSeconds] of [["minute", 60], ["hour", 3600], ["day", 86400], ["week", 604800]]) {
    if (seconds < unitSeconds) break;
    label = unit;
    size = unitSeconds;
  }

  const amount = Math.max(1, Math.round(seconds / size));
  const text = `${amount} ${label}${amount === 1 ? "" : "s"}`;
  return past ? `${text} ago` : `in ${text}`;
}

// Every word must appear somewhere on the card, so adding a word narrows the
// list instead of emptying it. An empty box matches everything, which is what
// makes clearing it feel like clearing rather than undoing.
function matchesSessionQuery(item, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item && item.title, item && item.description, item && item.location]
    .map(value => String(value || "").toLowerCase())
    .join("\n");
  return needle.split(/\s+/).every(word => haystack.includes(word));
}

// The one session to put on the overview. Anything scheduled, soonest first, and
// a session already under way still counts as next - a list that skips the thing
// happening right now is wrong at exactly the moment it is read.
function nextSession(sessions, now) {
  const reference = Number(now);
  const clock = Number.isFinite(reference) ? reference : Date.now();
  let best = null;
  let bestTime = Infinity;

  for (const item of sessions || []) {
    if (!item || item.status !== "scheduled") continue;
    const time = new Date(item.startsAt).getTime();
    if (!Number.isFinite(time)) continue;
    // Started over an hour ago and still marked scheduled: stale, not next.
    if (time < clock - 3600000) continue;
    if (time < bestTime) {
      bestTime = time;
      best = item;
    }
  }

  return best;
}

// Completing a session is not deleting it. It is the difference between "still
// to come" and "already happened": the session keeps its attendance, its
// history and its visibility, and it stops sitting in the upcoming list. Nothing
// is lost by completing something, which is why the past list is one click away
// rather than gone.
function splitSessions(sessions) {
  const upcoming = [];
  const past = [];
  for (const item of sessions || []) {
    if (item.status === "scheduled") upcoming.push(item);
    else past.push(item);
  }
  return { upcoming, past };
}

function sessionBucketFor(status) {
  return status === "scheduled" ? "upcoming" : "past";
}

let sessionGroupUpcoming = null;
let sessionGroupPast = null;

// Whether the history is folded away is a fact about how this browser likes the
// portal, so it is remembered with everything else under `csp-ui`.
function pastSectionCollapsed() {
  return Boolean((readUiState().collapsed || {}).sessionsPast);
}

function rememberPastCollapsed(collapsed) {
  const state = readUiState().collapsed || {};
  if (collapsed) state.sessionsPast = true;
  else delete state.sessionsPast;
  writeUiState({ collapsed: state });
}

function buildSessionGroup(bucket, title, emptyText) {
  const section = document.createElement("section");
  section.className = "session-group";

  const heading = document.createElement("div");
  heading.className = "session-group-heading";

  const label = document.createElement("h3");
  label.className = "session-group-title";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondary-button";
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-controls", "sessions-" + bucket);

  heading.append(label, toggle);

  const empty = document.createElement("p");
  empty.className = "empty-state session-group-empty";
  empty.textContent = emptyText;

  const grid = document.createElement("div");
  grid.className = "sessions-list session-group-list";
  grid.id = "sessions-" + bucket;

  section.append(heading, empty, grid);

  return { bucket, section, label, toggle, empty, grid, count: 0 };
}

function syncSessionGroup(group, { collapsed } = {}) {
  if (!group) return;
  const title = group.bucket === "upcoming" ? "Upcoming" : "Past";
  group.label.textContent = `${title} (${group.count})`;
  group.empty.hidden = group.count > 0;
  const folded = collapsed === undefined ? group.grid.hidden : collapsed;
  group.grid.hidden = folded;
  group.toggle.setAttribute("aria-expanded", String(!folded));
  group.toggle.textContent = folded ? "Show" : "Hide";
}

function renderSessionGroups() {
  sessionsList.replaceChildren();
  sessionGroupUpcoming = null;
  sessionGroupPast = null;

  const upcoming = buildSessionGroup(
    "upcoming",
    "Upcoming",
    "Nothing scheduled. Anything you add will show up here."
  );
  const past = buildSessionGroup(
    "past",
    "Past",
    "No sessions have been completed or cancelled yet."
  );

  for (const group of [upcoming, past]) {
    group.toggle.addEventListener("click", () => {
      const opening = group.grid.hidden;
      group.grid.hidden = !opening;
      group.toggle.setAttribute("aria-expanded", String(opening));
      group.toggle.textContent = opening ? "Hide" : "Show";
      if (group === past) rememberPastCollapsed(!opening);
    });
    sessionsList.append(group.section);
  }

  sessionGroupUpcoming = upcoming;
  sessionGroupPast = past;

  syncSessionGroup(upcoming);
  // A remembered "history folded away" is honoured on load, so a portal that was
  // left tidy stays tidy after a refresh.
  syncSessionGroup(past, { collapsed: pastSectionCollapsed() });
}

// Put a card in the bucket its status belongs to. Used both when the list is
// first built and when an administrator completes or reopens a session, so the
// card travels between the two lists in place rather than being re-fetched -
// reloading is what used to collapse the attendance panel out from under people.
function routeSessionCard(card, status) {
  const group = sessionBucketFor(status) === "upcoming" ? sessionGroupUpcoming : sessionGroupPast;
  if (!group) {
    sessionsList.append(card);
    return;
  }
  group.grid.append(card);
  group.count += 1;
  syncSessionGroup(group);
}

function moveSessionCard(card, status) {
  const from = card.dataset.sessionPast === "yes" ? sessionGroupPast : sessionGroupUpcoming;
  const to = sessionBucketFor(status) === "upcoming" ? sessionGroupUpcoming : sessionGroupPast;
  if (from && from !== to) {
    from.count = Math.max(0, from.count - 1);
    syncSessionGroup(from);
  }
  routeSessionCard(card, status);
}

// Filtering hides cards in place. It never rebuilds the list: a rebuild is what
// collapses the attendance panel out from under whoever is working in it, and a
// search box that did that would make the panel unusable.
function applySessionFilter() {
  const query = sessionSearch ? sessionSearch.value : "";
  const cards = sessionsList.querySelectorAll(".session-card");
  let shown = 0;

  for (const card of cards) {
    const item = sessionsCache.find(entry => entry.id === card.dataset.sessionId);
    const match = !item || matchesSessionQuery(item, query);
    card.hidden = !match;
    if (match) shown += 1;
  }

  if (sessionSearchEmpty) sessionSearchEmpty.hidden = shown > 0 || !query.trim();
  updateSessionsNavCount();
}

// The sidebar answers "how much is waiting for me" without opening the page.
function updateSessionsNavCount() {
  if (!sessionsNavCount) return;
  const upcoming = sessionsCache.filter(item => item && item.status === "scheduled").length;
  sessionsNavCount.textContent = upcoming ? String(upcoming) : "";
  sessionsNavCount.hidden = upcoming === 0;
}

// The overview used to be a welcome panel and three links. It now answers the
// first question a member has, which is what is next and when.
function renderNextSession() {
  if (!nextSessionCard) return;
  const item = nextSession(sessionsCache);

  if (!item) {
    nextSessionCard.hidden = true;
    return;
  }

  nextSessionCard.hidden = false;
  nextSessionTitle.textContent = item.title || "Untitled session";
  const when = sessionDate(item.startsAt);
  const relative = relativeTime(item.startsAt);
  const where = String(item.location || "").trim();
  nextSessionMeta.textContent = [when, relative, where].filter(Boolean).join(" | ");
}

// The build badge used to say DEVELOPMENT BUILD in production, which was a lie
// on the most prominent line of the page. It now reports what it can actually
// see: the health endpoint's answer.
function renderBuildStatus(text, isError) {
  if (!buildStatus) return;
  const label = buildStatus.querySelector("span:last-child");
  if (!label) return;
  label.textContent = text;
  buildStatus.classList.toggle("status-error", Boolean(isError));
}

async function loadSessions() {
  sessionsMessage("Loading sessions...");
  sessionsList.replaceChildren();
  attendanceCountNodes.clear();
  closeAttendancePanel();
  closeEditPanel();

  const canManage = Boolean(
    currentUser && currentUser.role === "admin" && currentUser.status === "active" && !userPreviewMode
  );
  sessionCreatePanel.hidden = !canManage;

  try {
    // In user preview an administrator is deliberately held to the member
    // view, so a session they are not on stays hidden from them too. The
    // server enforces this; it is not a display trick.
    const data = await apiFetch(
      `/api/sessions${userPreviewMode ? "?view=member" : ""}`,
      {},
      "Sessions"
    );
    sessionsCache = data.sessions || [];

    if (!sessionsCache.length) {
      sessionsMessage("No sessions have been scheduled yet.");
      updateSessionsNavCount();
      renderNextSession();
      return;
    }

    // Two lists rather than one long one: what is still to come, and what has
    // already happened. Completing a session moves it down rather than making
    // it vanish, so the record survives.
    renderSessionGroups();
    const buckets = splitSessions(sessionsCache);
    sessionsMessage(
      buckets.upcoming.length
        ? `${buckets.upcoming.length} upcoming, ${buckets.past.length} past.`
        : `Nothing scheduled. ${buckets.past.length} session(s) in the history below.`
    );

    for (const item of sessionsCache) {
      const card = document.createElement("article");
      card.className = "session-card";
      card.dataset.sessionId = item.id;
      card.dataset.sessionPast = item.status === "scheduled" ? "no" : "yes";

      const heading = document.createElement("div");
      heading.className = "session-card-heading";
      const title = document.createElement("h3");
      title.textContent = item.title;
      title.dataset.sessionTitle = "";
      const status = document.createElement("span");
      status.className = "session-status status-" + item.status;
      status.textContent = sessionStatusLabel(item.status);
      heading.append(title, status);

      if (item.restricted) {
        const lock = document.createElement("span");
        lock.className = "session-lock";
        lock.dataset.sessionLock = "";
        lock.textContent = "Locked";
        lock.title = "Only specific members and groups can see this session";
        heading.append(lock);
      }

      card.append(heading);

      if (item.description) {
        const description = document.createElement("p");
        description.textContent = item.description;
        description.dataset.sessionDescription = "";
        card.append(description);
      }

      card.append(sessionFacts(item));

      const mine = document.createElement("p");
      mine.className = "session-meta";
      mine.textContent = "Your attendance: " + item.myAttendance;
      card.append(mine);

      const count = document.createElement("p");
      count.className = "session-meta";
      count.textContent = `${item.attendanceCount} present`;
      attendanceCountNodes.set(item.id, count);
      card.append(count);

      if (canManage) {
        const actions = document.createElement("div");
        actions.className = "session-actions";

        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "secondary-button";
        edit.textContent = "Edit";
        edit.dataset.editToggle = "";
        edit.setAttribute("aria-expanded", "false");
        edit.setAttribute("aria-controls", "session-edit-panel");
        edit.addEventListener("click", () => {
          if (editingSessionId === item.id) closeEditPanel();
          else openEditPanel(item, edit);
        });

        const attendance = document.createElement("button");
        attendance.type = "button";
        attendance.className = "secondary-button";
        attendance.textContent = "Manage attendance";
        attendance.dataset.attendanceToggle = "";
        attendance.setAttribute("aria-expanded", "false");
        attendance.setAttribute("aria-controls", "session-attendance-panel");
        attendance.addEventListener("click", () => toggleAttendance(item, attendance));

        const select = document.createElement("select");
        select.dataset.sessionStatusSelect = "";
        select.setAttribute("aria-label", "Status for " + item.title);
        for (const value of ["scheduled", "completed", "cancelled"]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = sessionStatusLabel(value);
          option.selected = value === item.status;
          select.append(option);
        }

        // One click for the common case. The dropdown is still there for
        // cancelling and for putting something back, but "we finished that one"
        // should not require finding a select and reading three raw values.
        const complete = createActionButton(
          item.status === "scheduled" ? "Mark completed" : "Reopen"
        );
        complete.dataset.sessionComplete = "";
        complete.addEventListener("click", async () => {
          complete.disabled = true;
          const next = item.status === "scheduled" ? "completed" : "scheduled";
          try {
            const result = await apiFetch("/api/admin/sessions/" + encodeURIComponent(item.id), {
              method: "PATCH",
              body: JSON.stringify({ status: next })
            }, "Session update");
            applySessionUpdate(result.session);
            if (editingSessionId === item.id) setEditState("Saved");
          } catch (error) {
            complete.disabled = false;
            sessionsMessage(error.message, true);
          }
        });
        // Saved the moment it changes. Deliberately no list reload: reloading
        // used to collapse the attendance panel out from under the user.
        select.addEventListener("change", async () => {
          try {
            const result = await apiFetch("/api/admin/sessions/" + encodeURIComponent(item.id), {
              method: "PATCH",
              body: JSON.stringify({ status: select.value })
            }, "Session update");
            applySessionUpdate(result.session);
            if (editingSessionId === item.id) setEditState("Saved");
          } catch (error) {
            select.value = item.status;
            sessionsMessage(error.message, true);
          }
        });

        actions.append(edit, attendance, complete, select);
        card.append(actions);

        const access = createActionButton("Who can see this");
        access.className = "secondary-button access-toggle";
        access.dataset.accessToggle = "";
        access.setAttribute("aria-expanded", "false");
        access.setAttribute("aria-controls", "access-" + item.id);
        access.addEventListener("click", () => toggleAccessPanel(item, card, access));

        const remove = createActionButton("Delete");
        remove.className = "secondary-button danger-link";
        remove.addEventListener("click", () => deleteSession(item, card, remove));

        const extra = document.createElement("div");
        extra.className = "session-actions";
        extra.append(access, remove);
        card.append(extra);

        card.append(buildAccessPanel(item));
      }

      routeSessionCard(card, item.status);
    }

    // Counted and summarised only after every card exists, so the badge and the
    // filter cannot disagree with what is on screen.
    updateSessionsNavCount();
    applySessionFilter();
    renderNextSession();
  } catch (error) {
    sessionsList.replaceChildren();
    attendanceCountNodes.clear();
    sessionsMessage(error.message || "Unable to load sessions.", true);
    updateSessionsNavCount();
    renderNextSession();
  }
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// One label per line instead of a pipe-separated run-on.
function sessionFacts(item) {
  const facts = document.createElement("dl");
  facts.className = "session-facts";

  for (const [label, value] of [
    ["Starts", [sessionDate(item.startsAt), relativeTime(item.startsAt)].filter(Boolean).join("  -  ")],
    ["Ends", item.endsAt ? sessionDate(item.endsAt) : ""],
    ["Location", (item.location || "").trim()]
  ]) {
    if (!value) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    facts.append(term, detail);
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Editing a session: a real form that saves itself
// ---------------------------------------------------------------------------

let editingSessionId = null;
let currentEditButton = null;
let editSaveTimer = null;

function setEditState(message, isError = false) {
  sessionEditState.textContent = message;
  sessionEditState.classList.toggle("error", Boolean(isError));
}

function openEditPanel(item, button) {
  closeAttendancePanel();
  clearTimeout(editSaveTimer);
  editSaveTimer = null;

  editingSessionId = item.id;
  currentEditButton = button;

  editTitleInput.value = item.title || "";
  editDescriptionInput.value = item.description || "";
  editStartsInput.value = toLocalInput(item.startsAt);
  editEndsInput.value = toLocalInput(item.endsAt);
  editLocationInput.value = item.location || "";
  editStatusInput.value = item.status;

  for (const other of document.querySelectorAll("[data-edit-toggle]")) {
    other.setAttribute("aria-expanded", String(other === button));
  }

  sessionEditPanel.hidden = false;
  setEditState("");
  editTitleInput.focus();
}

function closeEditPanel() {
  // A pending keystroke is flushed rather than lost.
  if (editSaveTimer) {
    clearTimeout(editSaveTimer);
    editSaveTimer = null;
    saveSessionEdits();
  }

  editingSessionId = null;
  sessionEditPanel.hidden = true;
  setEditState("");

  for (const button of document.querySelectorAll("[data-edit-toggle]")) {
    button.setAttribute("aria-expanded", "false");
  }
  currentEditButton = null;
}

function scheduleEditSave(delay) {
  clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(() => {
    editSaveTimer = null;
    saveSessionEdits();
  }, delay);
}

function readEditForm() {
  const title = editTitleInput.value.trim();
  if (!title) throw new Error("A session needs a title.");
  if (title.length > 120) throw new Error("Title must be 120 characters or fewer.");

  if (!editStartsInput.value) throw new Error("A session needs a start time.");

  const startsAt = new Date(editStartsInput.value);
  if (!Number.isFinite(startsAt.getTime())) throw new Error("That start time is not valid.");

  const endsAt = editEndsInput.value ? new Date(editEndsInput.value) : null;
  if (endsAt && !Number.isFinite(endsAt.getTime())) throw new Error("That end time is not valid.");
  if (endsAt && endsAt <= startsAt) throw new Error("The end time must be after the start time.");

  return {
    title,
    description: editDescriptionInput.value,
    location: editLocationInput.value.trim(),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt ? endsAt.toISOString() : null,
    status: editStatusInput.value
  };
}

async function saveSessionEdits() {
  if (!editingSessionId) return;

  let payload;
  try {
    payload = readEditForm();
  } catch (error) {
    setEditState(error.message, true);
    return;
  }

  const sessionId = editingSessionId;
  setEditState("Saving...");

  try {
    const result = await apiFetch("/api/admin/sessions/" + encodeURIComponent(sessionId), {
      method: "PATCH",
      body: JSON.stringify(payload)
    }, "Session update");

    applySessionUpdate(result.session);
    setEditState("Saved");
    clearTimeout(editSaveTimer);
    editSaveTimer = setTimeout(() => {
      editSaveTimer = null;
      if (editingSessionId === sessionId) setEditState("");
    }, 2500);
  } catch (error) {
    setEditState(error.message, true);
  }
}

// Updates the visible card from the record the server just stored. No list
// reload, so nothing the user had open gets shut underneath them.
function applySessionUpdate(session) {
  if (!session) return;

  const cached = sessionsCache.find(item => item.id === session.id);
  if (cached) Object.assign(cached, session);

  const countNode = attendanceCountNodes.get(session.id);
  if (countNode) countNode.textContent = `${session.attendanceCount} present`;

  const card = sessionsList.querySelector(`[data-session-id="${session.id}"]`);
  if (!card) return;

  const title = card.querySelector("[data-session-title]");
  if (title) title.textContent = session.title;

  const badge = card.querySelector(".session-status");
  if (badge) {
    badge.textContent = sessionStatusLabel(session.status);
    badge.className = "session-status status-" + session.status;
  }

  const complete = card.querySelector("[data-session-complete]");
  if (complete) {
    complete.textContent = session.status === "scheduled" ? "Mark completed" : "Reopen";
  }

  // A status change that crosses the upcoming/past boundary moves the card in
  // place. It is deliberately not a list reload: reloading used to collapse the
  // attendance panel out from under whoever was working in it.
  const wasPast = card.dataset.sessionPast === "yes";
  const isPast = session.status !== "scheduled";
  if (wasPast !== isPast) {
    card.dataset.sessionPast = isPast ? "yes" : "no";
    moveSessionCard(card, session.status);
  }

  const description = card.querySelector("[data-session-description]");
  if (description) {
    description.textContent = session.description;
    description.hidden = !session.description;
  }

  const facts = card.querySelector(".session-facts");
  if (facts) facts.replaceWith(sessionFacts(session));

  const select = card.querySelector("[data-session-status-select]");
  if (select) select.value = session.status;

  // An edit can change the title, the description or the status, any of which
  // changes what the filter matches and what counts as next. Recomputed here so
  // the sidebar, the overview card and the filtered list cannot disagree with a
  // card that was just edited in place.
  applySessionFilter();
  renderNextSession();
}

for (const control of [editTitleInput, editDescriptionInput, editStartsInput, editEndsInput, editLocationInput]) {
  control.addEventListener("input", () => scheduleEditSave(600));
}

for (const control of [editTitleInput, editDescriptionInput, editStartsInput, editEndsInput, editLocationInput, editStatusInput]) {
  control.addEventListener("change", () => scheduleEditSave(0));
}

el("#session-edit-close").addEventListener("click", closeEditPanel);

// ---------------------------------------------------------------------------
// Attendance: opens and closes on the same button, saves itself
// ---------------------------------------------------------------------------

let attendanceSessionId = null;

function closeAttendancePanel() {
  attendanceSessionId = null;
  sessionAttendancePanel.hidden = true;
  sessionAttendanceContent.replaceChildren();

  for (const button of document.querySelectorAll("[data-attendance-toggle]")) {
    button.setAttribute("aria-expanded", "false");
  }
}

async function toggleAttendance(item, button) {
  // Same button, both directions.
  if (attendanceSessionId === item.id) {
    closeAttendancePanel();
    return;
  }

  closeEditPanel();
  clearTimeout(editSaveTimer);
  editSaveTimer = null;

  attendanceSessionId = item.id;
  for (const other of document.querySelectorAll("[data-attendance-toggle]")) {
    other.setAttribute("aria-expanded", String(other === button));
  }

  sessionAttendancePanel.hidden = false;
  await loadAttendance(item);
}

function countsTowardsPresent(status) {
  return status === "present" || status === "late";
}

function updateAttendanceCount(sessionId, from, to) {
  const cached = sessionsCache.find(item => item.id === sessionId);
  if (!cached) return;

  let count = Number(cached.attendanceCount) || 0;
  if (countsTowardsPresent(from) && !countsTowardsPresent(to)) count = Math.max(0, count - 1);
  if (!countsTowardsPresent(from) && countsTowardsPresent(to)) count += 1;
  cached.attendanceCount = count;

  const node = attendanceCountNodes.get(sessionId);
  if (node) node.textContent = `${count} present`;
}

async function loadAttendance(item) {
  sessionAttendanceTitle.textContent = `Attendance - ${item.title}`;
  sessionAttendanceContent.textContent = "Loading attendance...";

  try {
    const data = await apiFetch(
      "/api/admin/sessions/" + encodeURIComponent(item.id) + "/attendance",
      {},
      "Attendance"
    );

    sessionAttendanceContent.replaceChildren();

    if (!data.attendance.length) {
      const empty = document.createElement("p");
      empty.textContent = "No active accounts found.";
      sessionAttendanceContent.append(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "session-attendance-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Member", "Status", "Note", "Saved"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headRow.append(cell);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");

    for (const member of data.attendance) {
      tbody.append(buildAttendanceRow(item.id, member));
    }

    table.append(tbody);
    sessionAttendanceContent.append(table);
  } catch (error) {
    sessionAttendanceContent.textContent = error.message || "Unable to load attendance.";
  }
}

function buildAttendanceRow(sessionId, member) {
  const row = document.createElement("tr");
  row.dataset.userId = member.userId;

  let savedStatus = member.status;
  let noteTimer = null;

  const nameCell = document.createElement("td");
  const identity = document.createElement("div");
  identity.className = "member-identity";
  identity.append(createAvatarChip(member));
  const nameText = document.createElement("span");
  nameText.textContent = member.name;
  identity.append(nameText);
  nameCell.append(identity);

  const statusCell = document.createElement("td");
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Attendance status for " + member.name);
  for (const value of ["unmarked", "present", "absent", "late", "excused"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === member.status;
    select.append(option);
  }
  statusCell.append(select);

  const notesCell = document.createElement("td");
  const notes = document.createElement("input");
  notes.maxLength = 500;
  notes.value = member.notes || "";
  notes.placeholder = "Optional note";
  notes.setAttribute("aria-label", "Note for " + member.name);
  notesCell.append(notes);

  const stateCell = document.createElement("td");
  const state = document.createElement("span");
  state.className = "row-state";
  state.setAttribute("role", "status");
  stateCell.append(state);

  function setState(message, isError = false) {
    state.textContent = message;
    state.classList.toggle("error", Boolean(isError));
  }

  function clearSoon() {
    setTimeout(() => {
      if (!state.classList.contains("error") && state.textContent === "Saved") setState("");
    }, 2500);
  }

  async function save() {
    const attempted = select.value;
    const previous = savedStatus;
    setState("Saving...");

    try {
      const result = await apiFetch(
        "/api/admin/sessions/" + encodeURIComponent(sessionId) +
          "/attendance/" + encodeURIComponent(member.userId),
        { method: "PUT", body: JSON.stringify({ status: attempted, notes: notes.value }) },
        "Attendance"
      );

      // `unmarked` clears the mark outright, so the server answers with null
      // and the counts it just recalculated.
      if (result.attendance) {
        const stored = result.attendance;
        select.value = stored.status;
        notes.value = stored.notes;
        savedStatus = stored.status;
      } else {
        savedStatus = "unmarked";
        notes.value = "";
      }

      if (Number.isFinite(result.attendanceCount)) {
        const cached = sessionsCache.find(item => item.id === sessionId);
        if (cached) {
          cached.attendanceCount = result.attendanceCount;
          cached.markedCount = result.markedCount;
        }
        const node = attendanceCountNodes.get(sessionId);
        if (node) node.textContent = `${result.attendanceCount} present`;
      } else {
        updateAttendanceCount(sessionId, previous, savedStatus);
      }

      setState(attempted === "unmarked" ? "Cleared" : "Saved");
      clearSoon();
    } catch (error) {
      select.value = savedStatus;
      setState(error.message, true);
    }
  }

  select.addEventListener("change", save);

  notes.addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(save, 700);
  });

  notes.addEventListener("change", () => {
    clearTimeout(noteTimer);
    noteTimer = null;
    save();
  });

  row.append(nameCell, statusCell, notesCell, stateCell);
  return row;
}

el("#sessions-refresh").addEventListener("click", () => {
  closeAttendancePanel();
  closeEditPanel();
  loadedRoute = null;
  loadSessions();
});
el("#session-attendance-close").addEventListener("click", closeAttendancePanel);

// Typing narrows the list as you go, the same way the account search does. The
// filter only hides cards, so the count, the two buckets and anything open
// underneath all survive being typed into.
if (sessionSearch) {
  sessionSearch.addEventListener("input", () => {
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(applySessionFilter, 200);
  });
  sessionSearch.addEventListener("search", () => {
    clearTimeout(sessionSearchTimer);
    applySessionFilter();
  });
  sessionSearch.addEventListener("keydown", event => {
    if (event.key === "Escape" && sessionSearch.value) {
      event.stopPropagation();
      sessionSearch.value = "";
      applySessionFilter();
    }
  });
}

// `/` is the search key on most of the web, and it is the fastest way into the
// one box on this portal that pays for itself. Never while typing somewhere else.
document.addEventListener("keydown", event => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = (event.target && event.target.tagName) || "";
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || (event.target && event.target.isContentEditable)) return;
  if (currentRoute() !== "sessions" || !sessionSearch) return;
  event.preventDefault();
  sessionSearch.focus();
  sessionSearch.select();
});

sessionCreateForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(sessionCreateForm);

  try {
    const start = new Date(String(form.get("startsAt")));
    const endValue = form.get("endsAt");
    const end = endValue ? new Date(String(endValue)) : null;
    if (!Number.isFinite(start.getTime()) || (end && !Number.isFinite(end.getTime()))) {
      throw new Error("Enter valid start and end dates.");
    }

    await apiFetch("/api/admin/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: String(form.get("title") || "").trim(),
        description: String(form.get("description") || "").trim(),
        startsAt: start.toISOString(),
        endsAt: end ? end.toISOString() : null,
        location: String(form.get("location") || "").trim()
      })
    }, "Session creation");

    sessionCreateForm.reset();
    sessionsMessage("Session created.");
    loadedRoute = null;
    await loadSessions();
  } catch (error) {
    sessionsMessage(error.message || "Unable to create the session.", true);
  }
});

// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------

function showAdminMessage(message, isError = false) {
  adminMessage.textContent = message;
  adminMessage.classList.toggle("error", isError);
}

async function loadAdmin() {
  if (!currentUser || currentUser.role !== "admin" || currentUser.status !== "active") {
    adminPanel.hidden = true;
    showAdminMessage("Administrator access required.", true);
    return;
  }

  adminPanel.hidden = false;
  showAdminMessage("Loading administrator data...");

  try {
    const query = encodeURIComponent(adminSearch.value.trim());
    const [overview, users, audit] = await Promise.all([
      apiFetch("/api/admin/overview", {}, "Admin overview"),
      apiFetch(`/api/admin/users?q=${query}`, {}, "User list"),
      apiFetch("/api/admin/audit", {}, "Audit log")
    ]);

    el("#stat-total").textContent = overview.totalUsers;
    el("#stat-active").textContent = overview.activeUsers;
    el("#stat-suspended").textContent = overview.suspendedUsers;
    el("#stat-admins").textContent = overview.activeAdmins;

    adminUsers.replaceChildren();

    if (!users.users.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "No accounts matched that search.";
      row.append(cell);
      adminUsers.append(row);
    }

    for (const user of users.users) {
      const row = document.createElement("tr");
      row.dataset.userId = user.id;

      const userCell = document.createElement("td");
      const identity = document.createElement("div");
      identity.className = "admin-user-identity";

      // View mode: picture and name, and nothing else until Edit is pressed.
      const who = document.createElement("div");
      who.className = "member-identity admin-user-view";
      who.append(createAvatarChip(user));

      const nameText = document.createElement("span");
      nameText.textContent = user.name;
      who.append(nameText);

      // Only administrators carry the suffix. Nothing at all for anyone else.
      if (user.role === "admin") {
        const badge = document.createElement("span");
        badge.className = "admin-role-badge";
        badge.textContent = "- Administrator";
        who.append(badge);
      }

      // Edit mode fields, hidden until then.
      const name = document.createElement("input");
      name.className = "admin-name-input";
      name.maxLength = 80;
      name.value = user.displayNameOverride;
      name.placeholder = user.name;
      name.setAttribute("aria-label", "Displayed name for " + user.name);
      name.dataset.field = "displayName";

      // Emails are masked until the administrator asks for them, so a shared
      // screen or a screenshot never spills every member's address. The choice
      // is remembered per browser.
      const emailRow = document.createElement("div");
      emailRow.className = "admin-email";
      const emailText = document.createElement("span");
      emailText.className = "admin-email-value";

      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "text-button admin-email-toggle";
      reveal.setAttribute("aria-controls", "email-" + user.id);
      emailText.id = "email-" + user.id;
      reveal.hidden = !user.emails;

      const setRevealed = on => {
        reveal.setAttribute("aria-expanded", String(on));
        reveal.textContent = on ? "Hide" : "Show";
        reveal.setAttribute("aria-label", (on ? "Hide" : "Show") + " the email address for " + user.name);
        emailText.textContent = on ? user.emails : maskEmail(user.emails);
      };

      setRevealed(Boolean(user.emails && revealedEmails()[user.id]));
      reveal.addEventListener("click", () => {
        const on = reveal.getAttribute("aria-expanded") === "true";
        setRevealed(!on);
        setEmailRevealed(user.id, !on);
      });

      emailRow.append(emailText, reveal);

      const reason = document.createElement("input");
      reason.className = "admin-reason-input";
      reason.maxLength = 500;
      reason.value = user.statusReason || "";
      reason.placeholder = "Reason shown to this member when they sign in";
      reason.setAttribute("aria-label", "Status reason for " + user.name);
      reason.dataset.field = "statusReason";
      reason.hidden = user.status === "active";

      const meta = document.createElement("small");
      meta.textContent = user.id;

      const editFields = document.createElement("div");
      editFields.className = "admin-edit-fields";
      editFields.append(emailRow, name, reason, meta);
      editFields.hidden = true;

      identity.append(who, editFields);
      userCell.append(identity);

      const roleCell = document.createElement("td");
      const role = document.createElement("select");
      role.dataset.field = "role";
      role.setAttribute("aria-label", "Role for " + user.name);
      for (const value of ["user", "admin"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "admin" ? "Administrator" : "Member";
        option.selected = value === user.role;
        role.append(option);
      }
      roleCell.append(role);

      const statusCell = document.createElement("td");
      const status = document.createElement("select");
      status.dataset.field = "status";
      status.setAttribute("aria-label", "Status for " + user.name);
      for (const value of ["active", "suspended", "pending_deletion"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value.replaceAll("_", " ");
        option.selected = value === user.status;
        status.append(option);
      }
      statusCell.append(status);

      const saveCell = document.createElement("td");
      const edit = createActionButton("Edit");
      const save = createActionButton("Save");
      save.hidden = true;
      const cancel = createActionButton("Cancel");
      cancel.hidden = true;

      function setEditing(enabled) {
        // In view mode the row is picture and name, full stop. The Role and
        // Status columns are collapsed on the whole table, not per cell, so
        // the headers and the cells can never disagree about where a column is.
        who.hidden = enabled;
        editFields.hidden = !enabled;
        adminUsersTable.classList.toggle("is-editing", enabled);
        row.classList.toggle("is-editing", enabled);

        name.disabled = !enabled;
        role.disabled = !enabled;
        status.disabled = !enabled;
        reason.disabled = !enabled;

        edit.hidden = enabled;
        save.hidden = !enabled;
        cancel.hidden = !enabled;
      }

      // The reason box only means anything while the account is blocked.
      status.addEventListener("change", () => {
        reason.hidden = status.value === "active";
      });

      edit.addEventListener("click", () => {
        setEditing(true);
        name.focus();
      });

      cancel.addEventListener("click", () => {
        name.value = user.displayNameOverride ?? "";
        role.value = user.role;
        status.value = user.status;
        reason.value = user.statusReason || "";
        reason.hidden = status.value === "active";
        setEditing(false);
      });

      save.addEventListener("click", async () => {
        save.disabled = true;
        cancel.disabled = true;
        try {
          const body = {
            displayName: name.value,
            role: role.value,
            status: status.value
          };
          if (status.value !== "active") body.statusReason = reason.value;

          await apiFetch("/api/admin/users/" + encodeURIComponent(user.id), {
            method: "PATCH",
            body: JSON.stringify(body)
          }, "Account update");

          showAdminMessage(status.value === "active"
            ? "Saved changes for " + user.name + "."
            : "Saved. " + user.name + " will be told the reason next time they sign in.");
          await loadAdmin();
        } catch (error) {
          showAdminMessage(error.message, true);
          save.disabled = false;
          cancel.disabled = false;
        }
      });

      setEditing(false);
      saveCell.append(edit, save, cancel);
      row.append(userCell, roleCell, statusCell, saveCell);
      adminUsers.append(row);
    }

    adminAudit.replaceChildren();
    if (!audit.events.length) {
      const empty = document.createElement("p");
      empty.textContent = "No audit events yet.";
      adminAudit.append(empty);
    }
    for (const event of audit.events) {
      const item = document.createElement("article");
      item.className = "admin-audit-item";
      const heading = document.createElement("strong");
      heading.textContent = event.action;
      const detail = document.createElement("p");
      detail.textContent = [event.actor, event.targetId, event.createdAt, event.details]
        .filter(Boolean).join(" - ");
      item.append(heading, detail);
      adminAudit.append(item);
    }

    showAdminMessage("Administrator data loaded.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

function createActionButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  return button;
}

el("#admin-refresh").addEventListener("click", () => { loadAdmin(); loadGroups(); });
el("#admin-search-button").addEventListener("click", loadAdmin);

// Filtering as he types: no button required, but the button still works.
adminSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadAdmin, 300);
});

adminSearch.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    clearTimeout(searchTimer);
    loadAdmin();
  }
});

// ---------------------------------------------------------------------------
// Audit log: collapsible
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

function showAchievementsMessage(message, isError = false) {
  el("#achievements-message").textContent = message;
  el("#achievements-message").classList.toggle("error", isError);
}

function achievementImage(item, className = "achievement-icon") {
  const box = document.createElement("div");
  box.className = className;
  box.setAttribute("aria-hidden", "true");

  if (item.pictureUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.addEventListener("error", () => {
      box.replaceChildren();
      box.classList.remove("has-image");
      box.textContent = initialFor(item.name);
    }, { once: true });
    image.src = item.pictureUrl;
    box.append(image);
    box.classList.add("has-image");
  } else if (item.icon) {
    // The icon column has been stored, validated and returned by the API since
    // the first achievements pass, but nothing ever rendered it - an
    // administrator could set one and see the first letter of the name instead.
    box.textContent = item.icon;
  } else {
    box.textContent = initialFor(item.name);
  }

  return box;
}

async function loadMyAchievements() {
  const target = el("#profile-achievements");
  if (target.hidden) return;

  target.textContent = "Loading achievements...";

  try {
    const data = await apiFetch("/api/achievements", {}, "Achievements");
    const list = data.achievements || [];
    target.replaceChildren();

    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No achievements are available to you yet. If an administrator has not set any up, or none are shown to you, they will appear here.";
      target.append(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "achievement-grid";

    // One line of progress beats making somebody count their own badges.
    if (list.length > 1) {
      const earned = list.filter(item => item.earned).length;
      const progress = document.createElement("p");
      progress.className = "achievement-progress";
      progress.textContent = `${earned} of ${list.length} earned`;
      // Appended, not inserted before the grid: the grid is still detached at
      // this point, and insertBefore throws if the reference node is not
      // already a child. target was emptied above, so this is still first.
      target.append(progress);
    }

    for (const item of list) {
      const card = document.createElement("article");
      card.className = "achievement-card" + (item.earned ? " is-earned" : "");

      const icon = achievementImage(item);

      const title = document.createElement("h4");
      title.textContent = item.name;

      const state = document.createElement("span");
      state.className = "achievement-state";
      state.textContent = item.earned ? "Earned" : "Not yet earned";

      card.append(icon, title, state);

      if (item.description) {
        const description = document.createElement("p");
        description.textContent = item.description;
        card.append(description);
      }

      grid.append(card);
    }

    target.append(grid);
  } catch (error) {
    target.textContent = error.message || "Unable to load achievements.";
  }
}

async function loadAchievements() {
  if (!currentUser || currentUser.role !== "admin") return;

  try {
    const [data, users, groups] = await Promise.all([
      apiFetch("/api/admin/achievements", {}, "Achievements"),
      apiFetch("/api/admin/users?q=", {}, "User list"),
      apiFetch("/api/admin/groups", {}, "Groups")
    ]);

    renderAchievements(data.achievements || [], users.users || [], groups.groups || []);
    showAchievementsMessage((data.achievements || []).length
      ? `${data.awardCount ?? (data.achievements || []).length} achievement(s).`
      : "No achievements yet. Create one above.");
  } catch (error) {
    el("#achievements-list").replaceChildren();
    showAchievementsMessage(error.message, true);
  }
}

// The visibility list and the award list are a checkbox row and a button row for
// every person, for every achievement. With a handful of members and a few
// achievements that is a wall of controls, and the two facts that actually
// matter - who can see this, and who has earned it - are invisible above it.
// Both fold away behind one summary line, remembered per achievement alongside
// everything else in `csp-ui`.
function achievementFold(summaryText, content, onToggle) {
  const wrap = document.createElement("div");
  wrap.className = "achievement-fold";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondary-button achievement-fold-toggle";
  toggle.setAttribute("aria-expanded", "false");

  const summary = document.createElement("span");
  summary.className = "achievement-fold-summary";
  summary.textContent = summaryText;

  const caret = document.createElement("span");
  caret.className = "achievement-fold-caret";
  caret.setAttribute("aria-hidden", "true");

  toggle.append(summary, caret);

  const body = document.createElement("div");
  body.className = "achievement-fold-body";
  body.append(content);

  function sync(open) {
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    caret.textContent = open ? "Hide" : "Show";
  }

  toggle.addEventListener("click", () => {
    const opening = body.hidden;
    sync(opening);
    if (onToggle) onToggle(opening);
  });

  wrap.append(toggle, body);
  return { wrap, body, toggle, summary, sync };
}

function achievementFoldCollapsed(id) {
  const folds = readUiState().achievementFolds || {};
  return folds[id] === true;
}

function rememberAchievementFold(id, collapsed) {
  const folds = { ...(readUiState().achievementFolds || {}) };
  if (collapsed) folds[id] = true;
  else delete folds[id];
  writeUiState({ achievementFolds: folds });
}

// One line that says who can see the achievement, so the admin never has to
// open a list of twenty checkboxes to read one fact.
//
// There is no "everyone except" reading any more (23 Oct 2026). A ticked box
// means that person can see it, in both modes; `everyone` means literally
// everyone and carries no list at all.
function visibilitySummaryText(mode, userVisible, groupVisible) {
  if (mode !== "restricted") return "Everyone can see this";

  const people = [...userVisible.values()].filter(Boolean).length;
  const groups = [...groupVisible.values()].filter(Boolean).length;
  if (!people && !groups) return "Shown to nobody yet";
  const parts = [];
  if (people) parts.push(`${people} ${people === 1 ? "person" : "people"}`);
  if (groups) parts.push(`${groups} ${groups === 1 ? "group" : "groups"}`);
  return `Shown to ${parts.join(" and ")}`;
}

function renderAchievements(achievements, allUsers, allGroups) {
  const target = el("#achievements-list");
  target.replaceChildren();

  if (!achievements.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No achievements yet. Create one above.";
    target.append(empty);
    return;
  }

  for (const item of achievements) {
    const card = document.createElement("article");
    card.className = "achievement-admin-card";

    const head = document.createElement("div");
    head.className = "achievement-admin-head";
    const icon = achievementImage(item, "achievement-icon small");
    const title = document.createElement("h4");
    title.textContent = item.name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = `${item.winners.length} earned`;

    // Name, description and icon could be set once at creation and never
    // changed again from the portal - the PATCH route has accepted all three
    // since the first pass, so the only missing half was this form.
    const editButton = createActionButton("Edit");
    editButton.classList.add("achievement-edit-button");

    head.append(icon, title, count, editButton);
    card.append(head);

    const editor = document.createElement("div");
    editor.className = "achievement-editor";
    editor.hidden = true;

    const nameField = document.createElement("input");
    nameField.value = item.name;
    nameField.maxLength = 80;
    nameField.setAttribute("aria-label", "Name for " + item.name);

    const descriptionField = document.createElement("input");
    descriptionField.value = item.description || "";
    descriptionField.maxLength = 500;
    descriptionField.placeholder = "Optional";
    descriptionField.setAttribute("aria-label", "Description for " + item.name);

    const iconField = document.createElement("input");
    iconField.value = item.icon || "";
    iconField.maxLength = 8;
    iconField.placeholder = "e.g. * or A";
    iconField.setAttribute("aria-label", "Icon text for " + item.name);

    // "Icon" sitting next to "Picture" reads like a second image field, and it
    // is not: it is the one text symbol drawn in the badge when no picture has
    // been uploaded. Spelling that out is cheaper than every admin guessing.
    const iconNote = document.createElement("p");
    iconNote.className = "settings-help";
    iconNote.textContent = "A short text symbol, not an image. It is shown in the badge when there is no picture, up to 8 plain characters. Use Picture below to upload an image.";

    const editorActions = document.createElement("div");
    editorActions.className = "achievement-editor-actions";

    const saveDetails = createActionButton("Save details");
    const cancelEdit = createActionButton("Cancel");
    editorActions.append(saveDetails, cancelEdit);

    editor.append(
      labelled("Name", nameField),
      labelled("Description", descriptionField),
      labelled("Icon (text)", iconField),
      iconNote,
      editorActions
    );

    // Picture upload, per achievement.
    const pictureInput = document.createElement("input");
    pictureInput.type = "file";
    pictureInput.accept = "image/png,image/jpeg,image/webp,image/gif";
    pictureInput.setAttribute("aria-label", "Picture for " + item.name);

    // Uploaded the moment it is chosen, so there is no selection to clear.
    const picturePreview = createPicturePreview(pictureInput, { clearable: false });

    const removePicture = document.createElement("button");
    removePicture.type = "button";
    removePicture.className = "text-button";
    removePicture.textContent = "Remove picture";
    removePicture.hidden = !item.hasPicture;

    async function sendPicture(file, remove) {
      state.textContent = "Saving...";
      state.classList.remove("error");
      try {
        await apiFetch(
          "/api/admin/achievements/" + encodeURIComponent(item.id) + "/picture",
          remove ? { method: "DELETE" } : { method: "PUT", body: file },
          "Achievement picture"
        );
        await loadAchievements();
      } catch (error) {
        state.textContent = error.message;
        state.classList.add("error");
      }
    }

    pictureInput.addEventListener("change", () => {
      const file = pictureInput.files && pictureInput.files[0];
      if (!file) return;

      // Cleared straight away so choosing the very same file again still fires
      // a change event. The preview is driven by `file`, not by the input.
      pictureInput.value = "";

      const problem = pictureProblem(file);
      if (problem) {
        picturePreview.show(null, problem);
        state.textContent = problem;
        state.classList.add("error");
        return;
      }

      // The chosen image appears immediately rather than after the round trip.
      picturePreview.show(file);
      const form = new FormData();
      form.append("picture", file);
      sendPicture(form, false);
    });

    function setEditing(on) {
      editor.hidden = !on;
      editButton.hidden = on;
      if (on) {
        nameField.focus();
        return;
      }
      // Cancel restores what is stored, so a half-typed change is not left
      // sitting in the fields looking saved.
      nameField.value = item.name;
      descriptionField.value = item.description || "";
      iconField.value = item.icon || "";
    }

    editButton.addEventListener("click", () => setEditing(true));
    cancelEdit.addEventListener("click", () => setEditing(false));

    saveDetails.addEventListener("click", async () => {
      const wanted = {
        name: nameField.value.trim(),
        description: descriptionField.value.trim(),
        icon: iconField.value.trim()
      };

      if (!wanted.name) {
        state.textContent = "An achievement needs a name.";
        state.classList.add("error");
        nameField.focus();
        return;
      }
      if (wanted.icon.length > 8 || /[^\x20-\x7E]/.test(wanted.icon)) {
        state.textContent = "The icon is a text symbol, not an image: 8 plain characters or fewer.";
        state.classList.add("error");
        iconField.focus();
        return;
      }

      // Only what actually changed is sent, so saving an untouched form is a
      // no-op rather than a write with identical values.
      const changes = {};
      if (wanted.name !== item.name) changes.name = wanted.name;
      if (wanted.description !== (item.description || "")) changes.description = wanted.description;
      if (wanted.icon !== (item.icon || "")) changes.icon = wanted.icon;

      if (!Object.keys(changes).length) {
        state.textContent = "Nothing to save yet.";
        state.classList.remove("error");
        return;
      }

      saveDetails.disabled = true;
      state.textContent = "Saving...";
      state.classList.remove("error");

      try {
        await apiFetch("/api/admin/achievements/" + encodeURIComponent(item.id), {
          method: "PATCH",
          body: JSON.stringify(changes)
        }, "Achievement update");
        showAchievementsMessage(`Updated "${wanted.name}".`);
        await loadAchievements();
      } catch (error) {
        state.textContent = error.message;
        state.classList.add("error");
      } finally {
        saveDetails.disabled = false;
      }
    });

    removePicture.addEventListener("click", () => {
      if (removePicture.dataset.armed === "yes") {
        delete removePicture.dataset.armed;
        removePicture.textContent = "Remove picture";
        sendPicture(null, true);
        return;
      }
      removePicture.dataset.armed = "yes";
      removePicture.textContent = "Click again to remove";
      setTimeout(() => {
        if (removePicture.dataset.armed === "yes") {
          delete removePicture.dataset.armed;
          removePicture.textContent = "Remove picture";
        }
      }, 5000);
    });

    if (item.description) {
      const description = document.createElement("p");
      description.className = "group-description";
      description.textContent = item.description;
      card.append(description);
    }

    const state = document.createElement("span");
    state.className = "row-state";
    state.setAttribute("role", "status");

    // --- Who can see it ---------------------------------------------------
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", "Who can see " + item.name);
    for (const [value, label] of [
      ["everyone", "Shown to everyone"],
      ["restricted", "Only specific people and groups"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === item.mode;
      mode.append(option);
    }

    mode.addEventListener("change", async () => {
      mode.disabled = true;
      state.textContent = "Saving...";
      state.classList.remove("error");
      try {
        await apiFetch("/api/admin/achievements/" + encodeURIComponent(item.id), {
          method: "PATCH",
          body: JSON.stringify({ mode: mode.value })
        }, "Achievement update");

        // Reload rather than adjust the card by hand. Switching to "everyone"
        // clears the stored visibility list server-side and changes who can be
        // awarded, so re-reading is the only way this card shows what is truly
        // stored instead of what it was about to assume.
        await loadAchievements();
      } catch (error) {
        mode.value = item.mode;
        state.textContent = error.message;
        state.classList.add("error");
        mode.disabled = false;
      }
    });

    // --- Who can see it ---------------------------------------------------
    // Every box reads one way now: ticked means that person can see it. Clearing
    // a box deletes the row on the server, so "not ticked" and "no row" are the
    // same fact and cannot drift apart - that drift is exactly what made the old
    // mode-dependent reading so easy to get wrong.
    const visibility = document.createElement("div");
    visibility.className = "achievement-visibility";

    const userVisible = new Map(item.userVisibility.map(entry => [entry.id, entry.visible]));
    const groupVisible = new Map(item.groupVisibility.map(entry => [entry.id, entry.visible]));

    async function toggle(kind, subjectId, visible) {
      state.textContent = "Saving...";
      state.classList.remove("error");
      try {
        await apiFetch(
          "/api/admin/achievements/" + encodeURIComponent(item.id) +
            "/visibility/" + kind + "/" + encodeURIComponent(subjectId),
          { method: "PUT", body: JSON.stringify({ visible }) },
          "Achievement visibility"
        );
        state.textContent = visible ? "Shown" : "Not shown";
        setTimeout(() => { if (state.textContent === "Shown" || state.textContent === "Not shown") state.textContent = ""; }, 2500);
      } catch (error) {
        state.textContent = error.message;
        state.classList.add("error");
      }
    }

    if (item.mode === "restricted") {
      for (const user of allUsers) {
        if (user.status !== "active") continue;
        const row = document.createElement("label");
        row.className = "visibility-option";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = Boolean(userVisible.get(user.id));

        box.addEventListener("change", () => {
          userVisible.set(user.id, box.checked);
          syncVisibilitySummary();
          toggle("users", user.id, box.checked);
        });

        const text = document.createElement("span");
        text.textContent = user.name;
        row.append(box, text);
        visibility.append(row);
      }

      for (const group of allGroups) {
        const row = document.createElement("label");
        row.className = "visibility-option";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = Boolean(groupVisible.get(group.id));

        box.addEventListener("change", () => {
          groupVisible.set(group.id, box.checked);
          syncVisibilitySummary();
          toggle("groups", group.id, box.checked);
        });

        const text = document.createElement("span");
        text.textContent = group.name;
        row.append(box, text);
        visibility.append(row);
      }
    } else {
      const note = document.createElement("p");
      note.className = "settings-help";
      note.textContent = "Everyone can see this achievement, so there is no list to manage. Choose \"Only specific people and groups\" above to restrict it to a chosen few.";
      visibility.append(note);
    }

    // --- Who has earned it ------------------------------------------------
    const winners = document.createElement("div");
    winners.className = "group-members";

    const awarded = new Set(item.winners.map(winner => winner.id));
    const audience = new Set(item.audience || []);
    const activeUsers = allUsers.filter(user => user.status === "active");
    const awardable = activeUsers.filter(user => audience.has(user.id));

    // Only somebody who can see an achievement can be given it; the API refuses
    // the award too. A member who already has one but can no longer see it stays
    // in the list so it can be taken back - revoke only, and said out loud.
    const unreachable = item.winners.filter(winner => !audience.has(winner.id));

    function awardRow(user, revokeOnly) {
      const row = document.createElement("div");
      row.className = "member-identity group-member";
      row.append(createAvatarChip(user));

      const text = document.createElement("span");
      text.textContent = user.name;
      row.append(text);

      if (revokeOnly) {
        const why = document.createElement("span");
        why.className = "group-count";
        why.textContent = "can no longer see this";
        row.append(why);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button group-remove";
      button.textContent = awarded.has(user.id) ? "Revoke" : "Award";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await apiFetch(
            "/api/admin/achievements/" + encodeURIComponent(item.id) +
              "/award/" + encodeURIComponent(user.id),
            { method: "PUT", body: JSON.stringify({ awarded: !awarded.has(user.id) }) },
            "Achievement award"
          );
          await loadAchievements();
        } catch (error) {
          button.disabled = false;
          state.textContent = error.message;
          state.classList.add("error");
        }
      });
      row.append(button);
      return row;
    }

    if (!awardable.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Nobody can see this achievement yet, so there is nobody to award it to.";
      winners.append(empty);
    }

    for (const user of awardable) winners.append(awardRow(user, false));
    for (const winner of unreachable) winners.append(awardRow(winner, true));

    const remove = createActionButton("Delete achievement");
    remove.classList.add("danger-link");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await apiFetch("/api/admin/achievements/" + encodeURIComponent(item.id), {
          method: "DELETE"
        }, "Achievement deletion");
        showAchievementsMessage(`Deleted "${item.name}".`);
        await loadAchievements();
      } catch (error) {
        remove.disabled = false;
        state.textContent = error.message;
        state.classList.add("error");
      }
    });

    const visibilityLabel = document.createElement("div");
    visibilityLabel.className = "achievement-fold-label";
    visibilityLabel.textContent = "Shown to";

    // Closed by default. The state that matters is on the summary line; the
    // controls behind it are for when somebody actually needs to change one.
    // An administrator who opens one has it remembered, so it does not have to
    // be reopened on every refresh.
    const detailsOpen = !achievementFoldCollapsed(item.id);
    const rememberOpen = open => rememberAchievementFold(item.id, !open);

    const visibilityFold = achievementFold(
      visibilitySummaryText(item.mode, userVisible, groupVisible),
      visibility,
      rememberOpen
    );
    if (item.mode === "restricted") visibilityFold.body.prepend(visibilityLabel);

    const winnersFold = achievementFold(
      item.winners.length
        ? `${item.winners.length} ${item.winners.length === 1 ? "person has" : "people have"} earned this`
        : "Nobody has earned this yet",
      winners,
      rememberOpen
    );

    function syncVisibilitySummary() {
      visibilityFold.summary.textContent = visibilitySummaryText(item.mode, userVisible, groupVisible);
    }

    visibilityFold.sync(detailsOpen);
    winnersFold.sync(detailsOpen);

    const pictureBlock = document.createElement("div");
    pictureBlock.className = "achievement-picture-block";
    pictureBlock.append(
      labelled("Picture", pictureInput),
      picturePreview.tile,
      picturePreview.note,
      removePicture
    );

    card.append(
      editor,
      labelled("Who can see it", mode),
      visibilityFold.wrap,
      pictureBlock,
      winnersFold.wrap,
      state,
      remove
    );

    target.append(card);
  }
}

const achievementCreateInput = el("#achievement-picture-input");
const achievementCreatePreview = createPicturePreview(achievementCreateInput);

el("#achievement-picture-preview").append(
  achievementCreatePreview.tile,
  achievementCreatePreview.note,
  achievementCreatePreview.clear
);

achievementCreateInput.addEventListener("change", () => {
  const file = achievementCreateInput.files && achievementCreateInput.files[0];
  if (!file) {
    achievementCreatePreview.reset();
    return;
  }

  const problem = pictureProblem(file);
  if (problem) {
    achievementCreatePreview.show(null, problem);
    return;
  }

  achievementCreatePreview.show(file);
});

// The form is reset after a successful create, so the preview has to go with
// it - otherwise the last picture stays on screen next to an empty form.
el("#achievement-create-form").addEventListener("reset", () => {
  achievementCreatePreview.reset();
});

el("#achievement-create-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = event.target.querySelector("button[type=submit]");
  const name = el("#achievement-name-input").value.trim();
  const description = el("#achievement-description-input").value.trim();
  const file = el("#achievement-picture-input").files && el("#achievement-picture-input").files[0];

  submit.disabled = true;

  try {
    const created = await apiFetch("/api/admin/achievements", {
      method: "POST",
      body: JSON.stringify({ name, description })
    }, "Achievement creation");

    // The picture is a separate upload against the achievement that now exists,
    // so a picture failure never rolls back the achievement itself.
    if (file) {
      const form = new FormData();
      form.append("picture", file);
      try {
        await apiFetch("/api/admin/achievements/" +
          encodeURIComponent(created.achievement.id) + "/picture", {
          method: "PUT",
          body: form
        }, "Achievement picture");
      } catch (error) {
        showAchievementsMessage(
          `"${name}" was created, but its picture failed: ${error.message}`, true);
      }
    }

    event.target.reset();
    if (!file || !(el("#achievements-message").classList.contains("error"))) {
      showAchievementsMessage("Achievement created.");
    }
    await loadAchievements();
  } catch (error) {
    showAchievementsMessage(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function showGroupsMessage(message, isError = false) {
  groupsMessage.textContent = message;
  groupsMessage.classList.toggle("error", isError);
}

async function loadGroups() {
  if (!currentUser || currentUser.role !== "admin") {
    groupsList.replaceChildren();
    return;
  }

  try {
    const [data, users] = await Promise.all([
      apiFetch("/api/admin/groups", {}, "Groups"),
      apiFetch("/api/admin/users?q=", {}, "User list")
    ]);

    groupsCache = data.groups || [];
    renderGroups(users.users || []);
    showGroupsMessage(groupsCache.length
      ? `${groupsCache.length} group(s).`
      : "No groups yet. Create one above.");
  } catch (error) {
    groupsList.replaceChildren();
    showGroupsMessage(error.message, true);
  }
}

function renderGroups(allUsers) {
  groupsList.replaceChildren();

  if (!groupsCache.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No groups yet. Create one above to start adding members.";
    groupsList.append(empty);
    return;
  }

  for (const group of groupsCache) {
    const card = document.createElement("article");
    card.className = "group-card";
    card.dataset.groupId = group.id;

    // --- View mode: picture, name, member count, and the buttons -----------
    const view = document.createElement("div");
    view.className = "group-view";

    const heading = document.createElement("div");
    heading.className = "group-card-heading";

    const avatar = document.createElement("span");
    avatar.className = "account-avatar group-avatar";
    avatar.setAttribute("aria-hidden", "true");
    if (group.pictureUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.addEventListener("error", () => {
        avatar.replaceChildren();
        avatar.classList.remove("has-image");
        avatar.textContent = initialFor(group.name);
      }, { once: true });
      image.src = group.pictureUrl;
      avatar.append(image);
      avatar.classList.add("has-image");
    } else {
      avatar.textContent = initialFor(group.name);
    }

    const titles = document.createElement("div");
    titles.className = "group-titles";
    const title = document.createElement("h4");
    title.textContent = group.name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = `${group.memberCount} member${group.memberCount === 1 ? "" : "s"}`;
    titles.append(title, count);

    heading.append(avatar, titles);

    const actions = document.createElement("div");
    actions.className = "group-actions";

    const toggle = createActionButton("Minimise");
    toggle.dataset.groupMinimise = "";
    toggle.setAttribute("aria-expanded", "true");

    const editButton = createActionButton("Edit");

    actions.append(toggle, editButton);
    view.append(heading, actions);

    const preview = document.createElement("p");
    preview.className = "group-members-preview";
    view.append(preview);

    // --- Edit mode --------------------------------------------------------
    const editor = document.createElement("div");
    editor.className = "group-editor";
    editor.hidden = true;

    const nameInput = document.createElement("input");
    nameInput.value = group.name;
    nameInput.maxLength = 80;
    nameInput.setAttribute("aria-label", "Group name");

    const descriptionInput = document.createElement("input");
    descriptionInput.value = group.description || "";
    descriptionInput.maxLength = 500;
    descriptionInput.placeholder = "Description";
    descriptionInput.setAttribute("aria-label", "Group description");

    const pictureInput = document.createElement("input");
    pictureInput.type = "file";
    pictureInput.accept = "image/png,image/jpeg,image/webp,image/gif";
    pictureInput.setAttribute("aria-label", "Group picture");

    const pictureNote = document.createElement("p");
    pictureNote.className = "settings-help";
    pictureNote.textContent = "PNG, JPEG, WebP or GIF, up to 350 KB.";

    // A chosen picture shows itself before Save details uploads it, rather than
    // leaving only the file name that a native file input displays.
    const picturePreview = createPicturePreview(pictureInput);

    pictureInput.addEventListener("change", () => {
      const file = pictureInput.files && pictureInput.files[0];
      if (!file) {
        picturePreview.reset();
        return;
      }

      const problem = pictureProblem(file);
      if (problem) {
        picturePreview.show(null, problem);
        return;
      }

      // Deliberately not cleared here: Save details reads the input's own
      // files when it uploads.
      picturePreview.show(file);
    });

    const removePicture = document.createElement("button");
    removePicture.type = "button";
    removePicture.className = "text-button";
    removePicture.textContent = "Remove group picture";
    removePicture.hidden = !group.hasPicture;

    const detailFields = document.createElement("div");
    detailFields.className = "group-detail-fields";
    detailFields.append(
      labelled("Name", nameInput),
      labelled("Description", descriptionInput),
      labelled("Picture", pictureInput),
      picturePreview.tile,
      picturePreview.note,
      picturePreview.clear,
      pictureNote,
      removePicture
    );

    const membersBox = document.createElement("div");
    membersBox.className = "group-members";
    membersBox.dataset.groupMembers = "";

    const memberControls = document.createElement("div");
    memberControls.className = "group-controls";

    const picker = document.createElement("select");
    picker.setAttribute("aria-label", "Add a member to " + group.name);

    const state = document.createElement("span");
    state.className = "row-state";
    state.setAttribute("role", "status");

    const add = createActionButton("Add member");
    add.addEventListener("click", () => {
      if (!picker.value) {
        state.textContent = "Pick someone first";
        state.classList.add("error");
        return;
      }
      addMember(group.id, picker.value, state);
    });

    memberControls.append(picker, add, state);

    const editorActions = document.createElement("div");
    editorActions.className = "group-actions";

    const save = createActionButton("Save details");
    save.addEventListener("click", async () => {
      save.disabled = true;
      state.classList.remove("error");

      try {
        const changes = {};
        if (nameInput.value.trim() !== group.name) changes.name = nameInput.value;
        if (descriptionInput.value.trim() !== (group.description || "")) {
          changes.description = descriptionInput.value;
        }

        if (Object.keys(changes).length) {
          await apiFetch("/api/admin/groups/" + encodeURIComponent(group.id), {
            method: "PATCH",
            body: JSON.stringify(changes)
          }, "Group update");
        }

        // Always upload if a file was chosen; always clear if asked.
        if (pictureInput.files && pictureInput.files[0]) {
          const form = new FormData();
          form.append("picture", pictureInput.files[0]);
          await apiFetch("/api/admin/groups/" + encodeURIComponent(group.id) + "/picture", {
            method: "PUT",
            body: form
          }, "Group picture");
        } else if (removePicture.dataset.armed === "yes") {
          await apiFetch("/api/admin/groups/" + encodeURIComponent(group.id) + "/picture", {
            method: "DELETE"
          }, "Group picture");
        }

        pictureInput.value = "";
        showGroupsMessage(`Saved "${nameInput.value.trim()}".`);
        await loadGroups();
      } catch (error) {
        state.textContent = error.message;
        state.classList.add("error");
      } finally {
        save.disabled = false;
      }
    });

    const close = createActionButton("Close");
    close.addEventListener("click", () => setGroupEditing(false));

    const deleteGroup = createActionButton("Delete group");
    deleteGroup.classList.add("danger-link");
    deleteGroup.addEventListener("click", async () => {
      deleteGroup.disabled = true;
      try {
        await apiFetch("/api/admin/groups/" + encodeURIComponent(group.id), {
          method: "DELETE"
        }, "Group deletion");
        showGroupsMessage(`Deleted "${group.name}".`);
        await loadGroups();
      } catch (error) {
        deleteGroup.disabled = false;
        state.textContent = error.message;
        state.classList.add("error");
      }
    });

    editorActions.append(close, save, deleteGroup);

    removePicture.addEventListener("click", () => {
      if (removePicture.dataset.armed === "yes") {
        delete removePicture.dataset.armed;
        removePicture.textContent = "Remove group picture";
        return;
      }
      removePicture.dataset.armed = "yes";
      removePicture.textContent = "Save details to apply this";
      setTimeout(() => {
        if (removePicture.dataset.armed === "yes") {
          delete removePicture.dataset.armed;
          removePicture.textContent = "Remove group picture";
        }
      }, 6000);
    });

    editor.append(detailFields, membersBox, memberControls, editorActions);

    let editing = false;
    let minimised = Boolean(readUiState().collapsedGroups && readUiState().collapsedGroups[group.id]);

    const body = document.createElement("div");
    body.className = "group-body";
    body.hidden = minimised;
    body.append(editor);

    card.append(view, body);

    function syncToggle() {
      // The body reflects the minimise state only. Whether the editor inside
      // it is open is editor.hidden's business - mixing the two in one flag is
      // what made expanding look broken.
      body.hidden = minimised;
      toggle.setAttribute("aria-expanded", String(!minimised));
      toggle.textContent = minimised ? "Expand" : "Minimise";
    }

    function setGroupEditing(on) {
      editing = on;
      card.classList.toggle("is-editing", on);
      view.hidden = on;
      // The editor lives inside the collapsible body, so it has its own hidden
      // flag. Forgetting this is what made Edit look broken while the container
      // around it opened perfectly.
      editor.hidden = !on;
      editButton.hidden = on;

      if (on) {
        // Opening the editor always expands the card, otherwise it would open
        // onto something invisible.
        minimised = false;
        setGroupMinimised(group.id, false);
        syncToggle();
        nameInput.focus();
        // Members are only fetched once the editor is actually open.
        loadGroupMembers(group.id, allUsers, picker);
      } else {
        syncToggle();
      }
    }

    editButton.addEventListener("click", () => setGroupEditing(true));

    toggle.addEventListener("click", () => {
      minimised = !minimised;
      setGroupMinimised(group.id, minimised);
      syncToggle();
      if (!minimised) loadPreview(group, preview, allUsers);
    });

    card.__setMinimised = on => {
      minimised = on;
      syncToggle();
    };

    groupsList.append(card);
    loadPreview(group, preview, allUsers);
  }
}
function labelled(text, input) {
  const label = document.createElement("label");
  label.append(document.createTextNode(text), input);
  return label;
}

function setGroupMinimised(groupId, minimised) {
  const state = readUiState().collapsedGroups || {};
  if (minimised) state[groupId] = true;
  else delete state[groupId];
  writeUiState({ collapsedGroups: state });
}

// The collapsed view still needs to show who is in the group, so it asks the
// same endpoint the editor uses.
async function loadPreview(group, target, allUsers) {
  try {
    const { group: full } = await apiFetch(
      "/api/admin/groups/" + encodeURIComponent(group.id) + "/members", {}, "Group"
    );

    target.replaceChildren();

    if (!full.members.length) {
      const empty = document.createElement("span");
      empty.textContent = "No members yet.";
      target.append(empty);
      return;
    }

    for (const member of full.members) {
      const chip = document.createElement("span");
      chip.className = "group-member-chip";
      chip.textContent = member.name;
      target.append(chip);
    }

    const overflow = document.createElement("span");
    overflow.className = "group-member-more";
    const shown = Math.min(full.members.length, 8);
    overflow.textContent = shown < full.members.length
      ? `+${full.members.length - shown} more`
      : "";
    target.append(overflow);
  } catch {
    target.textContent = "";
  }
}

// Fills the editor's member list and the "add a member" picker. Called when a
// group is opened for editing, and again after any change to its membership.
async function loadGroupMembers(groupId, allUsers, picker) {
  const container = groupsList.querySelector(`[data-group-id="${groupId}"] [data-group-members]`);
  if (!container) return;

  container.textContent = "Loading members...";

  try {
    const { group } = await apiFetch("/api/admin/groups/" + encodeURIComponent(groupId) + "/members", {}, "Group");

    container.replaceChildren();

    if (!group.members.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No members in this group yet.";
      container.append(empty);
    }

    for (const member of group.members) {
      const row = document.createElement("div");
      row.className = "member-identity group-member";

      row.append(createAvatarChip(member));
      const name = document.createElement("span");
      name.textContent = member.name;
      row.append(name);

      const badge = document.createElement("small");
      badge.textContent = member.role === "admin" ? "Administrator" : "Member";
      row.append(badge);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "text-button group-remove";
      removeButton.textContent = "Remove";
      removeButton.setAttribute("aria-label", "Remove " + member.name + " from " + group.name);
      removeButton.addEventListener("click", async () => {
        removeButton.disabled = true;
        try {
          await apiFetch(
            "/api/admin/groups/" + encodeURIComponent(groupId) +
              "/members/" + encodeURIComponent(member.id),
            { method: "DELETE" },
            "Group member"
          );
          showGroupsMessage(`Removed ${member.name}.`);
          await loadGroups();
        } catch (error) {
          removeButton.disabled = false;
          showGroupsMessage(error.message, true);
        }
      });
      row.append(removeButton);

      container.append(row);
    }

    // Everyone not already in this group, so the picker never offers the same
    // person twice. Scoped to this group's own picker on purpose.
    fillMemberPicker(picker, group.members, allUsers);
  } catch (error) {
    container.textContent = error.message;
  }
}

function fillMemberPicker(picker, members, allUsers) {
  const inside = new Set(members.map(member => member.id));

  picker.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a member to add...";
  picker.append(placeholder);

  for (const user of allUsers) {
    if (inside.has(user.id) || user.status !== "active") continue;
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = user.name;
    picker.append(option);
  }
}

async function addMember(groupId, userId, state) {
  state.textContent = "Adding...";
  state.classList.remove("error");

  try {
    await apiFetch("/api/admin/groups/" + encodeURIComponent(groupId) + "/members", {
      method: "POST",
      body: JSON.stringify({ userId })
    }, "Group member");

    state.textContent = "Added";
    await loadGroups();
  } catch (error) {
    state.textContent = error.message;
    state.classList.add("error");
  }
}

groupCreateForm.addEventListener("submit", async event => {
  event.preventDefault();
  const name = el("#group-name-input").value.trim();
  const description = el("#group-description-input").value.trim();

  if (!name) {
    showGroupsMessage("Give the group a name.", true);
    return;
  }

  const submit = groupCreateForm.querySelector("button[type=submit]");
  submit.disabled = true;

  try {
    await apiFetch("/api/admin/groups", {
      method: "POST",
      body: JSON.stringify({ name, description })
    }, "Group creation");

    groupCreateForm.reset();
    showGroupsMessage(`Created "${name}".`);
    await loadGroups();
  } catch (error) {
    showGroupsMessage(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Locking a session to people and groups
// ---------------------------------------------------------------------------

function buildAccessPanel(item) {
  const panel = document.createElement("div");
  panel.className = "session-access-panel";
  panel.id = "access-" + item.id;
  panel.hidden = true;

  const summary = document.createElement("p");
  summary.className = "access-summary";
  panel.append(summary);

  const usersBox = document.createElement("fieldset");
  usersBox.className = "access-list";
  usersBox.innerHTML = "<legend>People</legend>";

  const groupsBox = document.createElement("fieldset");
  groupsBox.className = "access-list";
  groupsBox.innerHTML = "<legend>Groups</legend>";

  const controls = document.createElement("div");
  controls.className = "access-controls";

  const reset = createActionButton("Open to everyone");
  reset.addEventListener("click", async () => {
    reset.disabled = true;
    try {
      const result = await apiFetch(`/api/admin/sessions/${encodeURIComponent(item.id)}/access`, {
        method: "DELETE"
      }, "Session access");
      applyAccess(item, result.access, panel);
      await refreshAccessChoices(item, panel);
    } catch (error) {
      sessionsMessage(error.message, true);
    } finally {
      reset.disabled = false;
    }
  });

  const state = document.createElement("span");
  state.className = "row-state";
  state.setAttribute("role", "status");

  controls.append(reset, state);
  panel.append(usersBox, groupsBox, controls);
  return panel;
}

function applyAccess(item, access, panel) {
  const summary = panel.querySelector(".access-summary");

  if (!access.restricted) {
    summary.textContent = "Open to everyone. Any signed-in member can see this session.";
  } else {
    const parts = [];
    if (access.users.length) {
      parts.push(`${access.users.length} ${access.users.length === 1 ? "person" : "people"}: ` +
        access.users.map(user => user.name).join(", "));
    }
    if (access.groups.length) {
      parts.push(`${access.groups.length} ${access.groups.length === 1 ? "group" : "groups"}: ` +
        access.groups.map(group => group.name).join(", "));
    }
    summary.textContent = "Locked to " + parts.join("  -  ");
  }

  const cached = sessionsCache.find(entry => entry.id === item.id);
  if (cached) cached.restricted = access.restricted;

  // Keep the card's own badge honest without reloading the list.
  const card = sessionsList.querySelector(`[data-session-id="${item.id}"]`);
  if (!card) return;

  let lock = card.querySelector("[data-session-lock]");
  if (access.restricted && !lock) {
    lock = document.createElement("span");
    lock.className = "session-lock";
    lock.dataset.sessionLock = "";
    lock.textContent = "Locked";
    lock.title = "Only specific members and groups can see this session";
    card.querySelector(".session-card-heading").append(lock);
  } else if (!access.restricted && lock) {
    lock.remove();
  }
}

async function toggleAccessPanel(item, card, button) {
  const panel = card.querySelector(".session-access-panel");
  const opening = panel.hidden;

  panel.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
  button.textContent = opening ? "Hide access" : "Who can see this";

  if (!opening) return;

  const state = panel.querySelector(".row-state");
  state.textContent = "Loading...";

  try {
    await refreshAccessChoices(item, panel);
    state.textContent = "";
  } catch (error) {
    state.textContent = error.message;
    state.classList.add("error");
  }
}

async function refreshAccessChoices(item, panel) {
  const [access, users, groups] = await Promise.all([
    apiFetch(`/api/admin/sessions/${encodeURIComponent(item.id)}/access`, {}, "Session access"),
    apiFetch("/api/admin/users?q=", {}, "User list"),
    apiFetch("/api/admin/groups", {}, "Groups")
  ]);

  applyAccess(item, access.access, panel);

  const state = panel.querySelector(".row-state");

  const allowedUsers = new Set(access.access.users.map(user => user.id));
  const allowedGroups = new Set(access.access.groups.map(group => group.id));

  fillAccessList(panel.querySelectorAll("fieldset")[0], (users.users || [])
    .filter(user => user.status === "active"), allowedUsers, "users", item, state, access.access);

  fillAccessList(panel.querySelectorAll("fieldset")[1], groups.groups || [], allowedGroups, "groups", item, state, access.access);
}

function fillAccessList(fieldset, entries, allowed, kind, item, state, access) {
  fieldset.replaceChildren();

  const legend = document.createElement("legend");
  legend.textContent = kind === "users" ? "People" : "Groups";
  fieldset.append(legend);

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = kind === "users"
      ? "No accounts to choose from."
      : "No groups exist yet. Create one in the admin panel first.";
    fieldset.append(empty);
    return;
  }

  for (const entry of entries) {
    const label = document.createElement("label");
    label.className = "access-option";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = allowed.has(entry.id);
    box.dataset.accessId = entry.id;

    const text = document.createElement("span");
    text.textContent = entry.name;

    label.append(box, text);

    box.addEventListener("change", async () => {
      box.disabled = true;
      state.classList.remove("error");
      state.textContent = "Saving...";

      try {
        const result = await apiFetch(
          `/api/admin/sessions/${encodeURIComponent(item.id)}/access/${kind}/${encodeURIComponent(entry.id)}`,
          { method: "PUT", body: JSON.stringify({ allowed: box.checked }) },
          "Session access"
        );

        applyAccess(item, result.access, panelOf(fieldset));
        state.textContent = "Saved";
      } catch (error) {
        box.checked = !box.checked;
        state.textContent = error.message;
        state.classList.add("error");
      } finally {
        box.disabled = false;
      }
    });

    fieldset.append(label);
  }
}

function panelOf(fieldset) {
  return fieldset.closest(".session-access-panel");
}

// ---------------------------------------------------------------------------
// Deleting a session
// ---------------------------------------------------------------------------

async function deleteSession(item, card, button) {
  if (button.dataset.armed !== "yes") {
    button.dataset.armed = "yes";
    button.textContent = "Really delete";
    setTimeout(() => {
      if (button.dataset.armed === "yes") {
        button.dataset.armed = "no";
        button.textContent = "Delete";
      }
    }, 5000);
    return;
  }

  button.dataset.armed = "no";
  button.disabled = true;

  try {
    const result = await apiFetch("/api/admin/sessions/" + encodeURIComponent(item.id), {
      method: "DELETE"
    }, "Session deletion");

    sessionsCache = sessionsCache.filter(entry => entry.id !== item.id);
    attendanceCountNodes.delete(item.id);

    if (attendanceSessionId === item.id) closeAttendancePanel();
    if (editingSessionId === item.id) closeEditPanel();

    card.remove();
    sessionsMessage(`Deleted "${item.title}".` +
      (result.removed.attendance ? ` ${result.removed.attendance} attendance mark(s) went with it.` : ""));
  } catch (error) {
    button.disabled = false;
    button.textContent = "Delete";
    sessionsMessage(error.message, true);
  }
}

// ---------------------------------------------------------------------------
// My profile
// ---------------------------------------------------------------------------

async function loadProfile() {
  const attendance = el("#profile-attendance");

  if (!currentUser) return;

  attendance.textContent = "Loading your attendance history...";

  try {
    const data = await apiFetch("/api/profile", {}, "Profile");

    el("#profile-name").textContent = data.user.name || "User";
    el("#profile-email").textContent = data.email || "Not recorded";
    el("#profile-role").textContent = data.user.role === "admin" ? "Administrator" : "Member";
    el("#profile-created").textContent = data.user.createdAt
      ? new Date(data.user.createdAt.replace(" ", "T") + "Z").toLocaleDateString()
      : "Unknown";

    renderAvatar(profileAvatar, data.user);

    el("#profile-attended").textContent = data.stats.attended;
    el("#profile-excused").textContent = data.stats.excused;
    el("#profile-upcoming").textContent = data.stats.upcoming;

    const levelStat = el("#profile-level-stat");
    if (data.stats.levelsEnabled || data.stats.xpEnabled) {
      levelStat.hidden = false;
      el("#profile-level").textContent = data.stats.levelsEnabled
        ? `${data.stats.currentLevel} (${data.stats.xpBalance} XP)`
        : `${data.stats.xpBalance} XP`;
    } else {
      levelStat.hidden = true;
    }

    const rows = data.attendance || [];
    el("#profile-attendance-count").textContent = rows.length
      ? `${rows.length} session(s)`
      : "";

    attendance.replaceChildren();

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "You have not been marked for any session yet. Once an administrator marks your attendance it will appear here.";
      attendance.append(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "session-attendance-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Session", "When", "Where", "Your attendance"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headRow.append(cell);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");

    for (const row of rows) {
      const tr = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = row.title;

      const whenCell = document.createElement("td");
      whenCell.textContent = sessionDate(row.startsAt);

      const whereCell = document.createElement("td");
      whereCell.textContent = row.location || "-";

      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "session-status attendance-" + row.attendanceStatus;
      badge.textContent = row.attendanceStatus;
      statusCell.append(badge);
      if (row.notes) {
        const note = document.createElement("small");
        note.className = "attendance-note";
        note.textContent = row.notes;
        statusCell.append(note);
      }

      tr.append(nameCell, whenCell, whereCell, statusCell);
      tbody.append(tr);
    }

    table.append(tbody);
    attendance.append(table);
  } catch (error) {
    attendance.textContent = error.message || "Unable to load your profile.";
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadStoredTheme();
showRedirectMessage();
showSignedOut();
updatePageView();
checkApiStatus();
loadAccount();
