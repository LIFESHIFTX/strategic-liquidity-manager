import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const releaseRoot = path.join(root, "dist", `parqet-strategic-liquidity-manager-${pkg.version}-windows-x64`);
const appDir = path.join(releaseRoot, "app");
const runtimeDir = path.join(releaseRoot, "runtime");
const clientId = String(process.env.PARQET_RELEASE_CLIENT_ID || "").trim();

if (process.platform !== "win32" || process.arch !== "x64") {
  console.error("build:windows muss unter Windows x64 ausgeführt werden.");
  process.exit(1);
}
if (!clientId) {
  console.error("PARQET_RELEASE_CLIENT_ID fehlt. Windows-Release wurde nicht gebaut.");
  process.exit(1);
}

await fs.rm(releaseRoot, { recursive: true, force: true });
await fs.mkdir(appDir, { recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });
for (const rel of ["server.js", "config.js", "package.json", "package-lock.json", "public"]) {
  await fs.cp(path.join(root, rel), path.join(appDir, rel), { recursive: true });
}
await fs.writeFile(path.join(appDir, "release-config.js"),
`// Generated release configuration.\nexport const RELEASE_CONFIG = Object.freeze({\n  parqetClientId: ${JSON.stringify(clientId)}\n});\n`);

const npm = spawnSync("cmd.exe", ["/d", "/s", "/c", "npm.cmd ci --omit=dev --ignore-scripts"], { cwd: appDir, stdio: "inherit" });
if (npm.status !== 0) process.exit(npm.status || 1);
await fs.copyFile(process.execPath, path.join(runtimeDir, "node.exe"));

await fs.writeFile(path.join(releaseRoot, "start.cmd"),
`@echo off\r\nsetlocal\r\nset "HERE=%~dp0"\r\n"%HERE%runtime\\node.exe" "%HERE%app\\server.js"\r\n`);

await fs.writeFile(path.join(releaseRoot, "launch.ps1"),
`$ErrorActionPreference = "Stop"\n$here = Split-Path -Parent $MyInvocation.MyCommand.Path\n$url = "http://localhost:1337"\n$expected = Join-Path $here "app"\n$logDir = Join-Path $env:LOCALAPPDATA "Parqet Strategic Liquidity Manager"\n$logFile = Join-Path $logDir "launcher.log"\nfunction Get-SlmStatus {\n  try {\n    $json = & curl.exe --silent --show-error --fail --max-time 1 "$url/api/status"\n    if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }\n    return $json | ConvertFrom-Json\n  } catch {\n    return $null\n  }\n}\n$status = Get-SlmStatus\nif ($status) {\n  if ([System.IO.Path]::GetFullPath($status.instancePath).TrimEnd('\\') -eq [System.IO.Path]::GetFullPath($expected).TrimEnd('\\')) { cmd.exe /c start "" $url; exit 0 }\n  Add-Type -AssemblyName PresentationFramework\n  [System.Windows.MessageBox]::Show("Port 1337 wird bereits von einer anderen SLM-Instanz verwendet.", "Strategic Liquidity Manager") | Out-Null\n  exit 2\n}\nNew-Item -ItemType Directory -Force -Path $logDir | Out-Null\n$node = Join-Path $here "runtime\\node.exe"\n$server = Join-Path $here "app\\server.js"\nStart-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory $here -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"\nfor ($i = 0; $i -lt 40; $i++) {\n  Start-Sleep -Milliseconds 250\n  $status = Get-SlmStatus\n  if ($status) {\n    if ([System.IO.Path]::GetFullPath($status.instancePath).TrimEnd('\\') -eq [System.IO.Path]::GetFullPath($expected).TrimEnd('\\')) { cmd.exe /c start "" $url; exit 0 }\n    exit 2\n  }\n}\nAdd-Type -AssemblyName PresentationFramework\n[System.Windows.MessageBox]::Show("Die Anwendung konnte nicht gestartet werden. Log: $logFile", "Strategic Liquidity Manager") | Out-Null\nexit 1\n`);

await fs.writeFile(path.join(releaseRoot, "launch.cmd"),
`@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"\r\n`);
await fs.writeFile(path.join(releaseRoot, "README.txt"),
`Strategic Liquidity Manager for Parqet ${pkg.version} - Windows x64\n\nStart: Doppelklick auf launch.cmd\n\nDie Anwendung öffnet http://localhost:1337 im Standardbrowser.\nNode.js und Produktionsabhängigkeiten sind enthalten.\nBenutzerdaten liegen separat unter %LOCALAPPDATA%\\Parqet Strategic Liquidity Manager und bleiben beim Löschen des Programmordners erhalten.\n`);

const zipPath = `${releaseRoot}.zip`;
await fs.rm(zipPath, { force: true });
// Use Windows bsdtar instead of PowerShell Compress-Archive.
// Compress-Archive can report file-lock errors without reliably propagating
// a failing exit status to the parent process.
const tar = spawnSync(
  "tar.exe",
  ["-a", "-c", "-f", zipPath, "-C", releaseRoot, "."],
  { stdio: "inherit" }
);

if (tar.error) {
  console.error(`ZIP-Erstellung konnte nicht gestartet werden: ${tar.error.message}`);
  process.exit(1);
}

if (tar.status !== 0) {
  console.error(`ZIP-Erstellung fehlgeschlagen (Exit-Code ${tar.status}).`);
  process.exit(tar.status || 1);
}

try {
  const zipStat = await fs.stat(zipPath);
  if (!zipStat.isFile() || zipStat.size < 1024) {
    throw new Error("ZIP-Datei fehlt oder ist unplausibel klein.");
  }
} catch (err) {
  console.error(`ZIP-Prüfung fehlgeschlagen: ${err.message}`);
  process.exit(1);
}
console.log(`Windows release created: ${releaseRoot}`);
console.log(`Windows ZIP created: ${zipPath}`);
