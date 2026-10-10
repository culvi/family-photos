"""Cache-busting for the frontend's own JS and CSS.

The HTML pages are served with ``Cache-Control: no-cache`` and every local ``js/`` and
``css/`` reference in them gets ``?v=<content hash>``. A normal reload therefore always
picks up a new deploy, including on mobile browsers that have no hard refresh, and
including clients that cached an older copy of a script before this existed.

Both values are computed once per process: the files only change with a new image.
"""

from __future__ import annotations

import hashlib
import re
from functools import lru_cache
from pathlib import Path

# src="js/app.js" / href="css/styles.css" (relative, local, not already versioned)
_ASSET_REF = re.compile(r'(\b(?:src|href)=")((?:js|css)/[^"?#]+\.(?:js|css))(")')


@lru_cache(maxsize=None)
def asset_version(static_dir: Path) -> str:
    """Short hash of every file under js/ and css/: changes whenever any of them do."""
    digest = hashlib.sha256()
    for sub in ("js", "css"):
        folder = static_dir / sub
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                digest.update(str(path.relative_to(static_dir)).encode())
                digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


@lru_cache(maxsize=None)
def versioned_html(path: Path) -> str:
    """The HTML file with ``?v=<asset_version>`` appended to its local JS/CSS links."""
    version = asset_version(path.parent)
    html = path.read_text(encoding="utf-8")
    return _ASSET_REF.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", html)
