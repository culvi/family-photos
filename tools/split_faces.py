"""Split two people Immich has merged into one, using its own face fingerprints.

Immich sometimes files two look-alikes (siblings, usually) under one name once they grow
up. This sorts every face of person A taken since a date into "really A" or "really B",
from what's already known: B's own tagged faces, A's faces from before the mix-up, and a
few photos you've checked by eye. It labels the clearest faces first, then uses those to
settle the next ones (so a teenage B is matched through B's teenage photos, not B at 6).
Two faces of A in the same photo can't both be A: the more B-like one goes to B.

It only reads a CSV export and writes a plan (CSV + SQL to apply it + SQL to undo it).
Nothing in Immich changes until you run the apply SQL yourself.

Input CSV columns (no header): face_id, asset_id, person_group_id, taken (ISO), x1, embedding
where embedding is pgvector text "[0.1,0.2,...]".
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict

import numpy as np

K = 3  # neighbours averaged for a score
BATCH = 0.15  # share of the remaining faces labelled per round (most confident first)
MIN_MARGIN = 0.04  # closer to one side than the other by at least this, or it's "unsure"
MIN_SIM = 0.35  # and at least this similar to its side at all


def load(path):
    rows = []
    with open(path, newline="") as handle:
        for face_id, asset_id, group, taken, x1, emb in csv.reader(handle):
            rows.append((face_id, asset_id, group, taken[:10], float(x1 or 0), json.loads(emb)))
    return rows


def topk_mean(sims: np.ndarray, k: int = K) -> np.ndarray:
    if sims.shape[1] == 0:
        return np.full(sims.shape[0], -1.0)
    k = min(k, sims.shape[1])
    part = np.partition(sims, -k, axis=1)[:, -k:]
    return part.mean(axis=1)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--a", required=True, help="person group id now holding both (keeps the real A)")
    ap.add_argument("--b", required=True, help="person group id to move B's faces to")
    ap.add_argument("--since", required=True, help="YYYY-MM-DD: A's faces before this are trusted as A")
    ap.add_argument("--seed-a", default="", help="asset ids where A's tagged face really is A")
    ap.add_argument("--seed-b", default="", help="asset ids where A's tagged face is really B")
    ap.add_argument("--out", default="split")
    args = ap.parse_args(argv)

    rows = load(args.csv)
    ids = [r[0] for r in rows]
    asset = [r[1] for r in rows]
    group = [r[2] for r in rows]
    taken = [r[3] for r in rows]
    x1 = [r[4] for r in rows]
    emb = np.array([r[5] for r in rows], dtype=np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9
    n = len(rows)

    label = [None] * n  # "A" | "B"
    fixed = [False] * n
    open_idx = []
    for i in range(n):
        if group[i] == args.b:
            label[i], fixed[i] = "B", True
        elif taken[i] < args.since:
            label[i], fixed[i] = "A", True
        else:
            open_idx.append(i)

    sims_all = emb @ emb.T

    # Seeds: in each checked photo, the A-tagged face (the most fitting one if there are two).
    by_asset = defaultdict(list)
    for i in open_idx:
        by_asset[asset[i]].append(i)
    seeds = {"A": [s for s in args.seed_a.split(",") if s], "B": [s for s in args.seed_b.split(",") if s]}
    for side, assets in seeds.items():
        for a in assets:
            faces = by_asset.get(a, [])
            if not faces:
                print(f"  note: no open '{side}' seed face in asset {a}", file=sys.stderr)
                continue
            ref = [j for j in range(n) if label[j] == side]
            best = max(faces, key=lambda i: topk_mean(sims_all[[i]][:, ref])[0]) if ref else faces[0]
            label[best], fixed[best] = side, True
            open_idx = [i for i in open_idx if i != best]

    # Label in rounds, most confident first.
    while open_idx:
        a_ref = [j for j in range(n) if label[j] == "A"]
        b_ref = [j for j in range(n) if label[j] == "B"]
        sub = sims_all[open_idx]
        sa = topk_mean(sub[:, a_ref])
        sb = topk_mean(sub[:, b_ref])
        margin = sb - sa
        confident = [
            (abs(m), k)
            for k, m in enumerate(margin)
            if abs(m) >= MIN_MARGIN and max(sa[k], sb[k]) >= MIN_SIM
        ]
        if not confident:
            break
        confident.sort(reverse=True)
        take = confident[: max(1, int(len(open_idx) * BATCH))]
        chosen = set()
        for _, k in take:
            i = open_idx[k]
            label[i] = "B" if margin[k] > 0 else "A"
            chosen.add(i)
        open_idx = [i for i in open_idx if i not in chosen]

    for i in open_idx:
        label[i] = "unsure"

    # Same photo, two faces: only one can be A.
    a_ref = [j for j in range(n) if label[j] == "A" and fixed[j]]
    b_ref = [j for j in range(n) if label[j] == "B" and fixed[j]]
    for faces in by_asset.values():
        as_a = [i for i in faces if label[i] == "A"]
        if len(as_a) > 1:
            lean_b = max(as_a, key=lambda i: topk_mean(sims_all[[i]][:, b_ref])[0] - topk_mean(sims_all[[i]][:, a_ref])[0])
            label[lean_b] = "B"

    # Final scores for the report
    a_ref = [j for j in range(n) if label[j] == "A"]
    b_ref = [j for j in range(n) if label[j] == "B"]
    plan = []
    for i in range(n):
        if group[i] != args.a or taken[i] < args.since:
            continue
        others_a = [j for j in a_ref if j != i]
        others_b = [j for j in b_ref if j != i]
        sa = float(topk_mean(sims_all[[i]][:, others_a])[0])
        sb = float(topk_mean(sims_all[[i]][:, others_b])[0])
        plan.append((ids[i], asset[i], taken[i], label[i], round(sa, 3), round(sb, 3), round(sb - sa, 3)))

    moves = [p for p in plan if p[3] == "B"]
    stays = [p for p in plan if p[3] == "A"]
    unsure = [p for p in plan if p[3] == "unsure"]

    with open(f"{args.out}-plan.csv", "w", newline="") as handle:
        w = csv.writer(handle)
        w.writerow(["face_id", "asset_id", "taken", "decision", "like_a", "like_b", "margin"])
        w.writerows(sorted(plan, key=lambda p: p[2]))

    face_list = ",".join(f"'{p[0]}'" for p in moves) or "NULL"
    with open(f"{args.out}-apply.sql", "w") as handle:
        handle.write(
            "BEGIN;\n"
            "CREATE TABLE IF NOT EXISTS face_split_backup AS\n"
            '  SELECT id, "personGroupId", now() AS saved_at FROM asset_face WHERE false;\n'
            'INSERT INTO face_split_backup SELECT id, "personGroupId", now() FROM asset_face\n'
            f"  WHERE id IN ({face_list});\n"
            f"UPDATE asset_face SET \"personGroupId\" = '{args.b}'\n"
            f"  WHERE id IN ({face_list}) AND \"personGroupId\" = '{args.a}';\n"
            "COMMIT;\n"
        )
    with open(f"{args.out}-undo.sql", "w") as handle:
        handle.write(
            "BEGIN;\n"
            'UPDATE asset_face f SET "personGroupId" = b."personGroupId"\n'
            "  FROM face_split_backup b WHERE b.id = f.id;\n"
            "COMMIT;\n"
        )

    years = defaultdict(lambda: [0, 0, 0])
    for p in plan:
        years[p[2][:4]][{"B": 0, "A": 1, "unsure": 2}[p[3]]] += 1
    print(f"\nFaces of A since {args.since}: {len(plan)}  ->  move to B: {len(moves)} | stay A: {len(stays)} | unsure (stay A): {len(unsure)}")
    print("year  to_B  stay_A  unsure")
    for y in sorted(years):
        b, a, u = years[y]
        print(f"{y}  {b:5d}  {a:6d}  {u:6d}")

    def links(items, title):
        print(f"\n{title}")
        for p in items:
            print(f"  {p[2]}  margin {p[6]:+.3f}  https://neville.photos/photos/{p[1]}")

    links(sorted(moves, key=lambda p: p[6])[:8], "Closest calls moving to B (check these):")
    links(sorted(stays, key=lambda p: -p[6])[:8], "Closest calls staying A (check these):")
    if unsure:
        links(sorted(unsure, key=lambda p: -abs(p[6]))[:6], "Unsure (left as A):")
    print(f"\nWrote {args.out}-plan.csv, {args.out}-apply.sql, {args.out}-undo.sql")


if __name__ == "__main__":
    main()
