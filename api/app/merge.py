"""Three-way merge of document content, so a late save never throws away someone's work.

`merge(kind, base, theirs, ours)` combines two versions that both started from `base`:
`theirs` is what is stored now (an AI agent's or a teammate's change), `ours` is the save
that arrived late. Changes on different parts combine cleanly. When both changed the same
part, nothing is dropped:

- doc: blocks (paragraphs, headings, lists, tables, pictures) are diffed with difflib;
  a block both sides rewrote keeps both versions, ours first.
- sheet: cell by cell; rows both sides appended are all kept. A cell both sides set to
  different values takes ours, and the other value is reported.
- slides: matched by each slide's stable `id`; title and body merge separately, bodies
  line by line (both versions kept on a clash).

`base=None` (the base revision is no longer kept) falls back to keeping everything from
both sides that differs.
"""

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


def _merge_rows(base: list, theirs: list, ours: list, conflicts: list[str], label) -> list:
    """Index-aligned merge of a list whose items merge with `label`-reported clashes."""
    lb, lt, lo = len(base), len(theirs), len(ours)
    out = []
    for i in range(min(lb, max(lt, lo))):
        b = base[i]
        t = theirs[i] if i < lt else _MISSING
        o = ours[i] if i < lo else _MISSING
        if t is _MISSING and o is _MISSING:
            continue
        if t is _MISSING:  # theirs removed it: keep ours only if ours changed it
            if o != b:
                out.append(o)
            continue
        if o is _MISSING:
            if t != b:
                out.append(t)
            continue
        out.append(label(i, b, t, o))
    # Items appended past the base: both sides' additions are kept, ours first.
    out += ours[lb:] + theirs[lb:]
    return out


def merge_sheet(base: dict | None, theirs: dict, ours: dict) -> MergeResult:
    if base is None:
        base = theirs  # no shared history: ours wins where they differ, which is reported
    conflicts: list[str] = []

    def column(i: int, b: Any, t: Any, o: Any) -> Any:
        value, clash = _pick(b, t, o)
        if clash:
            conflicts.append(f"Column {_column_name(i)} header: kept {o!r} over {t!r}")
        return value

    columns = _merge_rows(base.get("columns", []), theirs.get("columns", []), ours.get("columns", []), conflicts, column)
    width = len(columns)

    def row(r: int, b: list, t: list, o: list) -> list:
        cells = []
        for c in range(max(len(b), len(t), len(o), width)):
            bv = b[c] if c < len(b) else None
            tv = t[c] if c < len(t) else None
            ov = o[c] if c < len(o) else None
            value, clash = _pick(bv, tv, ov)
            if clash:
                conflicts.append(f"{_column_name(c)}{r + 1}: kept {ov!r} over {tv!r}")
            cells.append(value)
        return cells

    rows = _merge_rows(base.get("rows", []), theirs.get("rows", []), ours.get("rows", []), conflicts, row)
    rows = [(list(r) + [None] * width)[:width] for r in rows]
    return MergeResult({"columns": columns, "rows": rows}, conflicts)


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

    # Order: ours, unless only theirs reordered; slides theirs added go after their predecessor.
    b_order, t_order, o_order = [s["id"] for s in b_list], [s["id"] for s in t_list], [s["id"] for s in o_list]
    common = [i for i in b_order if i in t_by and i in o_by]
    reordered_t = [i for i in t_order if i in common] != common
    reordered_o = [i for i in o_order if i in common] != common
    order = list(t_order if reordered_t and not reordered_o else o_order)
    for sid in t_order:
        if sid not in order and sid not in b_by:
            before = t_order[: t_order.index(sid)]
            anchor = max((order.index(x) for x in before if x in order), default=-1)
            order.insert(anchor + 1, sid)
    for sid in t_order:  # removed by ours but edited by theirs: keep where theirs had it
        if sid not in order and sid in b_by and t_by[sid] != b_by[sid]:
            order.append(sid)
    slides = [s for s in (merged(sid) for sid in order) if s is not None]
    return MergeResult({"slides": slides or [{"id": new_slide_id(), "title": "", "body": ""}]}, conflicts)


def merge(kind: DocKind, base: dict | None, theirs: dict, ours: dict) -> MergeResult:
    if kind is DocKind.doc:
        return merge_doc(base, theirs, ours)
    if kind is DocKind.sheet:
        return merge_sheet(base, theirs, ours)
    return merge_slides(base, theirs, ours)
