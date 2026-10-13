"""Tap-to-fix review page for splitting two people Immich merged (Nadia / Nayleigh).

Shows every face of person A since a date as a cropped tile, grouped by the model's
guess (from split_faces.py's plan CSV, if given). Tap a tile to flip it to the other
person. Every tap is saved to <out>.json, and <out>-apply.sql / <out>-undo.sql are
rewritten, so you can stop and come back. Nothing changes in Immich until you run
the apply SQL yourself.

Standard library only. Photos come through this server from Immich (API key from the
viewer's .env), so the page works from any browser on the LAN.

Faces CSV (no header): face_id, asset_id, person_group_id, taken, x1, y1, x2, y2, image_w, image_h
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import secrets
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def env(name: str) -> str:
    return os.environ.get(name, "").strip().strip('"').strip("'")


def load_faces(path):
    faces = []
    with open(path, newline="") as handle:
        for row in csv.reader(handle):
            face_id, asset_id, group, taken, x1, y1, x2, y2, w, h = row[:10]
            emb = json.loads(row[10]) if len(row) > 10 and row[10] else None
            faces.append(
                {
                    "emb": emb,
                    "id": face_id,
                    "asset": asset_id,
                    "group": group,
                    "taken": taken[:10],
                    "box": [int(x1), int(y1), int(x2), int(y2)],
                    "size": [int(w) or 1, int(h) or 1],
                }
            )
    faces.sort(key=lambda f: (f["taken"], f["asset"], f["box"][0]))
    return faces


def guess_from_embeddings(faces, a, b, window_years=2.0, rounds=3):
    """Guess which of A's faces are really B, from Immich's face fingerprints.

    Score = how close a face is to B's own tagged faces minus how close it is to A's other
    faces (same era only). A's group is itself mixed, so it's refined a few rounds, each
    time leaving out the faces already guessed as B. Returns {face_id: score}.
    """
    import numpy as np

    idx = [i for i, f in enumerate(faces) if f["emb"] is not None]
    emb = np.array([faces[i]["emb"] for i in idx], dtype=np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9
    groups = np.array([faces[i]["group"] for i in idx])
    assets = np.array([faces[i]["asset"] for i in idx])
    years = np.array([int(faces[i]["taken"][:4]) + (int(faces[i]["taken"][5:7] or 1) - 1) / 12 for i in idx])
    sims = emb @ emb.T
    usable = (np.abs(years[:, None] - years[None, :]) <= window_years) & (assets[:, None] != assets[None, :])

    def top_mean(mask, k=3):
        s = np.where(mask, sims, -1.0)
        k = min(k, s.shape[1])
        return np.sort(s, axis=1)[:, -k:].mean(axis=1)

    is_b = groups == b
    is_a = groups == a
    # A's group may hold many of B's faces, and those vouch for each other. So compare
    # against A's least B-like faces only: each round drops the 40% most B-like.
    to_b = top_mean(usable & is_b[None, :])
    left_out = np.zeros(len(idx), dtype=bool)
    score = np.zeros(len(idx))
    for _ in range(rounds + 1):
        to_a = top_mean(usable & (is_a & ~left_out)[None, :])
        score = to_b - to_a
        if is_a.any():
            left_out = is_a & (score >= np.quantile(score[is_a], 0.6))
    return {faces[i]["id"]: float(score[k]) for k, i in enumerate(idx) if is_a[k]}


def load_plan(path):
    guesses = {}
    if not path:
        return guesses
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            guesses[row["face_id"]] = "B" if row["decision"] == "B" else "A"
    return guesses


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Face review</title>
<style>
:root{--bg:#111;--fg:#eee;--muted:#999;--a:#4c8dff;--b:#ff7a45;--card:#1d1d1d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:#111e;backdrop-filter:blur(8px);padding:10px 16px;border-bottom:1px solid #333;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
header b.a{color:var(--a)}header b.b{color:var(--b)}#saveState{color:var(--muted);margin-left:auto}
h2{margin:22px 16px 6px;font-size:17px}h2 small{color:var(--muted);font-weight:400}
h3{margin:14px 16px 6px;font-size:13px;color:var(--muted);font-weight:500}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:0 16px}
.tile{user-select:none;-webkit-user-select:none;position:relative;aspect-ratio:1;border-radius:10px;background:var(--card) no-repeat;border:3px solid transparent;cursor:pointer;overflow:hidden}
.tile.A{border-color:var(--a)}.tile.B{border-color:var(--b)}
.tile .who{position:absolute;left:0;right:0;bottom:0;padding:2px 4px;font-size:11px;font-weight:600;text-align:center;background:#000a}
.tile.A .who{color:var(--a)}.tile.B .who{color:var(--b)}
.tile.changed{box-shadow:0 0 0 3px #fff}
.tile a{position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:6px;background:#000a;color:#fff;text-decoration:none;font-size:13px;display:grid;place-items:center}
p.help{margin:8px 16px;color:var(--muted)}
</style></head><body>
<header><span>Tap a face to flip it.</span>
<span><b class="b">Nayleigh</b> <span id="nb">0</span></span>
<span><b class="a">Nadia</b> <span id="na">0</span></span>
<span>changed by you: <span id="nc">0</span></span>
<span id="saveState">saved</span></header>
<p class="help">Orange = Nayleigh, blue = Nadia. White ring = you changed it. ↗ opens the photo in Immich.<br>
Drag across faces to flip them all the same way. Shift-click flips everything since your last click.</p>
<div id="root"></div>
<script>
const KEY = new URLSearchParams(location.search).get('k');
const NAMES = {A: 'Nadia', B: 'Nayleigh'};
let faces = [], choice = {}, guess = {}, timer = 0;
const tiles = [];
let dragValue = null, lastIndex = -1;

function setTile(tile, value) {
  if (choice[tile.face.id] === value) return;
  choice[tile.face.id] = value;
  paint(tile, tile.face);
}

// Click flips one face; drag paints every face you pass with that new value;
// shift-click paints the whole run since the last click.
document.addEventListener('pointerdown', e => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('a') || e.button !== 0) return;
  const value = choice[tile.face.id] === 'A' ? 'B' : 'A';
  const index = tiles.indexOf(tile);
  if (e.shiftKey && lastIndex >= 0) {
    const [from, to] = [Math.min(lastIndex, index), Math.max(lastIndex, index)];
    for (let i = from; i <= to; i++) setTile(tiles[i], value);
  } else {
    setTile(tile, value);
    if (e.pointerType === 'mouse') dragValue = value;
  }
  lastIndex = index;
  counts(); save();
  e.preventDefault();
});
document.addEventListener('pointermove', e => {
  if (dragValue === null) return;
  const tile = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tile');
  if (tile) { setTile(tile, dragValue); lastIndex = tiles.indexOf(tile); counts(); }
});
document.addEventListener('pointerup', () => { if (dragValue !== null) { dragValue = null; save(); } });

function crop(f) {
  const [x1, y1, x2, y2] = f.box, [W, H] = f.size;
  const side = Math.max(x2 - x1, y2 - y1) * 1.5;
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const sw = Math.min(side / W, 1), sh = Math.min(side / H, 1);
  const left = Math.min(Math.max(cx / W - sw / 2, 0), 1 - sw);
  const top = Math.min(Math.max(cy / H - sh / 2, 0), 1 - sh);
  const px = sw >= 1 ? 0 : (left / (1 - sw)) * 100;
  const py = sh >= 1 ? 0 : (top / (1 - sh)) * 100;
  return `background-size:${100 / sw}% ${100 / sh}%;background-position:${px}% ${py}%`;
}

function paint(tile, f) {
  const c = choice[f.id];
  tile.className = `tile ${c}` + (c !== f.start ? ' changed' : '');
  tile.querySelector('.who').textContent = NAMES[c];
}

function counts() {
  const v = Object.values(choice);
  nb.textContent = v.filter(c => c === 'B').length;
  na.textContent = v.filter(c => c === 'A').length;
  nc.textContent = faces.filter(f => choice[f.id] !== f.start).length;
}

function save() {
  saveState.textContent = 'saving…';
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const changes = {};
    faces.forEach(f => { if (choice[f.id] !== f.start) changes[f.id] = choice[f.id]; });
    try {
      const r = await fetch(`save?k=${KEY}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(changes)});
      saveState.textContent = r.ok ? 'saved' : 'save failed';
    } catch { saveState.textContent = 'save failed'; }
  }, 400);
}

function section(title, list, byScore) {
  const h = document.createElement('h2');
  h.innerHTML = `${title} <small>(${list.length})</small>`;
  root.appendChild(h);
  let year = '', grid;
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const t = e.target; t.style.backgroundImage = `url("t/${t.dataset.asset}?k=${KEY}")`; io.unobserve(t);
  }), {rootMargin: '600px'});
  list.forEach((f, n) => {
    const label = byScore ? `${Math.floor(n / 100) * 100 + 1}+  (most like Nayleigh first)` : f.taken.slice(0, 4);
    if (label !== year) {
      year = label;
      const y = document.createElement('h3'); y.textContent = year; root.appendChild(y);
      grid = document.createElement('div'); grid.className = 'grid'; root.appendChild(grid);
    }
    const tile = document.createElement('div');
    tile.dataset.asset = f.asset;
    tile.style.cssText = crop(f);
    tile.innerHTML = `<span class="who"></span><a href="https://neville.photos/photos/${f.asset}" target="_blank" rel="noopener" title="Open in Immich">↗</a>`;
    tile.querySelector('a').addEventListener('click', e => e.stopPropagation());
    tile.face = f;
    tiles.push(tile);
    paint(tile, f);
    grid.appendChild(tile);
    io.observe(tile);
  });
}

(async () => {
  const d = await (await fetch(`data?k=${KEY}`)).json();
  faces = d.faces;
  faces.forEach(f => { f.start = d.guess[f.id] || 'A'; choice[f.id] = d.saved[f.id] || f.start; });
  section('Model thinks: Nayleigh', faces.filter(f => f.start === 'B'));
  const nadia = faces.filter(f => f.start === 'A');
  const ranked = nadia.some(f => f.score !== undefined);
  if (ranked) nadia.sort((x, y) => y.score - x.score);
  section('Model thinks: Nadia' + (ranked ? ' — most Nayleigh-like first; stop once it is all Nadia' : ''), nadia, ranked);
  counts();
})();
</script></body></html>
"""


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("faces_csv")
    ap.add_argument("--plan", default="", help="split_faces.py plan CSV with the model's guesses")
    ap.add_argument("--a", required=True, help="person group id holding the faces now (Nadia)")
    ap.add_argument("--b", required=True, help="person group id to move faces to (Nayleigh)")
    ap.add_argument("--since", default="", help="YYYY-MM-DD: only review A's faces from this date")
    ap.add_argument("--until", default="", help="YYYY-MM-DD: only review A's faces before this date")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--out", default="face-review")
    args = ap.parse_args(argv)

    every = load_faces(args.faces_csv)
    scores = {}
    guess = load_plan(args.plan)
    if not guess and any(f["emb"] is not None for f in every):
        print("Comparing faces...")
        scores = guess_from_embeddings(every, args.a, args.b)
        guess = {fid: "B" if s > 0 else "A" for fid, s in scores.items()}
    faces = [
        {k: v for k, v in f.items() if k != "emb"} | ({"score": round(scores[f["id"]], 4)} if f["id"] in scores else {})
        for f in every
        if f["group"] == args.a
        and (not args.since or f["taken"] >= args.since)
        and (not args.until or f["taken"] < args.until)
    ]
    by_id = {f["id"]: f for f in faces}
    table = "".join(c if c.isalnum() else "_" for c in args.out.lower()) + "_backup"
    state_path = Path(f"{args.out}.json")
    saved = json.loads(state_path.read_text()) if state_path.exists() else {}
    lock = threading.Lock()

    key = env("IMMICH_API_KEY")
    bases = [b.rstrip("/") for b in (env("IMMICH_URL"), "http://127.0.0.1:2283") if b]
    if not key:
        sys.exit("IMMICH_API_KEY is not set (run with --env-file .env)")
    cache = Path(f"{args.out}-cache")
    cache.mkdir(exist_ok=True)
    token = secrets.token_urlsafe(12)

    def write_sql(changes):
        final = {f["id"]: changes.get(f["id"], guess.get(f["id"], "A")) for f in faces}
        to_b = [fid for fid, c in final.items() if c == "B"]
        ids = ",".join(f"'{fid}'" for fid in to_b) or "NULL"
        Path(f"{args.out}-apply.sql").write_text(
            "BEGIN;\n"
            f"CREATE TABLE IF NOT EXISTS {table} AS\n"
            '  SELECT id, "personGroupId", now() AS saved_at FROM asset_face WHERE false;\n'
            f'INSERT INTO {table} SELECT id, "personGroupId", now() FROM asset_face\n'
            f"  WHERE id IN ({ids}) AND \"personGroupId\" = '{args.a}';\n"
            f"UPDATE asset_face SET \"personGroupId\" = '{args.b}'\n"
            f"  WHERE id IN ({ids}) AND \"personGroupId\" = '{args.a}';\n"
            "COMMIT;\n"
        )
        Path(f"{args.out}-undo.sql").write_text(
            "BEGIN;\n"
            'UPDATE asset_face f SET "personGroupId" = b."personGroupId"\n'
            f"  FROM {table} b WHERE b.id = f.id;\n"
            f"DROP TABLE {table};\n"
            "COMMIT;\n"
        )
        return len(to_b)

    def thumb(asset_id):
        path = cache / f"{asset_id}.jpg"
        if path.exists():
            return path.read_bytes()
        last = None
        for base in bases:
            try:
                req = urllib.request.Request(
                    f"{base}/api/assets/{asset_id}/thumbnail?size=preview", headers={"x-api-key": key}
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = resp.read()
                path.write_bytes(data)
                return data
            except Exception as exc:  # try the next address
                last = exc
        print(f"  could not load photo {asset_id}: {last}", file=sys.stderr)
        return None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b"", ctype="text/plain"):
            self.send_response(code)
            self.send_header("content-type", ctype)
            self.send_header("cache-control", "no-store" if ctype != "image/jpeg" else "max-age=86400")
            self.end_headers()
            self.wfile.write(body)

        def _ok(self):
            q = parse_qs(urlparse(self.path).query)
            return q.get("k", [""])[0] == token

        def do_GET(self):
            path = urlparse(self.path).path
            if not self._ok():
                return self._send(403, b"Use the link printed in the terminal.")
            if path == "/":
                return self._send(200, PAGE.encode(), "text/html; charset=utf-8")
            if path == "/data":
                with lock:
                    body = json.dumps({"faces": faces, "guess": guess, "saved": saved})
                return self._send(200, body.encode(), "application/json")
            if path.startswith("/t/"):
                asset_id = path[3:]
                if not all(c in "0123456789abcdef-" for c in asset_id) or len(asset_id) != 36:
                    return self._send(400)
                data = thumb(asset_id)
                return self._send(200, data, "image/jpeg") if data else self._send(502)
            self._send(404)

        def do_POST(self):
            if urlparse(self.path).path != "/save" or not self._ok():
                return self._send(403)
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            changes = {fid: c for fid, c in body.items() if fid in by_id and c in ("A", "B")}
            with lock:
                saved.clear()
                saved.update(changes)
                state_path.write_text(json.dumps(saved))
                write_sql(saved)
            self._send(200, b"ok")

    moving = write_sql(saved)
    host = env("REVIEW_HOST") or "10.69.1.10"
    print(f"{len(faces)} faces to review, {moving} set to move now.")
    print(f"\nOpen this on your Mac:  http://{host}:{args.port}/?k={token}\n")
    print("Your taps save as you go. Press Ctrl+C here when you're done.")
    try:
        ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        n = write_sql(saved)
        print(f"\nStopped. {len(saved)} faces changed by you; {n} faces will move to the second person.")
        print(f"Apply with:  {args.out}-apply.sql")


if __name__ == "__main__":
    main()
