import argparse
import hashlib
import html
import re
import shutil
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


PUBLICATIONS_URL = "https://mlml.kaist.ac.kr/publications"
APP_DATA_DIR = Path.home() / "AppData" / "Roaming" / "local.paper-pilot.reader"
DASHBOARD_PATH = Path.home() / "Downloads" / "mlml_two_layer_taxonomy_dashboard_2020_2026.html"


@dataclass
class TaxonomyRow:
    year: str
    title: str
    level1: str
    level2: str
    rationale: str
    secondary_tags: str


@dataclass
class PublicationLink:
    text: str
    href: str


@dataclass
class Publication:
    year: str
    title: str
    raw_text: str = ""
    links: list[PublicationLink] = field(default_factory=list)


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell_parts = []

    def handle_data(self, data: str) -> None:
        if self._cell_parts is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._cell_parts is not None and self._row is not None:
            text = normalize_space("".join(self._cell_parts))
            self._row.append(html.unescape(text))
            self._cell_parts = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            if self._row:
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None


class PublicationsParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.publications: list[Publication] = []
        self._year: str | None = None
        self._paper: Publication | None = None
        self._collect_heading: str | None = None
        self._heading_parts: list[str] = []
        self._link_href: str | None = None
        self._link_parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in {"h3", "h4"}:
            if tag in {"h3", "h4"}:
                self._finish_paper()
            self._collect_heading = tag
            self._heading_parts = []
        elif tag == "a" and self._paper is not None:
            href = dict(attrs).get("href")
            self._link_href = href
            self._link_parts = []

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._collect_heading:
            self._heading_parts.append(data)
        elif self._link_href is not None:
            self._link_parts.append(data)
        elif self._paper is not None:
            self._paper.raw_text += data

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == self._collect_heading:
            text = normalize_space("".join(self._heading_parts))
            if tag == "h3":
                self._year = text if re.fullmatch(r"20\d{2}", text) else None
            elif tag == "h4" and self._year and re.fullmatch(r"20\d{2}", self._year):
                self._paper = Publication(year=self._year, title=text)
            self._collect_heading = None
            self._heading_parts = []
        elif tag == "a" and self._link_href is not None and self._paper is not None:
            text = normalize_space("".join(self._link_parts))
            href = urljoin(PUBLICATIONS_URL, self._link_href)
            self._paper.links.append(PublicationLink(text=text, href=href))
            self._paper.raw_text += f" [{text}] "
            self._link_href = None
            self._link_parts = []

    def close(self) -> None:
        self._finish_paper()
        super().close()

    def _finish_paper(self) -> None:
        if self._paper is not None:
            self._paper.raw_text = normalize_space(self._paper.raw_text)
            if self._paper.title:
                self.publications.append(self._paper)
            self._paper = None


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()


def title_key(title: str) -> str:
    title = re.sub(r"\s+\(Workshop\)$", "", title)
    title = re.sub(r"[^a-z0-9]+", " ", title.lower())
    return normalize_space(title)


def safe_component(value: str, limit: int = 92) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return (cleaned[:limit].rstrip(" .") or "untitled")


def sanitize_file_name(name: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in ".-_") else "_" for ch in name)
    cleaned = cleaned.strip("_")
    return cleaned or "document.pdf"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_url(url: str, timeout: int = 45) -> bytes:
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; PaperPilotMLMLImporter/1.0)",
            "Accept": "text/html,application/pdf,*/*;q=0.8",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def parse_taxonomy(path: Path) -> list[TaxonomyRow]:
    parser = TableParser()
    parser.feed(path.read_text(encoding="utf-8"))
    for table in parser.tables:
        if not table:
            continue
        headers = [cell.lower() for cell in table[0]]
        if headers[:4] == ["year", "title", "level1", "level2"]:
            rows = []
            for cells in table[1:]:
                if len(cells) >= 6:
                    rows.append(TaxonomyRow(*cells[:6]))
            return rows
    raise RuntimeError(f"Could not find taxonomy table in {path}")


def parse_publications(html_text: str) -> list[Publication]:
    parser = PublicationsParser()
    parser.feed(html_text)
    parser.close()
    return [paper for paper in parser.publications if paper.year.isdigit() and int(paper.year) >= 2020]


