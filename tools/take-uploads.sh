#!/usr/bin/env bash
# Take photos uploaded with the Immich phone app out of Immich and into the media Inbox,
# so they go through Lightroom like a camera card. Then moves them to Immich's Trash.
#
#   take-uploads            uploads from the last day
#   take-uploads 3          uploads from the last 3 days
#
# Uses the admin key in ~/.immich-admin-key (asset.delete); asks for one if that file is missing.
set -euo pipefail

#   take-uploads --trash-only 2  skip the copy; just move the last 2 days of uploads to Trash
TRASH_ONLY=""
[ "${1:-}" = "--trash-only" ] && { TRASH_ONLY=1; shift; }
DAYS="${1:-1}"
INBOX="${INBOX:-/mnt/Media-Storage/Inbox/iPhone}"
DB=(docker exec -i immich_postgres psql -U postgres -d immich -At -F $'\t')
WHERE="\"libraryId\" IS NULL AND \"deletedAt\" IS NULL AND \"createdAt\" > now() - interval '$DAYS days'"
# Live Photos upload a hidden video next to the still; leave those out of the copy.
NOT_MOTION="id NOT IN (SELECT \"livePhotoVideoId\" FROM asset WHERE \"livePhotoVideoId\" IS NOT NULL)"

mkdir -p "$INBOX"
mapfile -t ROWS < <("${DB[@]}" -c "SELECT id, \"originalPath\", \"originalFileName\", to_char(\"localDateTime\",'YYYY-MM') FROM asset WHERE $WHERE AND $NOT_MOTION ORDER BY \"fileCreatedAt\";")
if [ "${#ROWS[@]}" -eq 0 ]; then
  echo "No phone-app uploads in the last $DAYS day(s)."
  exit
fi

if [ -n "$TRASH_ONLY" ]; then
  printf '%s\n' "${ROWS[@]}" | cut -f4 | sort | uniq -c
  echo "${#ROWS[@]} uploads above (by month taken) will NOT be copied."
else
echo "Copying ${#ROWS[@]} photos/videos into $INBOX ..."
copied=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r id path name month <<<"$row"
  # One subfolder per month taken, so each trip lands in its own folder.
  mkdir -p "$INBOX/$month"
  dest="$INBOX/$month/$name"
  [ -e "$dest" ] && dest="$INBOX/$month/${id:0:8}-$name"
  docker cp "immich_server:$path" "$dest" && copied=$((copied + 1))
done
echo "Copied $copied of ${#ROWS[@]}, by month taken:"
printf '%s\n' "${ROWS[@]}" | cut -f4 | sort | uniq -c
if [ "$copied" -ne "${#ROWS[@]}" ]; then
  echo "Not all copied, so nothing was removed from Immich. Check the errors above."
  exit 1
fi
fi

read -r -p "Move them to Immich's Trash now? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left them in Immich."; exit; }
set -a; . "$(dirname "$(readlink -f "$0")")/../.env"; set +a
if [ -s "$HOME/.immich-admin-key" ]; then
  KEY="$(cat "$HOME/.immich-admin-key")"
else
  read -r -s -p "Immich API key with asset.delete: " KEY; echo
fi
IDS=$("${DB[@]}" -c "SELECT string_agg('\"'||id||'\"', ',') FROM asset WHERE $WHERE;")
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$IMMICH_URL/api/assets" \
  -H "x-api-key: $KEY" -H "content-type: application/json" -d "{\"ids\":[$IDS]}")
if [ "$code" = "204" ]; then
  echo "Done: in Immich's Trash. Empty it there."
else
  echo "Immich said $code; nothing removed. The files are safe in the Inbox either way."
fi
echo "Next: Lightroom → Import → Media-Storage → Inbox → iPhone → <month folder> → Move, with your preset."
