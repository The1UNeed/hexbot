#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:?Usage: build.sh OUTPUT [arm64|x86_64]}
architecture=${2:-$(uname -m)}
case "$architecture" in arm64|x86_64) ;; *) echo "Unsupported Mac architecture" >&2; exit 1 ;; esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/hexbot-pdf-build.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

xcrun swift build --package-path "$root" --scratch-path "$scratch" \
  --configuration release --triple "$architecture-apple-macosx12.0" --jobs 2
directory=$(xcrun swift build --package-path "$root" --scratch-path "$scratch" \
  --configuration release --triple "$architecture-apple-macosx12.0" --show-bin-path)
mkdir -p "$(dirname -- "$output")"
install -m 755 "$directory/hexbot-pdf-vm" "$output"
# Local prototype signing. Release packaging must apply its Developer ID with
# the same entitlement before hashing and notarizing the native runtime.
codesign --force --sign - --options runtime --entitlements "$root/entitlements.plist" "$output"
