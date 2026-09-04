import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const releaseRoot = path.join(root, "dist", `parqet-strategic-liquidity-manager-${pkg.version}-linux-x64`);
const appDir = path.join(releaseRoot, "app");
const clientId = String(process.env.PARQET_RELEASE_CLIENT_ID || "").trim();

if (process.platform !== "linux" || process.arch !== "x64") {
  console.error("build:linux muss unter Linux x64 ausgeführt werden.");
  process.exit(1);
}
if (!clientId) {
  console.error("PARQET_RELEASE_CLIENT_ID fehlt. Linux-Release wurde nicht gebaut.");
  process.exit(1);
}

await fs.rm(releaseRoot, { recursive: true, force: true });
await fs.mkdir(appDir, { recursive: true });

for (const rel of ["server.js", "config.js", "package.json", "package-lock.json", "public"]) {
  await fs.cp(path.join(root, rel), path.join(appDir, rel), { recursive: true });
}

await fs.writeFile(path.join(appDir, "release-config.js"),
`// Generated release configuration.
export const RELEASE_CONFIG = Object.freeze({
  parqetClientId: ${JSON.stringify(clientId)}
});
`, { mode: 0o644 });

const npm = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: appDir,
  stdio: "inherit"
});
if (npm.status !== 0) process.exit(npm.status || 1);

const runtimeDir = path.join(releaseRoot, "runtime");
await fs.mkdir(runtimeDir, { recursive: true });
await fs.copyFile(process.execPath, path.join(runtimeDir, "node"));
await fs.chmod(path.join(runtimeDir, "node"), 0o755);

await fs.writeFile(path.join(releaseRoot, "start.sh"),
`#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$HERE/runtime/node" "$HERE/app/server.js"
`, { mode: 0o755 });

await fs.writeFile(path.join(releaseRoot, "launch.sh"),
`#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
URL="http://localhost:1337"

STATUS="$(curl -fsS "$URL/api/status" 2>/dev/null || true)"
if [ -n "$STATUS" ]; then
  EXPECTED="$HERE/app"
  case "$STATUS" in
    *"\\\"instancePath\\\":\\\"$EXPECTED\\\""*)
      xdg-open "$URL" >/dev/null 2>&1 &
      exit 0
      ;;
    *)
      echo "Port 1337 wird bereits von einer anderen SLM-Instanz verwendet." >&2
      echo "Bitte die andere Instanz beenden und erneut starten." >&2
      exit 2
      ;;
  esac
fi

mkdir -p "$HOME/.cache"
"$HERE/start.sh" >"$HOME/.cache/parqet-strategic-liquidity-manager.log" 2>&1 &

i=0
while [ "$i" -lt 40 ]; do
  STATUS="$(curl -fsS "$URL/api/status" 2>/dev/null || true)"
  if [ -n "$STATUS" ]; then
    EXPECTED="$HERE/app"
    case "$STATUS" in
      *"\\\"instancePath\\\":\\\"$EXPECTED\\\""*)
        xdg-open "$URL" >/dev/null 2>&1 &
        exit 0
        ;;
      *)
        echo "Port 1337 wurde während des Starts von einer anderen SLM-Instanz belegt." >&2
        exit 2
        ;;
    esac
  fi
  i=$((i + 1))
  sleep 0.25
done

echo "Die Anwendung konnte nicht gestartet werden. Log: $HOME/.cache/parqet-strategic-liquidity-manager.log" >&2
exit 1
`, { mode: 0o755 });

const iconCandidates = [
  path.join(root, "public", "app-icon.png"),
  path.join(root, "public", "favicon-32x32.png"),
  path.join(root, "public", "favicon-16x16.png")
];
let iconName = "";
for (const candidate of iconCandidates) {
  try {
    await fs.access(candidate);
    iconName = "app-icon.png";
    await fs.copyFile(candidate, path.join(releaseRoot, iconName));
    break;
  } catch {}
}

await fs.writeFile(path.join(releaseRoot, "install-desktop.sh"),
`#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
DESKTOP="$APPS/parqet-strategic-liquidity-manager.desktop"
cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Strategic Liquidity Manager for Parqet
Comment=Strategisches Liquiditäts- und Kreditmanagement
Exec=$HERE/launch.sh
${iconName ? `Icon=$HERE/${iconName}` : ""}
Terminal=false
Categories=Office;Finance;
StartupNotify=true
EOF
chmod 644 "$DESKTOP"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
echo "Menüeintrag installiert: $DESKTOP"
`, { mode: 0o755 });

await fs.writeFile(path.join(releaseRoot, "uninstall-desktop.sh"),
`#!/bin/sh
set -eu
DESKTOP="$HOME/.local/share/applications/parqet-strategic-liquidity-manager.desktop"
rm -f "$DESKTOP"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
echo "Menüeintrag entfernt."
`, { mode: 0o755 });

await fs.writeFile(path.join(releaseRoot, "install.sh"),
`#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET="$HOME/.local/opt/parqet-strategic-liquidity-manager"
APPS="$HOME/.local/share/applications"

mkdir -p "$HOME/.local/opt" "$APPS"
rm -rf "$TARGET"
cp -a "$HERE" "$TARGET"

"$TARGET/install-desktop.sh"

echo
echo "Strategic Liquidity Manager for Parqet ${pkg.version} wurde installiert."
echo "Programm: $TARGET"
echo "Benutzerdaten bleiben separat im plattformspezifischen User-Data-Verzeichnis."
echo "Die Anwendung kann jetzt über das Linux-Anwendungsmenü gestartet werden."
`, { mode: 0o755 });

