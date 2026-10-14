"""Render a Chia doc (editor HTML) to PDF or DOCX.

The editor emits a small, known subset of HTML: p, h1-h3, ul/ol/li, blockquote, hr, br,
strong/em/u/s/code, and <span style="font-size">, with `text-align` on blocks. Both
renderers understand exactly that subset.
"""

import io
import re
from html import escape
from html.parser import HTMLParser
from pathlib import Path

from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Mm, Pt, RGBColor
from weasyprint import HTML
from weasyprint.urls import URLFetcher

from app.models import PageSize

FONT_DIR = (Path(__file__).parent / "assets" / "fonts").resolve()
HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}){1,2}$")
INK_LIGHT, INK_DARK = "#2C2C29", "#ECE7DC"

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


# ───────────── PDF ─────────────


class _FontsOnly(URLFetcher):
    """Documents may contain arbitrary URLs; only Chia's bundled fonts may be loaded."""

    def fetch(self, url, headers=None):
        if not url.startswith("file://"):
            raise ValueError(f"Blocked external resource: {url}")
        path = Path(url.removeprefix("file://")).resolve()
        if path.parent != FONT_DIR:
            raise ValueError(f"Blocked local resource: {url}")
        return super().fetch(url, headers)


def to_pdf(title: str, html: str, page: PageSize, background: str) -> bytes:
    light_page = _luminance(background) > 0.45
    ink = INK_LIGHT if light_page else INK_DARK
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
    code {{ font-family: monospace; }}
    """
    document = f"<!doctype html><html><head><meta charset='utf-8'><title>{escape(title)}</title><style>{css}</style></head><body>{html}</body></html>"
    return HTML(string=document, url_fetcher=_FontsOnly(allowed_protocols={"file"})).write_pdf()


# ───────────── DOCX ─────────────

_ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}
_BLOCKS = {"p", "h1", "h2", "h3"}
_MARKS = {"strong": "bold", "b": "bold", "em": "italic", "i": "italic", "u": "underline", "s": "strike", "strike": "strike", "code": "code"}


def _style(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
    raw = dict(attrs).get("style") or ""
    return {k.strip().lower(): v.strip() for k, v in (d.split(":", 1) for d in raw.split(";") if ":" in d)}


def _points(value: str) -> float | None:
    m = re.match(r"^([\d.]+)\s*(pt|px)?$", value)
    if not m:
        return None
    n = float(m[1])
    return n * 0.75 if m[2] == "px" else n


class _DocxBuilder(HTMLParser):
    def __init__(self, doc) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = doc
        self.para = None
        self.marks: list[dict] = []  # one entry per open inline tag
        self.lists: list[str] = []  # "ul" / "ol"
        self.quote = 0

    def _new_para(self, tag: str, style: dict[str, str]) -> None:
        if tag in ("h1", "h2", "h3"):
            word_style = f"Heading {tag[1]}"
        elif self.lists:
            base = "List Bullet" if self.lists[-1] == "ul" else "List Number"
            depth = min(len(self.lists), 3)
            word_style = base if depth == 1 else f"{base} {depth}"
        elif self.quote:
            word_style = "Quote"
        else:
            word_style = None
        self.para = self.doc.add_paragraph(style=word_style)
        if align := _ALIGN.get(style.get("text-align", "")):
            self.para.alignment = align

    def handle_starttag(self, tag: str, attrs) -> None:
        style = _style(attrs)
        if tag in _BLOCKS:
            self._new_para(tag, style)
        elif tag in ("ul", "ol"):
            self.lists.append(tag)
        elif tag == "blockquote":
            self.quote += 1
        elif tag == "br" and self.para is not None:
            self.para.add_run().add_break()
        elif tag == "hr":
            self.doc.add_paragraph("─" * 30).alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif tag in _MARKS:
            self.marks.append({_MARKS[tag]: True})
        elif tag == "span":
            mark: dict = {}
            if size := _points(style.get("font-size", "")):
                mark["size"] = size
            if hex_match := re.search(r"#([0-9a-fA-F]{6})", style.get("color", "")):
                mark["color"] = hex_match[1]
            self.marks.append(mark)
        elif tag == "a":
            self.marks.append({"underline": True})

    def handle_endtag(self, tag: str) -> None:
        if tag in _BLOCKS:
            self.para = None
        elif tag in ("ul", "ol") and self.lists:
            self.lists.pop()
        elif tag == "blockquote" and self.quote:
            self.quote -= 1
        elif (tag in _MARKS or tag in ("span", "a")) and self.marks:
            self.marks.pop()

    def handle_data(self, data: str) -> None:
        if not data:
            return
        if self.para is None:
            if not data.strip():
                return
            self._new_para("p", {})
        run = self.para.add_run(data)
        for mark in self.marks:
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


def to_docx(title: str, html: str, page: PageSize) -> bytes:
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

    _DocxBuilder(doc).feed(html)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
