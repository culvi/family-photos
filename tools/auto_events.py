"""Plan for auto-events: decide where each downloaded phone photo goes and what it is called.

Input: an exiftool CSV dump of one album's download folder (-csv -DateTimeOriginal -CreateDate
-FileName). Output: plan.csv with SourceFile, Dest, Keywords; or a reason the album can't be placed.

Naming follows Lightroom's "Year-Month-Num-Event-WCN": 2025-03-5462-El-Salvador-WCN.HEIC
(number = the iPhone's IMG_#### number; event words joined with hyphens).
"""

from __future__ import annotations

import csv
import os
import re
import sys

PHOTOS = os.environ.get("PHOTOS", "/mnt/Media-Storage/Photos")


def event_parts(album: str):
    """'2025-3 El Salvador' -> ('2025', '3', 'El Salvador')."""
    m = re.match(r"^\s*(\d{4})-(\d{1,2})\s+(.+?)\s*$", album)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3)


def find_folder(album: str) -> str | None:
    """The existing event folder for an album, e.g. Photos/2025/2025-3 El Salvador (or 2025-03 ...)."""
    parts = event_parts(album)
    if not parts:
        return None
    year, month, name = parts
    root = os.path.join(PHOTOS, year)
    if not os.path.isdir(root):
        return None
    words = lambda t: set(re.findall(r"[a-z0-9]+", t.lower())) - {"and", "the", "of", "a"}
    want = words(name)
    hits = []
    for d in os.listdir(root):
        m = re.match(r"^(\d{4})-(\d{1,2})\s+(.+)$", d)
        if not m or int(m.group(2)) != int(month):
            continue
        have = words(m.group(3))
        if want <= have or have <= want:
            hits.append(d)
    return os.path.join(root, hits[0]) if len(hits) == 1 else None


def main(dump: str, album: str, out: str):
    folder = find_folder(album)
    if not folder:
        sys.exit(f"NOFOLDER: no single folder in {PHOTOS}/<year> matches '{album}'")
    year, month, name = event_parts(album)
    shoot = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")
    taken = set(os.listdir(folder))
    rows = list(csv.DictReader(open(dump)))
    plan, undated = [], []
    for r in rows:
        src = r["SourceFile"]
        stamp = (r.get("DateTimeOriginal") or r.get("CreateDate") or "").strip()
        m = re.match(r"^(\d{4}):(\d{2}):\d{2}", stamp)
        if not m or m.group(1) == "0000":
            undated.append(os.path.basename(src))
            continue
        base, ext = os.path.splitext(os.path.basename(src))
        num = re.sub(r"\D", "", base) or base
        new = f"{m.group(1)}-{m.group(2)}-{num}-{shoot}-WCN"
        cand, n = new + ext, 2
        while cand in taken:
            cand, n = f"{new}-{n}{ext}", n + 1
        taken.add(cand)
        plan.append([src, os.path.join(folder, cand), name])
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["SourceFile", "Dest", "Keywords"])
        w.writerows(plan)
    print(f"FOLDER\t{folder}")
    print(f"COUNT\t{len(plan)}")
    for u in undated:
        print(f"UNDATED\t{u}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
