// Central runtime configuration.
//
// Priority:
// 1. Environment variables (development/testing overrides)
// 2. Generated release-config.js (packaged releases)
// 3. Safe built-in defaults
//
// release-config.js is generated during packaging and must not contain secrets.
let releaseConfig = {};
try {
  ({ RELEASE_CONFIG: releaseConfig = {} } = await import("./release-config.js"));
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
}

export function getConfig(env = process.env) {
  const port = Number(env.PORT || 1337);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Ungültiger PORT: ${env.PORT}`);
  }

  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const releaseClientId = String(releaseConfig.parqetClientId || "").trim();
  const clientId = String(env.PARQET_CLIENT_ID || releaseClientId).trim();

  return Object.freeze({
    port,
    baseUrl,
    clientId: clientId === "__PARQET_CLIENT_ID__" ? "" : clientId,
    currency: String(env.CURRENCY || "EUR").trim().toUpperCase(),
    appDataDir: String(env.APP_DATA_DIR || "").trim() || null
  });
}
