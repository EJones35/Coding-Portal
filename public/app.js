async function checkApiStatus() {
  const statusElement = document.querySelector("#api-status");

  try {
    const response = await fetch("/api/health", {
      method: "GET",
      headers: { "accept": "application/json" },
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error("API returned an unsuccessful response");
    }

    const result = await response.json();
    if (result.status !== "ok") {
      throw new Error("API health check did not pass");
    }

    statusElement.textContent = "API connection established";
  } catch {
    statusElement.textContent = "API connection unavailable";
  }
}

checkApiStatus();
