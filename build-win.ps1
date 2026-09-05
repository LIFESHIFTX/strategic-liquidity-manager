# build-windows.ps1

$ErrorActionPreference = "Stop"

# Projektverzeichnis
Set-Location "C:\Users\familie\Documents\parqet-risk-pots-windows-build"

# Echte Parqet Client-ID
$env:PARQET_RELEASE_CLIENT_ID = "019feb6a-1542-7228-a850-5a27174d1d7e"

Write-Host ""
Write-Host "Strategic Liquidity Manager - Windows Build"
Write-Host "Client-ID gesetzt."
Write-Host ""

# Windows Distribution bauen
npm.cmd run build:windows

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "BUILD FEHLGESCHLAGEN."
    Read-Host "Enter zum Beenden"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "BUILD ERFOLGREICH."
Write-Host "Release liegt im dist-Verzeichnis."
Write-Host ""

Read-Host "Enter zum Beenden"

