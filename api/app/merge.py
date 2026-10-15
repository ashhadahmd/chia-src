"""Three-way merge of document content, so a late save never throws away someone's work.

`merge(kind, base, theirs, ours)` combines two versions that both started from `base`:
`theirs` is what is stored now (an AI agent's or a teammate's change), `ours` is the save
that arrived late. Changes on different parts combine cleanly. When both changed the same
part, nothing is dropped:

- doc: blocks (paragraphs, headings, lists, tables, pictures) are diffed with difflib;
  a block both sides rewrote keeps both versions, ours first.
- sheet: rows are matched by their stable `row_ids`, so rows inserted or deleted in the
  middle on one side don't shift the other side's edits; then cell by cell. Rows either side
  added are all kept. A cell both sides set to different values takes ours, and the other
  value is reported. Columns are matched by position.
- slides: matched by each slide's stable `id`; title and body merge separately, bodies
  line by line (both versions kept on a clash).

`base=None` (the base revision is no longer kept) falls back to keeping everything from
both sides that differs.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from html.parser import HTMLParser
from itertools import pairwise
from secrets import token_hex
from typing import Any

from app.models import DocKind

_MISSING = object()


@dataclass
class MergeResult:
    content: dict[str, Any]
    conflicts: list[str] = field(default_factory=list)  # human-readable notes on clashes


def _pick(base: Any, theirs: Any, ours: Any) -> tuple[Any, bool]:
    """Scalar three-way pick. Returns (value, clashed); a clash takes ours."""
    if theirs == ours or theirs == base:
        return ours, False
    if ours == base:
        return theirs, False
    return ours, True


# ───────────── Sequences (doc blocks, slide body lines) ─────────────


def _matches(a: list[str], b: list[str]) -> dict[int, int]:
    matcher = SequenceMatcher(None, a, b, autojunk=False)
    return {m.a + k: m.b + k for m in matcher.get_matching_blocks() for k in range(m.size)}


def merge_sequence(base: list[str], theirs: list[str], ours: list[str]) -> tuple[list[str], int]:
    """diff3 over lists of strings. Regions only one side changed take that side; regions both
    changed differently keep ours followed by whatever of theirs isn't already in ours."""
    to_theirs, to_ours = _matches(base, theirs), _matches(base, ours)
    out: list[str] = []
    clashes = 0
    b0 = t0 = o0 = 0
    # Base items unchanged on both sides anchor the merge; regions between anchors are resolved.
    anchors = [i for i in range(len(base)) if i in to_theirs and i in to_ours]
    for i in [*anchors, None]:
        b1, t1, o1 = (len(base), len(theirs), len(ours)) if i is None else (i, to_theirs[i], to_ours[i])
        if t1 < t0 or o1 < o0:  # crossing matches (moved blocks): let the next anchor take it
            continue
        b, t, o = base[b0:b1], theirs[t0:t1], ours[o0:o1]
        if t == o or t == b:
            out += o
        elif o == b:
            out += t
        else:
            clashes += 1
            out += o + [x for x in t if x not in o]
        if i is not None:
            out.append(base[i])
            b0, t0, o0 = b1 + 1, t1 + 1, o1 + 1
    return out, clashes


def _two_way(theirs: list[str], ours: list[str]) -> tuple[list[str], int]:
    """No common base: ours, plus anything of theirs ours lacks, at its place in theirs."""
    out, clashes, anchor = list(ours), 0, 0
    present = set(ours)
    for item in theirs:
        if item in present:
            anchor = out.index(item) + 1
        else:
            out.insert(anchor, item)
            anchor += 1
            clashes = 1
    return out, clashes


# ───────────── Docs ─────────────

_VOID = {"img", "br", "hr", "input", "meta", "link", "source", "wbr", "col"}


class _Blocks(HTMLParser):
    """Splits editor HTML into its top-level elements, keeping each element's exact text."""

    def __init__(self, html: str) -> None:
        super().__init__(convert_charrefs=False)
        self.html = html
        self.lines = [0]  # offset where each line starts (HTMLParser counts lines by "\n" only)
        for line in html.split("\n"):
            self.lines.append(self.lines[-1] + len(line) + 1)
        self.depth = 0
        self.start = 0
        self.cut: list[int] = [0]

    def _at(self) -> int:
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if self.depth == 0:
            self._boundary(self._at())
        if tag not in _VOID:
            self.depth += 1
        elif self.depth == 0:
            self._boundary(self._at() + len(self.get_starttag_text() or ""))

    def handle_startendtag(self, tag: str, attrs: Any) -> None:
        if self.depth == 0:
            self._boundary(self._at())
            self._boundary(self._at() + len(self.get_starttag_text() or ""))

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID or self.depth == 0:
            return
        self.depth -= 1
        if self.depth == 0:
            self._boundary(self.html.index(">", self._at()) + 1)

    def _boundary(self, at: int) -> None:
        if at > self.cut[-1]:
            self.cut.append(at)

    def blocks(self) -> list[str]:
        self.feed(self.html)
        self.close()
        cuts = [*self.cut, len(self.html)]
        parts = [self.html[a:b] for a, b in pairwise(cuts)]
        return [p for p in (p.strip() for p in parts) if p]