def clean_venue(raw_text: str) -> str:
    raw_text = re.sub(r"\[[^\]]+\]", " ", raw_text)
    raw_text = re.sub(r"\b(Collaboration with|code|webpage|project|tweet|poster)\b.*", " ", raw_text, flags=re.I)
    pieces = [part.strip() for part in re.split(r"\s{2,}| \*Collaboration|\u2217Collaboration", raw_text) if part.strip()]
    return pieces[0] if pieces else raw_text.strip()


def build_publication_map(publications: Iterable[Publication]) -> dict[tuple[str, str], Publication]:
    result: dict[tuple[str, str], Publication] = {}
    for paper in publications:
        result[(paper.year, title_key(paper.title))] = paper
    return result


def pdf_url_from_link(link: PublicationLink) -> str | None:
    text = link.text.lower()
    href = link.href.strip()
    parsed = urlparse(href)
    host = parsed.netloc.lower()
    path = parsed.path

    if "arxiv.org" in host:
        match = re.search(r"/(?:abs|html|pdf)/([^/?#]+)", path)
        if match:
            arxiv_id = match.group(1).removesuffix(".pdf")
            return f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    if "openreview.net" in host:
        if path.startswith("/pdf"):
            return href
        query = parse_qs(parsed.query)
        if "id" in query and query["id"]:
            return f"https://openreview.net/pdf?id={query['id'][0]}"
    if "proceedings.mlr.press" in host and path.lower().endswith(".html"):
        slug = Path(path).stem
        parent = path.removesuffix(f"{slug}.html").rstrip("/")
        return f"{parsed.scheme}://{parsed.netloc}{parent}/{slug}/{slug}.pdf"
    if "jmlr.org" in host and path.lower().endswith(".html"):
        match = re.search(r"/papers/v(\d+)/([^/]+)\.html$", path)
        if match:
            volume, paper_id = match.groups()
            return f"https://www.jmlr.org/papers/volume{volume}/{paper_id}/{paper_id}.pdf"
    if path.lower().endswith(".pdf"):
        if "github.com" in host and "/blob/" in path:
            return href.replace("/blob/", "/raw/")
        return href
    if "pdf" in text and "github.com" in host:
        query = parse_qs(parsed.query)
        query["raw"] = ["1"]
        return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))
    return None


def choose_pdf_url(paper: Publication) -> str | None:
    preferred = []
    fallback = []
    for link in paper.links:
        pdf_url = pdf_url_from_link(link)
        if not pdf_url:
            continue
        label = link.text.lower()
        if any(token in label for token in ("arxiv", "pdf", "paper")):
            preferred.append(pdf_url)
        else:
            fallback.append(pdf_url)
    return (preferred or fallback or [None])[0]


def get_page_count(pdf_bytes: bytes) -> int:
    return max(0, len(re.findall(rb"/Type\s*/Page\b", pdf_bytes)))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_folder_id(parent_id: str, name: str) -> str:
    digest = hashlib.sha1(f"{parent_id}/{name}".encode("utf-8")).hexdigest()[:12]
    return f"folder-mlml-{digest}"


def ensure_folder(conn: sqlite3.Connection, parent_id: str | None, name: str) -> str:
    row = conn.execute(
        "SELECT id FROM folders WHERE parent_id IS ? AND name = ?",
        (parent_id, name),
    ).fetchone()
    if row:
        return row[0]
    folder_id = make_folder_id(parent_id or "root", name)
    created_at = now_iso()
    conn.execute(
        "INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)",
        (folder_id, parent_id, name, created_at),
    )
    return folder_id


def upsert_document(
    conn: sqlite3.Connection,
    docs_dir: Path,
    pdf_bytes: bytes,
    title: str,
    year: str,
    folder_id: str,
    source_url: str,
    venue: str,
) -> tuple[str, str]:
    digest = sha256_hex(pdf_bytes)
    existing = conn.execute(
        "SELECT id, file_path FROM documents WHERE hash = ? OR (title = ? AND year = ?)",
        (digest, title, year),
    ).fetchone()
    timestamp = now_iso()
    if existing:
        document_id, file_path = existing
        conn.execute(
            """
            UPDATE documents
            SET title = ?, year = ?, folder_id = ?, hash = ?, abstract_text = ?, updated_at = ?
            WHERE id = ?
            """,
            (title, year, folder_id, digest, source_url, timestamp, document_id),
        )
        return document_id, "updated"

    document_id = str(uuid.uuid4())
    suggested_name = f"{year}_{safe_component(title, 110)}.pdf"
    safe_name = sanitize_file_name(suggested_name)
    docs_dir.mkdir(parents=True, exist_ok=True)
    file_path = docs_dir / f"{document_id}-{safe_name}"
    file_path.write_bytes(pdf_bytes)
    conn.execute(
        """
        INSERT INTO documents
        (id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """,
        (
            document_id,
            title,
            safe_name,
            str(file_path),
            digest,
            get_page_count(pdf_bytes),
            venue,
            year,
            source_url,
            folder_id,
            timestamp,
            timestamp,
        ),
    )
    return document_id, "inserted"


