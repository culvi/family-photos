"""Give camera photos without GPS the location of phone photos taken around the same time.

For each target photo (no GPS, in the chosen folder) it finds the GPS photos taken just
before and just after it. If both are within --max-minutes, the location is interpolated
between them by time; if only one is, that one is used; otherwise the photo is left alone.

Default is a preview: prints a summary and writes <out>-plan.csv. With --apply it sets
each location through Immich's API, so Immich also writes it to the photo's .xmp sidecar
and looks up the city. Run with the viewer's .env (IMMICH_URL, IMMICH_API_KEY); the key
needs the asset.update permission.

Input CSV (no header): asset_id, original_path, taken_utc (ISO), latitude, longitude
"""

from __future__ import annotations

import argparse
import bisect
import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone


def parse_time(text: str) -> float:
    text = text.strip().replace(" ", "T")
    if text.endswith("+00"):
        text += ":00"
    return datetime.fromisoformat(text).timestamp()


def env(name: str) -> str:
    return os.environ.get(name, "").strip().strip('"').strip("'")


def plan(rows, folder: str, max_minutes: float):
    gps, targets = [], []
    for asset_id, path, taken, lat, lon in rows:
        t = parse_time(taken)
        if lat and lon:
            if folder not in path:
                gps.append((t, float(lat), float(lon), asset_id))
        elif folder in path:
            targets.append((t, asset_id, path))
    gps.sort()
    times = [g[0] for g in gps]
    limit = max_minutes * 60
    out = []
    for t, asset_id, path in sorted(targets):
        i = bisect.bisect_left(times, t)
        before = gps[i - 1] if i > 0 and t - gps[i - 1][0] <= limit else None
        after = gps[i] if i < len(gps) and gps[i][0] - t <= limit else None
        if before and after and after[0] > before[0]:
            w = (t - before[0]) / (after[0] - before[0])
            lat = before[1] + (after[1] - before[1]) * w
            lon = before[2] + (after[2] - before[2]) * w
            gap = min(t - before[0], after[0] - t)
            how = "between"
        elif before or after:
            src = before or after
            lat, lon, gap, how = src[1], src[2], abs(t - src[0]), "nearest"
        else:
            out.append((asset_id, path, t, None, None, None, "no match"))
            continue
        out.append((asset_id, path, t, round(lat, 6), round(lon, 6), round(gap / 60, 1), how))
    return out, len(gps)


def sessions(rows, folder: str, gap_minutes: float):
    """Group the camera photos into outings and suggest one place per outing."""
    gps, targets = [], []
    for asset_id, path, taken, lat, lon in rows:
        t = parse_time(taken)
        if lat and lon and folder not in path:
            gps.append((t, float(lat), float(lon)))
        elif not (lat and lon) and folder in path:
            targets.append((t, asset_id))
    gps.sort()
    targets.sort()
    groups = []
    for t, asset_id in targets:
        if not groups or t - groups[-1][-1][0] > gap_minutes * 60:
            groups.append([])
        groups[-1].append((t, asset_id))
    out = []
    for g in groups:
        start, end = g[0][0], g[-1][0]
        best = None
        for gt, lat, lon in gps:
            d = 0 if start <= gt <= end else min(abs(gt - start), abs(gt - end))
            if best is None or d < best[0]:
                best = (d, lat, lon)
        out.append((g, best))
    return out


