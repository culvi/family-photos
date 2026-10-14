#!/usr/bin/env bash
# Pull one iPhone album from iCloud into the Inbox on the media drive, for a Lightroom import.
# Runs only when you call it; nothing keeps syncing.
#
#   pull-iphone "Japan 2026"     download that album (several names = several albums)
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
    icloudpd --directory /data --cookie-directory /cookies --username "$APPLE_ID" --log-level info "$@"
}

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
  run --list-albums
  exit
fi

for ALBUM in "$@"; do
  # Each album gets its own folder in the Inbox, named like the album.
  mkdir -p "$INBOX/$ALBUM"
  # Apple sometimes answers "not finished indexing" on one call and works on the next; retry.
  for try in 1 2 3 4 5 6; do
    out=$(docker run -it --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$INBOX/$ALBUM:/data" -v "$CONF:/cookies" icloudpd/icloudpd:latest \
      icloudpd --directory /data --cookie-directory /cookies --username "$APPLE_ID" --log-level info \
      --album "$ALBUM" --folder-structure none --skip-live-photos 2>&1 | tee /dev/stderr)
    grep -q "not finished indexing" <<<"$out" || break
    echo "Apple not ready for this album yet; trying again in 30s ($try/6)"
    sleep 30
  done
  echo "Done: $(find "$INBOX/$ALBUM" -maxdepth 1 -type f | wc -l) files in Inbox/iPhone/$ALBUM"
done
echo "Next: Lightroom → Import → Media-Storage → Inbox → iPhone → <album folder> → Move, with your preset."
