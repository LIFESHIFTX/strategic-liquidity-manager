#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "=== Strategic Liquidity Manager – Linux Release Build ==="
echo

if [[ ! -f .env ]]; then
    echo "FEHLER: .env wurde nicht gefunden."
    exit 1
fi

PARQET_RELEASE_CLIENT_ID="$(
    sed -n 's/^[[:space:]]*PARQET_CLIENT_ID[[:space:]]*=[[:space:]]*//p' .env |
    head -n1 |
    tr -d '\r'
)"

if [[ -z "$PARQET_RELEASE_CLIENT_ID" ]]; then
    echo "FEHLER: PARQET_CLIENT_ID fehlt in .env."
    exit 1
fi

export PARQET_RELEASE_CLIENT_ID

VERSION="$(node -p "require('./package.json').version")"

echo "Version: v${VERSION}"
echo "Parqet Release Client-ID: gefunden"
echo
echo "Starte Linux-Build ..."
echo

npm run check
npm run build:linux

echo
echo "=== BUILD ERFOLGREICH ==="
echo
echo "Release-Dateien:"
ls -lh "dist/parqet-strategic-liquidity-manager_${VERSION}_amd64.deb" \
       "dist/parqet-strategic-liquidity-manager-${VERSION}-linux-x64.tar.gz"

echo
echo "SHA-256:"
sha256sum \
    "dist/parqet-strategic-liquidity-manager_${VERSION}_amd64.deb" \
    "dist/parqet-strategic-liquidity-manager-${VERSION}-linux-x64.tar.gz"