def apply(items):
    base = env("IMMICH_URL").rstrip("/") or "http://127.0.0.1:2283"
    key = env("IMMICH_API_KEY")
    if not key:
        sys.exit("IMMICH_API_KEY is not set (run with --env-file .env)")
    done = 0
    for asset_id, _path, _t, lat, lon, _gap, _how in items:
        body = json.dumps({"ids": [asset_id], "latitude": lat, "longitude": lon}).encode()
        req = urllib.request.Request(
            f"{base}/api/assets",
            data=body,
            method="PUT",
            headers={"x-api-key": key, "content-type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                sys.exit(
                    f"\nImmich refused the change ({exc.code}). The API key needs the 'asset.update' "
                    "permission: make a key with it in Immich (Account Settings → API Keys) and run "
                    "again with IMMICH_API_KEY set to it."
                )
            print(f"  {asset_id}: failed ({exc.code})", file=sys.stderr)
            continue
        except urllib.error.URLError as exc:
            sys.exit(f"\nCan't reach Immich at {base} ({exc.reason}). Run with --network host --env-file .env.")
        done += 1
    return done


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--folder", required=True, help="part of the path that marks the camera photos, e.g. '/2026-04 Japan/'")
    ap.add_argument("--max-minutes", type=float, default=30)
    ap.add_argument("--out", default="geo")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--outings", action="store_true", help="group photos into outings and suggest a place for each")
    ap.add_argument("--outing-gap", type=float, default=45, help="minutes without photos that start a new outing")
    ap.add_argument("--tz-hours", type=float, default=0, help="show times in this UTC offset (Japan = 9)")
    ap.add_argument("--accept", default="", help="outing numbers to set to their suggested place, e.g. 1,2,5")
    args = ap.parse_args(argv)

    with open(args.csv, newline="") as handle:
        rows = [r[:5] for r in csv.reader(handle)]

    if args.outings:
        groups = sessions(rows, args.folder, args.outing_gap)
        shift = args.tz_hours * 3600
        fmt = lambda t: datetime.fromtimestamp(t + shift, timezone.utc).strftime("%a %b %d %H:%M")
        print(f"\n{len(groups)} outings (times at UTC{args.tz_hours:+g}):\n")
        for n, (g, best) in enumerate(groups, 1):
            start, end = g[0][0], g[-1][0]
            line = f"{n:3d}. {fmt(start)}-{fmt(end)[-5:]}  {len(g):3d} photos  https://neville.photos/photos/{g[0][1]}"
            if best:
                h = best[0] / 3600
                when = "during" if best[0] == 0 else (f"{best[0] / 60:.0f} min away" if h < 1 else f"{h:.1f} h away")
                line += f"\n      phone GPS {when}: https://maps.google.com/?q={best[1]:.5f},{best[2]:.5f}"
            print(line)
        picked = {int(x) for x in args.accept.split(",") if x.strip()}
        if picked:
            items = []
            for n, (g, best) in enumerate(groups, 1):
                if n in picked and best:
                    items += [(a, "", t, best[1], best[2], 0, "outing") for t, a in g]
            print(f"\nSetting {len(items)} locations from outings {sorted(picked)}...")
            print(f"Done: {apply(items)} updated.")
        else:
            print("\nPreview only. To set some: --accept 1,2,5 (outing numbers).")
        return
    items, n_gps = plan(rows, args.folder, args.max_minutes)
    matched = [i for i in items if i[3] is not None]

    with open(f"{args.out}-plan.csv", "w", newline="") as handle:
        w = csv.writer(handle)
        w.writerow(["asset_id", "path", "taken_utc", "latitude", "longitude", "gap_minutes", "how"])
        for a, p, t, lat, lon, gap, how in items:
            w.writerow([a, p, datetime.fromtimestamp(t, timezone.utc).isoformat(), lat, lon, gap, how])

    print(f"\nGPS photos to borrow from: {n_gps}")
    print(f"Photos without location in that folder: {len(items)}")
    print(f"  can place: {len(matched)}   ({sum(1 for i in matched if i[6] == 'between')} between two phone photos)")
    print(f"  no phone photo within {args.max_minutes:g} min: {len(items) - len(matched)}")
    days = {}
    for a, p, t, lat, lon, gap, how in items:
        d = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
        days.setdefault(d, [0, 0])[0 if lat is not None else 1] += 1
    print("\nday (UTC)    placed  not")
    for d in sorted(days):
        print(f"{d}   {days[d][0]:6d}  {days[d][1]:4d}")
    print("\nSpot-check a few (open in Immich, compare with the map link):")
    step = max(1, len(matched) // 6)
    for a, p, t, lat, lon, gap, how in matched[::step][:6]:
        print(f"  https://neville.photos/photos/{a}  ->  https://maps.google.com/?q={lat},{lon}  ({how}, {gap} min)")
    print(f"\nWrote {args.out}-plan.csv")

    if args.apply:
        print(f"\nSetting {len(matched)} locations in Immich...")
        print(f"Done: {apply(matched)} updated.")
    else:
        print("Preview only. Add --apply to set them.")


if __name__ == "__main__":
    main()
