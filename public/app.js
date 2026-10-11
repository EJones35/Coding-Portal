const statusElement = document.querySelector("#api-status");
const accountTitle = document.querySelector("#account-title");
const accountMessage = document.querySelector("#account-message");
const authMessage = document.querySelector("#auth-message");
const googleSignIn = document.querySelector("#google-sign-in");
const signedInActions = document.querySelector("#signed-in-actions");
const accountName = document.querySelector("#account-name");
const accountRole = document.querySelector("#account-role");
const accountAvatar = document.querySelector("#account-avatar");
const signOutButton = document.querySelector("#sign-out");

function showAuthMessage(message) {
  authMessage.textContent = message;
  authMessage.hidden = !message;
}

function getCookie(name) {
  const secureName = `__Host-${name}`;
  const parts = document.cookie.split(";");

  for (const part of parts) {
    const item = part.trim();
    const separator = item.indexOf("=");
    if (separator < 0) continue;

    const key = item.slice(0, separator);
    if (key === name || key === secureName) {
      return item.slice(separator + 1);
    }
  }

  return null;
}

function showSignedOut() {
  googleSignIn.hidden = false;
  signedInActions.hidden = true;
  accountTitle.textContent = "Welcome to your portal";
  accountMessage.textContent =
    "Sign in with your Google account to get started.";
}

function showSignedIn(user) {
  googleSignIn.hidden = true;
  signedInActions.hidden = false;

  accountTitle.textContent = "You're signed in";
  accountMessage.textContent =
    "Your account is connected. More portal features are being built.";

  accountName.textContent = user.name || "User";
  accountRole.textContent =
    user.role === "admin" ? "Administrator" : "Member";

  accountAvatar.textContent =
    (user.name || "U").trim().charAt(0).toUpperCase();
}

async function loadAccount() {
  try {
    const response = await fetch("/api/auth/me", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) throw new Error("Account lookup failed");

    const result = await response.json();

    if (result.user) {
      showSignedIn(result.user);
    } else {
      showSignedOut();
    }
  } catch {
    showSignedOut();
    showAuthMessage("Unable to check your account. Please refresh and try again.");
  }
}

async function checkApiStatus() {
  try {
    const response = await fetch("/api/health", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) throw new Error("API unavailable");

    const result = await response.json();
    if (result.status !== "ok") throw new Error("Health check failed");

    statusElement.textContent = "Portal services connected";
  } catch {
    statusElement.textContent = "Portal services unavailable";
  }
}

async function signOut() {
  signOutButton.disabled = true;
  showAuthMessage("");

  try {
    const csrfToken = getCookie("csp_csrf");

    if (!csrfToken) {
      throw new Error("Your security token is missing. Refresh the page and try again.");
    }

    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-csrf-token": csrfToken
      },
      credentials: "same-origin"
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to sign out.");
    }

    showSignedOut();
    showAuthMessage("You have signed out successfully.");
  } catch (error) {
    showAuthMessage(error.message || "Unable to sign out. Please try again.");
  } finally {
    signOutButton.disabled = false;
  }
}

function showRedirectMessage() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("auth_error");

  if (!error) return;

  const messages = {
    google_signin_failed:
      "Google sign-in could not be completed. Please try again.",
    google_signin_cancelled:
      "Google sign-in was cancelled."
  };

  showAuthMessage(messages[error] || "Sign-in failed. Please try again.");

  params.delete("auth_error");
  const query = params.toString();
  const cleanUrl = window.location.pathname +
    (query ? `?${query}` : "") +
    window.location.hash;

  window.history.replaceState({}, "", cleanUrl);
}

googleSignIn.addEventListener("click", event => {
  event.preventDefault();
  window.location.assign("/api/auth/google?next=%2F");
});

signOutButton.addEventListener("click", signOut);

showRedirectMessage();
showSignedOut();
checkApiStatus();
loadAccount();