def split_blocks(html: str) -> list[str]:
    return _Blocks(html).blocks() if html.strip() else []


def merge_doc(base: dict | None, theirs: dict, ours: dict) -> MergeResult:
    t, o = split_blocks(theirs.get("html", "")), split_blocks(ours.get("html", ""))
    if base is None:
        blocks, clashes = _two_way(t, o)
        page = ours.get("page", "letter")
    else:
        blocks, clashes = merge_sequence(split_blocks(base.get("html", "")), t, o)
        page, _ = _pick(base.get("page"), theirs.get("page"), ours.get("page"))
    notes = [f"Kept both versions of {clashes} passage{'s' if clashes != 1 else ''} changed on both sides"] if clashes else []
    return MergeResult({"html": "".join(blocks), "page": page or "letter"}, notes)


# ───────────── Sheets ─────────────


def _column_name(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _merge_columns(base: list, theirs: list, ours: list, conflicts: list[str]) -> list:
    """Position-aligned merge of column headers."""
    lb, lt, lo = len(base), len(theirs), len(ours)
    out = []
    for i in range(min(lb, max(lt, lo))):
        b = base[i]
        t = theirs[i] if i < lt else _MISSING
        o = ours[i] if i < lo else _MISSING
        if t is _MISSING and o is _MISSING:
            continue
        if t is _MISSING or o is _MISSING:  # removed on one side: keep only if the other changed it
            survivor = o if t is _MISSING else t
            if survivor != b:
                out.append(survivor)
            continue
        value, clash = _pick(b, t, o)
        if clash:
            conflicts.append(f"Column {_column_name(i)} header: kept {o!r} over {t!r}")
        out.append(value)
    # Columns added past the base: both sides' additions are kept, ours first.
    return out + ours[lb:] + theirs[lb:]


def new_row_id() -> str:
    return token_hex(4)


def with_row_ids(count: int, ids: list | None) -> list[str]:
    """One stable, unique id per row. Sheets saved before row ids existed get positional ids
    (r0, r1, ...), the same on every read, so their stored revisions still line up."""
    if ids is None:
        return [f"r{i}" for i in range(count)]
    seen: set[str] = set()
    out = []
    for i in range(count):
        rid = ids[i] if i < len(ids) and isinstance(ids[i], str) and ids[i] else None
        if rid is None or rid in seen:
            rid = new_row_id()
        seen.add(rid)
        out.append(rid)
    return out


def _keyed(content: dict, key: str) -> tuple[list[str], dict[str, list]]:
    rows = content.get("rows", [])
    ids = with_row_ids(len(rows), content.get(key))
    return ids, dict(zip(ids, rows, strict=True))


def merge_sheet(base: dict | None, theirs: dict, ours: dict) -> MergeResult:
    if base is None:
        base = theirs  # no shared history: ours wins where they differ, which is reported
    conflicts: list[str] = []
    columns = _merge_columns(base.get("columns", []), theirs.get("columns", []), ours.get("columns", []), conflicts)
    width = len(columns)
    (b_ids, b_by), (t_ids, t_by), (o_ids, o_by) = (_keyed(x, "row_ids") for x in (base, theirs, ours))

    def cells(label: int, b: list, t: list, o: list) -> list:
        out = []
        for c in range(max(len(b), len(t), len(o), width)):
            bv = b[c] if c < len(b) else None
            tv = t[c] if c < len(t) else None
            ov = o[c] if c < len(o) else None
            value, clash = _pick(bv, tv, ov)
            if clash:
                conflicts.append(f"{_column_name(c)}{label}: kept {ov!r} over {tv!r}")
            out.append(value)
        return out

    def merged(rid: str) -> list | None:
        b, t, o = b_by.get(rid), t_by.get(rid), o_by.get(rid)
        if b is None:  # added on one side (ids are unique, so never both)
            return o if o is not None else t
        if t is None or o is None:  # deleted on one side: keep only if the other changed it
            survivor = o if t is None else t
            return survivor if survivor != b else None
        return cells(o_ids.index(rid) + 1, b, t, o)

    order = merge_order(b_ids, t_ids, o_ids, lambda rid: t_by[rid] != b_by[rid], lambda rid: o_by[rid] != b_by[rid])
    kept = [(rid, row) for rid, row in ((rid, merged(rid)) for rid in order) if row is not None]
    rows = [(list(r) + [None] * width)[:width] for _, r in kept]
    return MergeResult({"columns": columns, "rows": rows, "row_ids": [rid for rid, _ in kept]}, conflicts)


# ───────────── Ordering of id-keyed items (sheet rows, slides) ─────────────


def merge_order(
    base: list[str],
    theirs: list[str],
    ours: list[str],
    theirs_changed: Callable[[str], bool],
    ours_changed: Callable[[str], bool],
) -> list[str]:
    """Order of the merged items, by id. Follows ours, unless only theirs reordered the items
    both kept. Items the other side has and the followed side lacks go after their predecessor:
    always when added, and when the followed side deleted them only if the other side changed
    them (whether a deleted-but-unchanged item really goes is up to the caller)."""
    base_set, theirs_set, ours_set = set(base), set(theirs), set(ours)
    common = [i for i in base if i in theirs_set and i in ours_set]
    reordered_t = [i for i in theirs if i in base_set and i in ours_set] != common
    reordered_o = [i for i in ours if i in base_set and i in theirs_set] != common
    if reordered_t and not reordered_o:
        order, other, other_changed = list(theirs), ours, ours_changed
    else:
        order, other, other_changed = list(ours), theirs, theirs_changed
    other_set = set(other)
    for idx, item in enumerate(other):
        if item in order or (item in base_set and not other_changed(item)):
            continue
        at = max((order.index(x) for x in other[:idx] if x in order), default=-1) + 1
        # Both sides inserted at the same spot: the followed side's new items come first.
        while at < len(order) and order[at] not in base_set and order[at] not in other_set:
            at += 1
        order.insert(at, item)
    return order


# ───────────── Slides ─────────────


def new_slide_id() -> str:
    return token_hex(4)


def with_ids(slides: list[dict]) -> list[dict]:
    """Give every slide a stable id (older content has none); ids stay unique."""
    seen: set[str] = set()
    out = []
    for s in slides:
        sid = s.get("id")
        if not sid or sid in seen:
            sid = new_slide_id()
        seen.add(sid)
        out.append({**s, "id": sid})
    return out


def merge_slides(base: dict | None, theirs: dict, ours: dict) -> MergeResult:
    t_list, o_list = with_ids(theirs.get("slides", [])), with_ids(ours.get("slides", []))
    b_list = with_ids(base.get("slides", [])) if base is not None else t_list
    b_by, t_by, o_by = ({s["id"]: s for s in xs} for xs in (b_list, t_list, o_list))
    conflicts: list[str] = []

    def merged(sid: str) -> dict | None:
        b, t, o = b_by.get(sid), t_by.get(sid), o_by.get(sid)
        if b is None:  # added on one side
            return o or t
        if t is None or o is None:  # removed on one side: keep only if the other changed it
            survivor = o if t is None else t
            return survivor if survivor != b else None
        title, clash = _pick(b.get("title", ""), t.get("title", ""), o.get("title", ""))
        if clash:
            conflicts.append(f"Slide “{o.get('title') or 'Untitled'}”: kept your title over {t.get('title')!r}")
        body_lines, body_clash = merge_sequence(
            b.get("body", "").split("\n"), t.get("body", "").split("\n"), o.get("body", "").split("\n")
        )
        if body_clash:
            conflicts.append(f"Slide “{title or 'Untitled'}”: kept both versions of changed lines")
        return {**b, **t, **o, "title": title, "body": "\n".join(body_lines)}

    order = merge_order(
        [s["id"] for s in b_list],
        [s["id"] for s in t_list],
        [s["id"] for s in o_list],
        lambda sid: t_by[sid] != b_by[sid],
        lambda sid: o_by[sid] != b_by[sid],
    )
    slides = [s for s in (merged(sid) for sid in order) if s is not None]
    return MergeResult({"slides": slides or [{"id": new_slide_id(), "title": "", "body": ""}]}, conflicts)


def merge(kind: DocKind, base: dict | None, theirs: dict, ours: dict) -> MergeResult:
    if kind is DocKind.doc:
        return merge_doc(base, theirs, ours)
    if kind is DocKind.sheet:
        return merge_sheet(base, theirs, ours)
    return merge_slides(base, theirs, ours)
