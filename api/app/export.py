"""Render a Chia doc (editor HTML) to PDF or DOCX, a sheet to XLSX and slides to PPTX.

The editor emits a small, known subset of HTML: p, h1-h3, ul/ol/li, blockquote, hr, br,
strong/em/u/s/code, <span style="font-size; color">, `text-align` on blocks, tables
(with colspan/rowspan and column widths), images (<img data-width data-align>) and diagrams
(<figure data-type="diagram"> holding a rendered <img>). Both renderers understand exactly
that subset. Images are resolved from Chia's asset store; nothing is fetched from the web.
"""

import io
import re
from dataclasses import dataclass, field
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from docx import Document as DocxDocument
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.image.image import Image as DocxImage
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Mm, Pt, RGBColor
from weasyprint import HTML
from weasyprint.urls import URLFetcher

from app.assets import ASSET_SRC, Resolver, inline
from app.models import PageSize

FONT_DIR = (Path(__file__).parent / "assets" / "fonts").resolve()
HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}){1,2}$")
INK_LIGHT, INK_DARK = "#2C2C29", "#ECE7DC"
HEADER_FILL = "EDEDED"  # table header rows: light grey with black text

# Text colours are stored as `var(--tc-<name>, <light hex>)` so the editor can adapt them to
# its theme. PDF renders resolve them for the chosen page colour; Word/Google get the hex.
TEXT_COLORS = {
    "stone": ("#6F6E66", "#A9A69B"),
    "sage": ("#5A6B47", "#A3B68F"),
    "eucalyptus": ("#3F6E66", "#8BB5AC"),
    "terracotta": ("#B05A47", "#DC9A8A"),
    "ochre": ("#9A7424", "#D9B562"),
    "clay": ("#8C5A3C", "#C99A7C"),
    "plum": ("#7A4F72", "#C79BC0"),
    "slate": ("#4A5A6E", "#9DB0C6"),
}
_VAR_COLOR = re.compile(r"var\(--tc-[a-z]+,\s*(#[0-9a-fA-F]{6})\)")


def resolve_colors(html: str) -> str:
    """Replace theme-aware colour variables with their light-page hex (for Word/Google)."""
    return _VAR_COLOR.sub(r"\1", html)


def _luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def parse_background(value: str | None) -> str:
    if value is None or value == "":
        return "#FFFFFF"
    if not HEX.match(value):
        raise ValueError("background must be a hex colour like #FAF8F5")
    return value


def _no_resolver(_: str) -> None:
    return None


_EMPTY_DIAGRAM = re.compile(r"<figure([^>]*\bdata-type=\"diagram\"[^>]*)>\s*</figure>")
_DATA_CODE = re.compile(r'data-code="([^"]*)"')


def _diagram_fallbacks(html: str) -> str:
    """Diagrams written by an MCP client have no picture until the doc is opened in Chia;
    until then exports show their source."""

    def source(m: re.Match[str]) -> str:
        code = _DATA_CODE.search(m.group(1))
        return f"<pre>{code.group(1) if code else ''}</pre>"

    return _EMPTY_DIAGRAM.sub(source, html)


# ───────────── PDF ─────────────


class _LocalOnly(URLFetcher):
    """Documents may contain arbitrary URLs; only Chia's bundled fonts and inlined images load."""

    def fetch(self, url, headers=None):
        if url.startswith("data:image/"):
            return super().fetch(url, headers)
        if not url.startswith("file://"):
            raise ValueError(f"Blocked external resource: {url[:80]}")
        path = Path(url.removeprefix("file://")).resolve()
        if path.parent != FONT_DIR:
            raise ValueError(f"Blocked local resource: {url}")
        return super().fetch(url, headers)


