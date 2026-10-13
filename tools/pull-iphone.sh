#!/usr/bin/env bash
# Pull one iPhone album from iCloud into the Inbox on the media drive, for a Lightroom import.
# Runs only when you call it; nothing keeps syncing.
#
#   pull-iphone "Japan 2026"     download that album
#   pull-iphone --list           show your iCloud album names
#
# First run asks for your Apple ID email (saved), password and 2FA code (not saved; iCloud
# keeps you signed in for a while, then asks for a new code).
# Needs on the iPhone: Advanced Data Protection off, "Access iCloud Data on the Web" on.
set -euo pipefail

CONF="$HOME/.icloudpd"
INBOX="${INBOX:-/mnt/Media-Storage/Inbox/iPhone}"
mkdir -p "$CONF" "$INBOX"

if [ ! -s "$CONF/username" ]; then
  read -rp "Apple ID email: " APPLE_ID
  echo "$APPLE_ID" > "$CONF/username"
fi
APPLE_ID="$(cat "$CONF/username")"

run() {
  docker run -it --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$INBOX:/data" -v "$CONF:/cookies" icloudpd/icloudpd:latest \
    icloudpd --directory /data --cookie-directory /cookies --username "$APPLE_ID" "$@"
}

if [ "${1:-}" = "--list" ]; then
  run --list-albums
  exit
fi

ALBUM="${1:?Usage: pull-iphone \"Album name\"   (or --list)}"
run --album "$ALBUM" --folder-structure none --skip-live-photos
echo
echo "Done: $(find "$INBOX" -maxdepth 1 -type f | wc -l) files in Inbox/iPhone."
echo "Next: Lightroom → Import → Media-Storage → Inbox → iPhone → Move, with your preset."
