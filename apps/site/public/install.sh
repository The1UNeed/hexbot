#!/bin/sh
set -eu

# Everything runs from main, so a download cut short by `curl | sh` runs nothing.
main() {
    fail() { printf '%s\n' "$*" >&2; exit 1; }

    case "$(uname -s)/$(uname -m)" in
        Darwin/arm64|Darwin/aarch64) target=macos-aarch64 ;;
        Darwin/x86_64) target=macos-x86_64 ;;
        Linux/x86_64|Linux/amd64) target=linux-x86_64 ;;
        *) fail 'Hexbot supports macOS on Apple silicon or Intel, and Linux on x86_64. This computer is not supported.' ;;
    esac

    base=${HEXBOT_UPDATE_URL:-https://updates.hexbot.app}
    base=${base%/}
    track=${HEXBOT_TRACK:-}
    for arg in "$@"; do
        case "$arg" in
            --nightly) track=nightly ;;
            --stable) track=stable ;;
        esac
    done
    case "$track" in ''|stable|nightly) ;; *) fail 'HEXBOT_TRACK must be stable or nightly.' ;; esac

    if command -v curl >/dev/null 2>&1; then
        downloader=curl
        fetch() { curl --fail --silent --show-error --location --connect-timeout 30 --output "$2" "$1"; }
    elif command -v wget >/dev/null 2>&1; then
        downloader=wget
        fetch() { wget -q -O "$2" "$1"; }
    else
        fail 'Install curl or wget, then run this command again.'
    fi

    if command -v sha256sum >/dev/null 2>&1; then
        checksum() { sha256sum "$1" | awk '{print $1}'; }
    elif command -v shasum >/dev/null 2>&1; then
        checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
    else
        fail 'Install sha256sum or shasum, then run this command again.'
    fi

    cache=${HEXBOT_INSTALL_TMPDIR:-${XDG_CACHE_HOME:-$HOME/.cache}/hexbot}
    mkdir -p "$cache"
    tmp=$(mktemp -d "$cache/hexbot-install.XXXXXXXX")
    trap 'rm -rf "$tmp"' 0
    trap 'exit 1' HUP INT TERM

    if [ -z "$track" ]; then
        network_error='Could not reach the update server. Check your connection and try again.'
        if [ "$downloader" = curl ]; then
            code=$(curl --silent --show-error --location --connect-timeout 30 --output "$tmp/manifest.json" --write-out '%{http_code}' "$base/install/stable.json") || fail "$network_error"
            case "$code" in
                200) track=stable ;;
                404) track=nightly ;;
                *) fail "$network_error" ;;
            esac
        else
            if wget -O "$tmp/manifest.json" "$base/install/stable.json" 2>"$tmp/wget-error"; then
                track=stable
            elif grep -q 'ERROR 404' "$tmp/wget-error"; then
                track=nightly
            else
                fail "$network_error"
            fi
        fi
    fi
    # Published alongside install/<track>.json, with no header:
    # <target> <64 lowercase hex sha256 characters> <absolute URL without whitespace>
    fetch "$base/install/$track.txt" "$tmp/install.txt" || fail 'Could not download the installer index.'
    line=$(awk -v target="$target" '$1 == target { if (NF != 3 || seen++) exit 1; print $2 " " $3; found=1 } END { if (!found) exit 1 }' "$tmp/install.txt") || fail 'The installer is not available for this computer.'
    sha=${line%% *}
    url=${line#* }
    [ "${#sha}" -eq 64 ] || fail 'The installer index contains an invalid checksum.'
    case "$sha" in *[!0-9a-f]*) fail 'The installer index contains an invalid checksum.' ;; esac
    case "$url" in "$base/"*) ;; *) fail 'The installer URL must be on the update server.' ;; esac

    printf 'Downloading the Hexbot installer (%s).\n' "$track" >&2
    fetch "$url" "$tmp/hexbot-install" || fail 'Could not download the Hexbot installer.'
    actual=$(checksum "$tmp/hexbot-install") || fail 'Could not check the installer download.'
    [ "$actual" = "$sha" ] || fail 'The installer checksum does not match. Run the install command again.'
    chmod +x "$tmp/hexbot-install"
    # Keep the bootstrap alive to clean up its temporary executable after it exits.
    # The child exec preserves argument boundaries and reads prompts from the terminal.
    status=0
    if ( : </dev/tty ) 2>/dev/null; then
        (exec "$tmp/hexbot-install" "$@" </dev/tty) || status=$?
    else
        (exec "$tmp/hexbot-install" "$@" </dev/null) || status=$?
    fi
    exit "$status"
}

main "$@"
