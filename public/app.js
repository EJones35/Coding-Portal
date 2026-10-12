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
  achievements: "#profile-achievements"
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
  } catch {
    statusElement.textContent = "Portal services unavailable";
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

function maskEmail(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes("@")) return "";

  const local = trimmed.slice(0, trimmed.indexOf("@"));
  return `${local.slice(0, 1)}${"â€¢".repeat(Math.min(4, Math.max(2, local.length - 1)))}@â€¢â€¢â€¢â€¢â€¢â€¢`;
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

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !deleteModal.hidden) closeDeleteModal();
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

  // An administrator who switches to the user preview must not stay parked on
  // an administrator-only page.
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
    }
    if (route === "sessions") loadSessions();
    if (route === "profile") loadProfile();
  }
}

function setPreviewMode(enabled) {
  userPreviewMode = Boolean(enabled) && Boolean(currentUser && currentUser.role === "admin");
  if (userPreviewMode && currentUser) {
    adminPanel.hidden = true;
    adminPreferences.hidden = false;
    previewBanner.hidden = false;
  }
  updatePageView();
}

previewToggle.addEventListener("click", () => setPreviewMode(!userPreviewMode));
previewExit.addEventListener("click", () => setPreviewMode(false));

window.addEventListener("hashchange", updatePageView);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionDate(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function loadSessions() {
  sessionsPanel.hidden = false;
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
    const data = await apiFetch("/api/sessions", {}, "Sessions");
    sessionsCache = data.sessions || [];

    if (!sessionsCache.length) {
      sessionsMessage("No sessions have been scheduled yet.");
      return;
    }
    sessionsMessage(`${sessionsCache.length} session(s) found.`);

    for (const item of sessionsCache) {
      const card = document.createElement("article");
      card.className = "session-card";
      card.dataset.sessionId = item.id;

      const heading = document.createElement("div");
      heading.className = "session-card-heading";
      const title = document.createElement("h3");
      title.textContent = item.title;
      title.dataset.sessionTitle = "";
      const status = document.createElement("span");
      status.className = "session-status status-" + item.status;
      status.textContent = item.status;
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
          option.textContent = value;
          option.selected = value === item.status;
          select.append(option);
        }
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

        actions.append(edit, attendance, select);
        card.append(actions);

        const access = createActionButton("Who can see this");
        access.className = "secondary-button access-toggle";
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

      sessionsList.append(card);
    }
  } catch (error) {
    sessionsList.replaceChildren();
    attendanceCountNodes.clear();
    sessionsMessage(error.message || "Unable to load sessions.", true);
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
    ["Starts", sessionDate(item.startsAt)],
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
    badge.textContent = session.status;
    badge.className = "session-status status-" + session.status;
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

      const who = document.createElement("div");
      who.className = "member-identity";
      who.append(createAvatarChip(user));
      const whoText = document.createElement("span");
      whoText.textContent = user.name;
      who.append(whoText);

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

      identity.append(who, emailRow, name, reason, meta);
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

    const heading = document.createElement("div");
    heading.className = "group-card-heading";
    const title = document.createElement("h4");
    title.textContent = group.name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = `${group.memberCount} member(s)`;
    heading.append(title, count);
    card.append(heading);

    if (group.description) {
      const description = document.createElement("p");
      description.className = "group-description";
      description.textContent = group.description;
      card.append(description);
    }

    const members = document.createElement("div");
    members.className = "group-members";
    members.dataset.groupMembers = "";
    card.append(members);

    const controls = document.createElement("div");
    controls.className = "group-controls";

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

    const remove = createActionButton("Delete group");
    remove.classList.add("danger-link");
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete the group "${group.name}"? Members are not removed from the portal.`)) return;
      remove.disabled = true;
      try {
        await apiFetch("/api/admin/groups/" + encodeURIComponent(group.id), {
          method: "DELETE"
        }, "Group deletion");
        showGroupsMessage(`Deleted "${group.name}".`);
        await loadGroups();
      } catch (error) {
        remove.disabled = false;
        showGroupsMessage(error.message, true);
      }
    });

    controls.append(picker, add, state, remove);
    card.append(controls);

    groupsList.append(card);

    loadGroupMembers(group.id, allUsers, picker);
  }
}

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

    // Anything in this group is not offered again.
    const inside = new Set(group.members.map(member => member.id));
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
  } catch (error) {
    container.textContent = error.message;
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
    summary.textContent = "Locked to " + parts.join(" Â· ");
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
