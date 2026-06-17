#!/usr/bin/env bash
# Build the current Polypore source into an AppImage and swap it into
# ~/Applications, backing up the previous install.
#
# Why this exists: `npm run tauri build` fails at the AppImage step
# ("failed to run linuxdeploy") because Tauri runs the nested
# linuxdeploy-plugin-appimage AppImage in a way that trips on FUSE here.
# Working recipe: let the tauri build regenerate a clean AppDir (and apply
# the gtk plugin) even though it fails at the appimage step, then run
# linuxdeploy's appimage output ourselves over FUSE. Do NOT set
# APPIMAGE_EXTRACT_AND_RUN for that step — it breaks the plugin's relative
# AppDir lookup.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$REPO/src-tauri/target/release/bundle/appimage"
APPDIR="$BUNDLE_DIR/Polypore.AppDir"
IMAGE_NAME="Polypore_0.1.0_amd64.AppImage"
INSTALL_DIR="$HOME/Applications"
LINUXDEPLOY="$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage"

if [[ ! -x "$LINUXDEPLOY" ]]; then
  echo "linuxdeploy not found at $LINUXDEPLOY — run a normal 'npm run tauri build' once to fetch it." >&2
  exit 1
fi

echo "==> Regenerating a clean AppDir (tauri build; appimage step is expected to fail)"
rm -rf "$BUNDLE_DIR"
cd "$REPO"
# The appimage step fails at FUSE; that's fine, we bundle it ourselves below.
npm run tauri build -- --bundles appimage || true

if [[ ! -d "$APPDIR" ]]; then
  echo "AppDir was not produced — the build failed before bundling. Check the tauri output above." >&2
  exit 1
fi

echo "==> Bundling AppImage over FUSE"
cd "$BUNDLE_DIR"
ARCH=x86_64 NO_STRIP=true OUTPUT="$IMAGE_NAME" \
  "$LINUXDEPLOY" --appdir Polypore.AppDir --output appimage

if [[ ! -f "$BUNDLE_DIR/$IMAGE_NAME" ]]; then
  echo "AppImage was not produced." >&2
  exit 1
fi

echo "==> Swapping into $INSTALL_DIR (atomic rename; backs up the previous install)"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
if [[ -f "$IMAGE_NAME" ]]; then
  mv "$IMAGE_NAME" "$IMAGE_NAME.bak-$(date +%Y%m%d-%H%M%S)"
fi
mv "$BUNDLE_DIR/$IMAGE_NAME" "$IMAGE_NAME"
chmod +x "$IMAGE_NAME"

echo "==> Done. Installed: $INSTALL_DIR/$IMAGE_NAME"
ls -la "$INSTALL_DIR/$IMAGE_NAME"
if pgrep -fi "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "NOTE: a Polypore instance is currently running — quit and relaunch to pick up the new build."
fi