await fs.writeFile(path.join(releaseRoot, "README.txt"),
`Strategic Liquidity Manager for Parqet ${pkg.version}

Recommended installation:
  ./install.sh

This installs the application to:
  ~/.local/opt/parqet-strategic-liquidity-manager

Portable/direct start without installation:
  ./launch.sh

Optional menu integration for the current folder:
  ./install-desktop.sh

Remove menu integration:
  ./uninstall-desktop.sh

Direct server start for diagnostics:
  ./start.sh

The application opens at http://localhost:1337.
The Node.js runtime and production dependencies are included.
User data is stored outside this release directory.
`);

const archiveName = `${path.basename(releaseRoot)}.tar.gz`;
const archivePath = path.join(root, "dist", archiveName);
await fs.rm(archivePath, { force: true });

const tar = spawnSync("tar", [
  "-czf", archivePath,
  "-C", path.dirname(releaseRoot),
  path.basename(releaseRoot)
], { stdio: "inherit" });
if (tar.status !== 0) process.exit(tar.status || 1);

const debRoot = path.join(root, "dist", "deb-root");
const debName = `parqet-strategic-liquidity-manager_${pkg.version}_amd64.deb`;
const debPath = path.join(root, "dist", debName);
const optDir = path.join(debRoot, "opt", "parqet-strategic-liquidity-manager");
const binDir = path.join(debRoot, "usr", "bin");
const desktopDir = path.join(debRoot, "usr", "share", "applications");
const iconDir = path.join(debRoot, "usr", "share", "icons", "hicolor", "256x256", "apps");
const debianDir = path.join(debRoot, "DEBIAN");

await fs.rm(debRoot, { recursive: true, force: true });
await fs.rm(debPath, { force: true });
await fs.mkdir(optDir, { recursive: true });
await fs.mkdir(binDir, { recursive: true });
await fs.mkdir(desktopDir, { recursive: true });
await fs.mkdir(iconDir, { recursive: true });
await fs.mkdir(debianDir, { recursive: true });

for (const rel of ["app", "runtime", "start.sh"]) {
  await fs.cp(path.join(releaseRoot, rel), path.join(optDir, rel), { recursive: true });
}

if (iconName) {
  await fs.copyFile(
    path.join(releaseRoot, iconName),
    path.join(iconDir, "parqet-strategic-liquidity-manager.png")
  );
}

await fs.writeFile(path.join(binDir, "parqet-strategic-liquidity-manager"),
`#!/bin/sh
set -eu
APP="/opt/parqet-strategic-liquidity-manager"
URL="http://localhost:1337"
STATUS="$(curl -fsS "$URL/api/status" 2>/dev/null || true)"

if [ -n "$STATUS" ]; then
  case "$STATUS" in
    *"\\\"instancePath\\\":\\\"$APP/app\\\""*)
      xdg-open "$URL" >/dev/null 2>&1 &
      exit 0
      ;;
    *)
      echo "Port 1337 wird bereits von einer anderen SLM-Instanz verwendet." >&2
      exit 2
      ;;
  esac
fi

mkdir -p "$HOME/.cache"
"$APP/start.sh" >"$HOME/.cache/parqet-strategic-liquidity-manager.log" 2>&1 &

i=0
while [ "$i" -lt 40 ]; do
  STATUS="$(curl -fsS "$URL/api/status" 2>/dev/null || true)"
  case "$STATUS" in
    *"\\\"instancePath\\\":\\\"$APP/app\\\""*)
      xdg-open "$URL" >/dev/null 2>&1 &
      exit 0
      ;;
  esac
  i=$((i + 1))
  sleep 0.25
done

echo "Die Anwendung konnte nicht gestartet werden." >&2
exit 1
`, { mode: 0o755 });

await fs.writeFile(path.join(desktopDir, "parqet-strategic-liquidity-manager.desktop"),
`[Desktop Entry]
Type=Application
Name=Strategic Liquidity Manager for Parqet
Comment=Strategisches Liquiditäts- und Kreditmanagement
Exec=parqet-strategic-liquidity-manager
Icon=parqet-strategic-liquidity-manager
Terminal=false
Categories=Office;Finance;
StartupNotify=true
`);

await fs.writeFile(path.join(debianDir, "control"),
`Package: parqet-strategic-liquidity-manager
Version: ${pkg.version}
Section: office
Priority: optional
Architecture: amd64
Maintainer: Strategic Liquidity Manager Project
Depends: curl, xdg-utils
Description: Strategic Liquidity Manager for Parqet
 Local strategic liquidity and credit management application with
 Bitcoin Buy-Borrow-Die planning and read-only Parqet integration.
`);

await fs.writeFile(path.join(debianDir, "postinst"),
`#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
exit 0
`, { mode: 0o755 });

await fs.writeFile(path.join(debianDir, "postrm"),
`#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
# Deliberately do not touch ~/.local/share/parqet-strategic-liquidity-manager.
exit 0
`, { mode: 0o755 });

const dpkg = spawnSync("dpkg-deb", ["--build", "--root-owner-group", debRoot, debPath], {
  stdio: "inherit"
});
if (dpkg.status !== 0) {
  console.error("DEB-Paket konnte nicht gebaut werden. Ist dpkg-deb installiert?");
  process.exit(dpkg.status || 1);
}
await fs.rm(debRoot, { recursive: true, force: true });

console.log(`Linux release created: ${releaseRoot}`);
console.log(`Distribution archive created: ${archivePath}`);
console.log(`Debian package created: ${debPath}`);
