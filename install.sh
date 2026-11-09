#!/bin/sh
# Installs the latest polypore release into ~/.local/bin (or $POLYPORE_INSTALL_DIR).
#   curl -fsSL https://raw.githubusercontent.com/evanklem/polypore/main/install.sh | sh
# Set POLYPORE_VERSION=v0.2.0 to pin a release.
set -eu

repo=evanklem/polypore
dir=${POLYPORE_INSTALL_DIR:-$HOME/.local/bin}

case "$(uname -s)" in
  Linux) os=unknown-linux-gnu ;;
  Darwin) os=apple-darwin ;;
  *) echo "polypore: no prebuilt binary for $(uname -s); try: cargo install --git https://github.com/$repo --locked" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) echo "polypore: no prebuilt binary for $(uname -m)" >&2; exit 1 ;;
esac
target="$arch-$os"

if [ -n "${POLYPORE_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$POLYPORE_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi
file="polypore-$target.tar.gz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading $file"
curl -fsSL "$base/$file" -o "$tmp/$file"
curl -fsSL "$base/$file.sha256" -o "$tmp/$file.sha256"

want=$(cut -d' ' -f1 "$tmp/$file.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$file" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)
fi
if [ "$want" != "$got" ]; then
  echo "polypore: checksum mismatch for $file" >&2
  exit 1
fi

tar -xzf "$tmp/$file" -C "$tmp"
mkdir -p "$dir"
install -m 755 "$tmp/polypore-$target/polypore" "$dir/polypore"
echo "installed $dir/polypore"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH" ;;
esac