def to_pdf(title: str, html: str, page: PageSize, background: str, resolve: Resolver = _no_resolver) -> bytes:
    light_page = _luminance(background) > 0.45
    ink = INK_LIGHT if light_page else INK_DARK
    rule = "rgba(44,44,41,0.22)" if light_page else "rgba(236,231,220,0.22)"
    head = "#EDEDED" if light_page else "rgba(236,231,220,0.10)"
    head_ink = "#000000" if light_page else INK_DARK
    palette = "".join(f"--tc-{name}: {pair[0] if light_page else pair[1]};" for name, pair in TEXT_COLORS.items())
    size = "letter" if page is PageSize.letter else "A4"
    font = FONT_DIR.as_uri()
    css = f"""
    @font-face {{ font-family: Nunito; src: url({font}/nunito-latin-wght-normal.woff2); font-weight: 200 1000; }}
    @font-face {{ font-family: Nunito; font-style: italic; src: url({font}/nunito-latin-wght-italic.woff2); font-weight: 200 1000; }}
    :root {{ {palette} }}
    @page {{ size: {size}; margin: 1in; background: {background}; }}
    body {{ font-family: Nunito, sans-serif; font-size: 11pt; line-height: 1.5; color: {ink}; }}
    p, h1, h2, h3, ul, ol, blockquote {{ margin: 0; }}
    p:empty::after {{ content: "\\00a0"; }}
    h1 {{ font-size: 20pt; line-height: 1.25; margin: 0.4em 0 0.2em; }}
    h2 {{ font-size: 16pt; line-height: 1.3; margin: 0.4em 0 0.2em; }}
    h3 {{ font-size: 13pt; line-height: 1.35; margin: 0.4em 0 0.2em; }}
    ul, ol {{ padding-left: 1.6em; }}
    blockquote {{ padding-left: 1em; border-left: 3px solid currentColor; opacity: 0.85; }}
    hr {{ border: 0; border-top: 1px solid currentColor; opacity: 0.25; margin: 0.8em 0; }}
    code, pre {{ font-family: monospace; }}
    pre {{ white-space: pre-wrap; font-size: 9pt; margin: 0.5em 0; }}
    img {{ display: block; max-width: 100%; height: auto; margin: 0.5em auto; break-inside: avoid; }}
    img[data-align="left"] {{ margin-left: 0; }}
    img[data-align="right"] {{ margin-right: 0; }}
    figure {{ margin: 0.5em 0; }}
    figure img {{ width: 100%; margin: 0 auto; }}
    table {{ border-collapse: collapse; width: 100%; margin: 0.5em 0; table-layout: fixed; }}
    tr {{ break-inside: avoid; }}
    th, td {{ border: 1px solid {rule}; padding: 4pt 7pt; vertical-align: top; text-align: left; }}
    th {{ background: {head}; color: {head_ink}; font-weight: 700; }}
    thead {{ display: table-header-group; }}
    """
    body = inline(_diagram_fallbacks(html), resolve)
    document = f"<!doctype html><html><head><meta charset='utf-8'><title>{escape(title)}</title><style>{css}</style></head><body>{body}</body></html>"
    return HTML(string=document, url_fetcher=_LocalOnly(allowed_protocols={"file", "data"})).write_pdf()


# ───────────── DOCX ─────────────

_ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}
_MARKS = {"strong": "bold", "b": "bold", "em": "italic", "i": "italic", "u": "underline", "s": "strike", "strike": "strike", "code": "code"}
_VOID = {"br", "hr", "img", "col", "input", "meta", "link", "source", "wbr"}
_DPI = 96


@dataclass
class _Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list["_Node | str"] = field(default_factory=list)

    @property
    def style(self) -> dict[str, str]:
        raw = self.attrs.get("style") or ""
        return {k.strip().lower(): v.strip() for k, v in (d.split(":", 1) for d in raw.split(";") if ":" in d)}

    def elements(self, *tags: str) -> list["_Node"]:
        return [c for c in self.children if isinstance(c, _Node) and (not tags or c.tag in tags)]

    def text(self) -> str:
        return "".join(c if isinstance(c, str) else c.text() for c in self.children)


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs) -> None:
        node = _Node(tag, {k: v or "" for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs) -> None:
        self.stack[-1].children.append(_Node(tag, {k: v or "" for k, v in attrs}))

    def handle_endtag(self, tag) -> None:
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data) -> None:
        self.stack[-1].children.append(data)


def parse_tree(html: str) -> _Node:
    builder = _TreeBuilder()
    builder.feed(html)
    builder.close()
    return builder.root


