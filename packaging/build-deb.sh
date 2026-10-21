#!/usr/bin/env bash
# Usage: packaging/build-deb.sh [amd64|arm64]...  (default: both)
# Bundles an official Node.js build: Debian's own nodejs is too old for node:sqlite.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_VERSION="${NODE_VERSION:-24.18.0}"
VERSION="$(node -p "require('./package.json').version")"
ARCHES=("$@")
[ $# -eq 0 ] && ARCHES=(amd64 arm64)

npm ci
npm run build

for ARCH in "${ARCHES[@]}"; do
  case "$ARCH" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "Architecture inconnue : $ARCH" >&2; exit 1 ;;
  esac
  ROOT="build/deb-$ARCH"
  APP="$ROOT/opt/neopaperless"
  rm -rf "$ROOT"
  mkdir -p "$APP" "$ROOT/DEBIAN" "$ROOT/lib/systemd/system" "$ROOT/etc/default"

  cp -r package.json package-lock.json server dist "$APP/"
  rm -f "$APP"/server/*.test.js
  (cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm package-lock.json)

  TARBALL="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  mkdir -p build/cache
  if [ ! -f "build/cache/$TARBALL" ]; then
    curl -fsSL -o "build/cache/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TARBALL\$" | (cd build/cache && sha256sum -c -)
  fi
  mkdir -p "$APP/node"
  tar -xJf "build/cache/$TARBALL" -C "$APP/node" --strip-components=1 "node-v$NODE_VERSION-linux-$NODE_ARCH/bin/node" "node-v$NODE_VERSION-linux-$NODE_ARCH/LICENSE"

  cp packaging/neopaperless.service "$ROOT/lib/systemd/system/"
  cp packaging/default "$ROOT/etc/default/neopaperless"
  echo /etc/default/neopaperless > "$ROOT/DEBIAN/conffiles"
  cp packaging/debian/postinst packaging/debian/prerm packaging/debian/postrm "$ROOT/DEBIAN/"
  chmod 755 "$ROOT"/DEBIAN/post* "$ROOT/DEBIAN/prerm"

  cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: neopaperless
Version: $VERSION
Architecture: $ARCH
Maintainer: NeoPaperless <noreply@localhost>
Depends: poppler-utils, tar, adduser
Recommends: tesseract-ocr, tesseract-ocr-fra
Section: web
Priority: optional
Installed-Size: $(du -sk "$ROOT" | cut -f1)
Description: Gestion moderne de documents (factures, bulletins de paie, notices)
 Interface web responsive et PWA, recherche plein texte, partage,
 sauvegarde et restauration. Écoute par défaut sur le port 3001.
CONTROL

  dpkg-deb --root-owner-group --build "$ROOT" "build/neopaperless_${VERSION}_${ARCH}.deb"
done
ls -lh build/*.deb