def verify_pdf(url: str, data: bytes) -> None:
    if len(data) < 1024:
        raise RuntimeError(f"Downloaded file is too small from {url}")
    if not data.lstrip().startswith(b"%PDF"):
        preview = data[:80].decode("utf-8", errors="replace")
        raise RuntimeError(f"Downloaded content is not a PDF from {url}: {preview}")


def download_pdf(url: str, retries: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            data = read_url(url)
            verify_pdf(url, data)
            return data
        except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
            last_error = error
            if attempt < retries:
                time.sleep(1.5 * attempt)
    raise RuntimeError(str(last_error))


def import_publications(args: argparse.Namespace) -> int:
    taxonomy_rows = parse_taxonomy(Path(args.dashboard))
    html_bytes = read_url(args.publications_url)
    publication_map = build_publication_map(parse_publications(html_bytes.decode("utf-8", errors="replace")))

    app_data = Path(args.app_data)
    db_path = app_data / "paperdock.sqlite3"
    docs_dir = app_data / "documents"
    app_data.mkdir(parents=True, exist_ok=True)

    missing: list[str] = []
    failures: list[str] = []
    inserted = 0
    updated = 0
    skipped = 0

    backup_path = db_path.with_suffix(f".sqlite3.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    if db_path.exists() and not args.dry_run:
        shutil.copy2(db_path, backup_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        mlml_id = ensure_folder(conn, "root", "mlml")

        for row in taxonomy_rows:
            key = (row.year, title_key(row.title))
            publication = publication_map.get(key)
            if publication is None:
                missing.append(f"{row.year} - {row.title}")
                continue
            pdf_url = choose_pdf_url(publication)
            if not pdf_url:
                failures.append(f"{row.year} - {row.title}: no PDF link")
                continue

            level1_id = ensure_folder(conn, mlml_id, row.level1)
            level2_id = ensure_folder(conn, level1_id, row.level2)
            if args.dry_run:
                print(f"DRY {row.year} | {row.level1} / {row.level2} | {row.title} | {pdf_url}")
                skipped += 1
                continue

            try:
                pdf_bytes = download_pdf(pdf_url)
                document_id, status = upsert_document(
                    conn,
                    docs_dir,
                    pdf_bytes,
                    row.title,
                    row.year,
                    level2_id,
                    pdf_url,
                    clean_venue(publication.raw_text),
                )
                conn.commit()
                if status == "inserted":
                    inserted += 1
                else:
                    updated += 1
                print(f"{status.upper()} {row.year} | {row.title} | {document_id}")
            except Exception as error:
                failures.append(f"{row.year} - {row.title}: {error}")
                print(f"FAILED {row.year} | {row.title} | {error}", file=sys.stderr)

        if missing or failures:
            print("\nProblems:", file=sys.stderr)
            for item in missing:
                print(f"MISSING {item}", file=sys.stderr)
            for item in failures:
                print(f"FAILED {item}", file=sys.stderr)

        print(f"\nSummary: inserted={inserted}, updated={updated}, dry_skipped={skipped}, missing={len(missing)}, failures={len(failures)}")
        if backup_path.exists():
            print(f"Backup: {backup_path}")
        return 1 if missing or failures else 0
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Import MLML publications from 2020 onward into Paper Pilot.")
    parser.add_argument("--dashboard", default=str(DASHBOARD_PATH))
    parser.add_argument("--publications-url", default=PUBLICATIONS_URL)
    parser.add_argument("--app-data", default=str(APP_DATA_DIR))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    return import_publications(args)


if __name__ == "__main__":
    raise SystemExit(main())