def _points(value: str) -> float | None:
    m = re.match(r"^([\d.]+)\s*(pt|px)?$", value)
    if not m:
        return None
    n = float(m[1])
    return n * 0.75 if m[2] == "px" else n


def _int(value: str | None, default: int = 1) -> int:
    try:
        return max(1, int(value or default))
    except ValueError:
        return default


class _Box:
    """Where blocks go: the document body or a table cell (which starts with an empty paragraph)."""

    def __init__(self, target: Any, width: int, fresh_cell: bool = False) -> None:
        self.target = target
        self.width = width  # EMU available for content
        self.spare = target.paragraphs[0] if fresh_cell else None

    def paragraph(self, style: str | None = None):
        if self.spare is not None:
            para, self.spare = self.spare, None
            if style:
                para.style = style
            return para
        return self.target.add_paragraph(style=style)


class _DocxWriter:
    def __init__(self, doc: Any, resolve: Resolver) -> None:
        self.doc = doc
        self.resolve = resolve

    # Blocks

    def blocks(self, box: _Box, nodes: list[_Node | str], lists: tuple[str, ...] = (), quote: bool = False) -> None:
        loose: list[_Node | str] = []  # inline content sitting directly in a block container

        def flush() -> None:
            if any(isinstance(n, _Node) or n.strip() for n in loose):
                para = box.paragraph(self._para_style(None, lists, quote))
                for n in loose:
                    self.inline(para, n, [])
            loose.clear()

        for node in nodes:
            if isinstance(node, str) or node.tag in _MARKS or node.tag in ("span", "a", "br"):
                loose.append(node)
                continue
            flush()
            tag = node.tag
            if tag in ("p", "h1", "h2", "h3"):
                para = box.paragraph(self._para_style(tag, lists, quote))
                if align := _ALIGN.get(node.style.get("text-align", "")):
                    para.alignment = align
                for child in node.children:
                    self.inline(para, child, [])
            elif tag in ("ul", "ol"):
                for li in node.elements("li"):
                    self.blocks(box, li.children, (*lists, tag), quote)
            elif tag == "blockquote":
                self.blocks(box, node.children, lists, True)
            elif tag == "hr":
                para = box.paragraph()
                para.add_run("─" * 30)
                para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            elif tag == "img":
                self.image(box, node, node)
            elif tag == "figure":
                img = next((c for c in node.elements() if c.tag == "img"), None)
                if img is not None:
                    self.image(box, img, node)
                elif code := node.attrs.get("data-code"):
                    self.code(box, code)
                else:
                    self.blocks(box, node.children, lists, quote)
            elif tag == "pre":
                self.code(box, node.text())
            elif tag == "table":
                self.table(box, node)
            else:
                self.blocks(box, node.children, lists, quote)
        flush()

    @staticmethod
    def _para_style(tag: str | None, lists: tuple[str, ...], quote: bool) -> str | None:
        if tag in ("h1", "h2", "h3"):
            return f"Heading {tag[1]}"
        if lists:
            base = "List Bullet" if lists[-1] == "ul" else "List Number"
            depth = min(len(lists), 3)
            return base if depth == 1 else f"{base} {depth}"
        return "Quote" if quote else None

    def code(self, box: _Box, text: str) -> None:
        para = box.paragraph()
        for i, line in enumerate(text.split("\n")):
            if i:
                para.add_run().add_break()
            run = para.add_run(line)
            run.font.name = "Consolas"
            run.font.size = Pt(9)

    def image(self, box: _Box, img: _Node, holder: _Node) -> None:
        m = ASSET_SRC.search(img.attrs.get("src", ""))
        asset = self.resolve(m.group(1)) if m else None
        if asset is None:
            if alt := img.attrs.get("alt"):
                box.paragraph().add_run(f"[{alt}]").italic = True
            return
        info = DocxImage.from_blob(asset.data)
        natural = Emu(int(info.px_width / _DPI * 914400)) if info.px_width else box.width
        try:
            percent = float(holder.attrs.get("data-width") or img.attrs.get("data-width") or 0)
        except ValueError:
            percent = 0
        width = int(box.width * min(percent, 100) / 100) if percent > 0 else min(natural, box.width)
        para = box.paragraph()
        para.alignment = _ALIGN.get(holder.attrs.get("data-align") or img.attrs.get("data-align") or "center")
        para.add_run().add_picture(io.BytesIO(asset.data), width=Emu(width))

    def table(self, box: _Box, node: _Node) -> None:
        rows: list[_Node] = []
        for part in node.elements():
            if part.tag == "tr":
                rows.append(part)
            elif part.tag in ("thead", "tbody", "tfoot"):
                rows.extend(part.elements("tr"))
        if not rows:
            return

        # Lay cells out on a grid, honouring colspan/rowspan.
        taken: set[tuple[int, int]] = set()
        placed: list[tuple[int, int, int, int, _Node]] = []
        width_px: dict[int, float] = {}
        for r, tr in enumerate(rows):
            c = 0
            for cell in tr.elements("td", "th"):
                while (r, c) in taken:
                    c += 1
                cs, rs = _int(cell.attrs.get("colspan")), _int(cell.attrs.get("rowspan"))
                rs = min(rs, len(rows) - r)
                for dr in range(rs):
                    for dc in range(cs):
                        taken.add((r + dr, c + dc))
                widths = [w for w in (cell.attrs.get("colwidth") or cell.attrs.get("data-colwidth") or "").split(",") if w.strip()]
                for i, w in enumerate(widths[:cs]):
                    try:
                        if float(w) > 0:
                            width_px.setdefault(c + i, float(w))
                    except ValueError:
                        pass
                placed.append((r, c, rs, cs, cell))
                c += cs
        ncols = max(c for _, c in taken) + 1
        table = box.target.add_table(rows=len(rows), cols=ncols)
        table.style = self.doc.styles["Table Grid"]
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False

        # Column widths: as in the editor, sized columns keep their pixel width and the rest share
        # what is left of the row; scaled down if that overflows the page.
        page_px = box.width / 914400 * _DPI
        known = sum(width_px.values())
        unknown = ncols - len(width_px)
        default_px = max(48.0, (page_px - known) / unknown) if unknown else 0
        px_total = known + unknown * default_px
        scale = min(box.width / max(px_total, 1), 914400 / _DPI)
        col_emu = [int((width_px.get(i, default_px)) * scale) for i in range(ncols)]
        for i, col in enumerate(table.columns):
            col.width = Emu(col_emu[i])
            for cell in col.cells:
                cell.width = Emu(col_emu[i])

        header_rows = {r for r, tr in enumerate(rows) if tr.elements("th") and len(tr.elements("th")) == len(tr.elements("td", "th"))}
        for r in header_rows:
            if r == 0 or r - 1 in header_rows:
                tr_pr = table.rows[r]._tr.get_or_add_trPr()
                tr_pr.append(OxmlElement("w:tblHeader"))

        for r, c, rs, cs, node_cell in placed:
            cell = table.cell(r, c)
            if rs > 1 or cs > 1:
                cell = cell.merge(table.cell(r + rs - 1, c + cs - 1))
            inner = _Box(cell, sum(col_emu[c : c + cs]) - int(Inches(0.15)), fresh_cell=True)
            self.blocks(inner, node_cell.children)
            if node_cell.tag == "th":
                shading = OxmlElement("w:shd")
                shading.set(qn("w:val"), "clear")
                shading.set(qn("w:color"), "auto")
                shading.set(qn("w:fill"), HEADER_FILL)
                cell._tc.get_or_add_tcPr().append(shading)
                for para in cell.paragraphs:
                    for run in para.runs:
                        run.bold = True
                        run.font.color.rgb = RGBColor(0, 0, 0)
        # Word glues consecutive tables together; a paragraph keeps them apart.
        box.target.add_paragraph()

    # Inline

    def inline(self, para: Any, node: _Node | str, marks: list[dict[str, Any]]) -> None:
        if isinstance(node, str):
            if not node:
                return
            run = para.add_run(node)
            for mark in marks:
                if mark.get("bold"):
                    run.bold = True
                if mark.get("italic"):
                    run.italic = True
                if mark.get("underline"):
                    run.underline = True
                if mark.get("strike"):
                    run.font.strike = True
                if mark.get("code"):
                    run.font.name = "Consolas"
                if mark.get("size"):
                    run.font.size = Pt(mark["size"])
                if mark.get("color"):
                    run.font.color.rgb = RGBColor.from_string(mark["color"].upper())
            return
        if node.tag == "br":
            para.add_run().add_break()
            return
        mark: dict[str, Any] = {}
        if node.tag in _MARKS:
            mark[_MARKS[node.tag]] = True
        elif node.tag == "a":
            mark["underline"] = True
        elif node.tag == "span":
            style = node.style
            if size := _points(style.get("font-size", "")):
                mark["size"] = size
            if hex_match := re.search(r"#([0-9a-fA-F]{6})", style.get("color", "")):
                mark["color"] = hex_match[1]
        for child in node.children:
            self.inline(para, child, [*marks, mark])


