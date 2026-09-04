import fs from "node:fs/promises";

const clientId = String(process.env.PARQET_RELEASE_CLIENT_ID || "").trim();
if (!clientId) {
  console.error("PARQET_RELEASE_CLIENT_ID fehlt. Release-Konfiguration wurde nicht erzeugt.");
  process.exit(1);
}

const content = `// Generated file. Do not edit manually.
export const RELEASE_CONFIG = Object.freeze({
  parqetClientId: ${JSON.stringify(clientId)}
});
`;

await fs.writeFile(new URL("../release-config.js", import.meta.url), content, { mode: 0o600 });
console.log("release-config.js wurde erzeugt.");