def to_docx(title: str, html: str, page: PageSize, resolve: Resolver = _no_resolver) -> bytes:
    doc = DocxDocument()
    doc.core_properties.title = title
    section = doc.sections[0]
    if page is PageSize.letter:
        section.page_width, section.page_height = Inches(8.5), Inches(11)
    else:
        section.page_width, section.page_height = Mm(210), Mm(297)
    for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(section, side, Inches(1))

    normal = doc.styles["Normal"]
    normal.font.size = Pt(11)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = 1.5

    width = section.page_width - section.left_margin - section.right_margin
    _DocxWriter(doc, resolve).blocks(_Box(doc, width), parse_tree(html).children)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ───────────── Sheets and slides ─────────────


def to_xlsx(title: str, columns: list[str], rows: list[list[Any]]) -> bytes:
    """One worksheet: a grey, frozen header row over the cells, numbers kept as numbers."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    book = Workbook()
    sheet = book.active
    assert sheet is not None
    # Sheet names are capped at 31 characters and can't hold []:*?/\
    sheet.title = re.sub(r"[\[\]:*?/\\]", " ", title.strip() or "Sheet")[:31].strip() or "Sheet"
    book.properties.title = title
    sheet.append(columns)
    for row in rows:
        sheet.append([None if v == "" else v for v in row])
    fill = PatternFill("solid", start_color=HEADER_FILL, end_color=HEADER_FILL)
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="000000")
        cell.fill = fill
        cell.alignment = Alignment(vertical="center")
    sheet.freeze_panes = "A2"
    for i, name in enumerate(columns, start=1):
        longest = max([len(str(name))] + [len(str(r[i - 1])) for r in rows if i - 1 < len(r) and r[i - 1] is not None])
        sheet.column_dimensions[get_column_letter(i)].width = min(60, max(10, longest + 2))
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def to_pptx(title: str, slides: list[dict[str, str]]) -> bytes:
    """16:9 deck, one "Title and Content" slide each. Lines starting with "- " become bullets."""
    from pptx import Presentation
    from pptx.util import Inches as PptInches

    deck = Presentation()
    deck.slide_width, deck.slide_height = PptInches(13.333), PptInches(7.5)
    deck.core_properties.title = title
    layout = deck.slide_layouts[1]
    for data in slides or [{"title": "", "body": ""}]:
        slide = deck.slides.add_slide(layout)
        heading, content = slide.placeholders[0], slide.placeholders[1]
        # The template is 4:3; stretch its boxes across the wider slide.
        for shape in (heading, content):
            shape.left, shape.width = PptInches(0.75), deck.slide_width - PptInches(1.5)
        heading.text = data.get("title", "")
        lines = [line for line in data.get("body", "").splitlines() if line.strip()]
        frame = content.text_frame
        if not lines:
            content.element.getparent().remove(content.element)
            continue
        for i, line in enumerate(lines):
            para = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
            bullet = line.lstrip().startswith(("- ", "* "))
            para.text = line.lstrip()[2:] if bullet else line.strip()
            if not bullet:  # plain lines: no bullet glyph
                pPr = para._p.get_or_add_pPr()
                pPr.set("indent", "0")
                pPr.set("marL", "0")
                pPr.insert(0, OxmlElement("a:buNone"))
    buf = io.BytesIO()
    deck.save(buf)
    return buf.getvalue()
