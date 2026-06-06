#!/usr/bin/env python3
"""Sparse page-text retrieval adapter for Paper Pilot.

The adapter intentionally receives already-extracted page text. It does not
open PDFs, run OCR, or invoke document parsers.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+-]{1,}|[0-9]+(?:\.[0-9]+)?")


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def tokenize(value: str) -> list[str]:
    return [match.group(0).lower() for match in TOKEN_RE.finditer(value or "")]


def chunks_for_page(page: dict[str, Any], chunk_size: int, overlap: int) -> list[dict[str, Any]]:
    text = clean_text(str(page.get("text") or ""))
    page_number = int(page.get("pageNumber") or page.get("page_number") or 0)
    if not text or page_number <= 0:
        return []
    paragraphs = [item.strip() for item in re.split(r"\n{2,}|(?<=[.!?])\s+(?=[A-Z])", text) if item.strip()]
    chunks: list[dict[str, Any]] = []
    current = ""
    for paragraph in paragraphs or [text]:
        candidate = f"{current} {paragraph}".strip() if current else paragraph
        if len(candidate) <= chunk_size:
            current = candidate
            continue
        if current:
            chunks.append({"pageNumber": page_number, "text": current})
            current = current[-overlap:].strip() if overlap > 0 else ""
        while len(paragraph) > chunk_size:
            chunk = paragraph[:chunk_size].strip()
            chunks.append({"pageNumber": page_number, "text": chunk})
            paragraph = paragraph[max(1, chunk_size - overlap) :].strip()
        current = f"{current} {paragraph}".strip() if current else paragraph
    if current:
        chunks.append({"pageNumber": page_number, "text": current})
    return chunks


def corpus_hash(pages: list[dict[str, Any]], chunk_size: int, overlap: int) -> str:
    digest = hashlib.sha256()
    digest.update(f"paperqa-sparse-v1:{chunk_size}:{overlap}\n".encode("utf-8"))
    for page in pages:
        digest.update(str(page.get("pageNumber") or page.get("page_number") or "").encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(page.get("text") or "").encode("utf-8", errors="ignore"))
        digest.update(b"\0")
    return digest.hexdigest()


def load_or_build_chunks(
    pages: list[dict[str, Any]],
    cache_dir: Path,
    document_id: str,
    chunk_size: int,
    overlap: int,
) -> tuple[list[dict[str, Any]], bool, str]:
    key = corpus_hash(pages, chunk_size, overlap)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{safe_name(document_id or 'document')}-{key[:16]}.chunks.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8")), True, key
        except Exception:
            pass
    chunks: list[dict[str, Any]] = []
    for page in pages:
        chunks.extend(chunks_for_page(page, chunk_size, overlap))
    for index, chunk in enumerate(chunks):
        chunk["chunkId"] = f"p{int(chunk['pageNumber']):03d}-c{index:04d}"
    cache_file.write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
    return chunks, False, key


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return cleaned.strip("._") or "document"


def score_chunks(chunks: list[dict[str, Any]], queries: list[str], limit: int) -> list[dict[str, Any]]:
    query_text = " ".join(queries)
    query_terms = tokenize(query_text)
    if not query_terms:
        return []
    query_counts = Counter(query_terms)
    docs_tokens = [tokenize(str(chunk.get("text") or "")) for chunk in chunks]
    doc_freq: Counter[str] = Counter()
    for tokens in docs_tokens:
        doc_freq.update(set(tokens))
    total_docs = max(1, len(chunks))
    scored: list[tuple[float, dict[str, Any]]] = []
    for chunk, tokens in zip(chunks, docs_tokens):
        if not tokens:
            continue
        counts = Counter(tokens)
        score = 0.0
        for term, q_count in query_counts.items():
            tf = counts.get(term, 0)
            if tf <= 0:
                continue
            idf = math.log((total_docs + 1) / (doc_freq.get(term, 0) + 0.5)) + 1.0
            score += (1.0 + math.log(tf)) * idf * max(1, q_count)
        if score <= 0:
            continue
        text = str(chunk.get("text") or "")
        scored.append(
            (
                score,
                {
                    "pageNumber": int(chunk.get("pageNumber") or 0),
                    "chunkId": str(chunk.get("chunkId") or ""),
                    "score": round(score, 4),
                    "text": text[:1400],
                },
            )
        )
    scored.sort(key=lambda item: (-item[0], item[1]["pageNumber"], item[1]["chunkId"]))
    selected: list[dict[str, Any]] = []
    per_page: Counter[int] = Counter()
    for _, item in scored:
        page = int(item["pageNumber"])
        if per_page[page] >= 2:
            continue
        selected.append(item)
        per_page[page] += 1
        if len(selected) >= limit:
            break
    return selected


def paperqa_available() -> bool:
    try:
        import paperqa  # noqa: F401

        return True
    except Exception:
        return False


def page_from_text(value: str) -> int:
    match = re.search(r"\bp(?:age)?\.?\s*(\d+)\b", value, re.IGNORECASE)
    return int(match.group(1)) if match else 0


def extract_texts(value: Any, depth: int = 0) -> list[str]:
    if depth > 5 or value is None:
        return []
    if isinstance(value, str):
        return [value] if len(value.strip()) > 40 else []
    if isinstance(value, dict):
        texts: list[str] = []
        for key in ("text", "context", "contexts", "summary", "formatted_answer", "answer"):
            if key in value:
                texts.extend(extract_texts(value[key], depth + 1))
        return texts
    if isinstance(value, (list, tuple)):
        texts: list[str] = []
        for item in value:
            texts.extend(extract_texts(item, depth + 1))
        return texts
    texts = []
    for attr in ("text", "context", "contexts", "summary"):
        if hasattr(value, attr):
            texts.extend(extract_texts(getattr(value, attr), depth + 1))
    return texts


async def try_paperqa2_sparse(
    chunks: list[dict[str, Any]],
    queries: list[str],
    cache_dir: Path,
    corpus_key: str,
    limit: int,
) -> list[dict[str, Any]] | None:
    try:
        from paperqa import Docs, Settings  # type: ignore
    except Exception:
        return None
    corpus_dir = cache_dir / f"paperqa2-{corpus_key[:16]}"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    docs = Docs()
    try:
        settings = Settings(embedding="sparse")
    except Exception:
        settings = Settings()
        try:
            settings.embedding = "sparse"
        except Exception:
            pass
    for chunk in chunks:
        page = int(chunk.get("pageNumber") or 0)
        chunk_id = safe_name(str(chunk.get("chunkId") or f"p{page}"))
        path = corpus_dir / f"{chunk_id}.txt"
        path.write_text(f"p. {page}\n\n{chunk.get('text') or ''}", encoding="utf-8")
        try:
            await docs.aadd(str(path), citation=f"p. {page}", docname=chunk_id, settings=settings)
        except TypeError:
            await docs.aadd(str(path), citation=f"p. {page}", docname=chunk_id)
    query = " ".join(queries)
    try:
        if hasattr(docs, "aget_evidence"):
            session = await docs.aget_evidence(query, settings=settings)
        else:
            session = await docs.aquery(query, settings=settings)
    except Exception:
        return None
    extracted = []
    seen = set()
    for text in extract_texts(session):
        clean = clean_text(text)
        if clean in seen:
            continue
        seen.add(clean)
        page = page_from_text(clean)
        extracted.append(
            {
                "pageNumber": page,
                "chunkId": f"paperqa2-{len(extracted):04d}",
                "score": 1.0,
                "text": clean[:1400],
            }
        )
        if len(extracted) >= limit:
            break
    return extracted or None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.input).read_text(encoding="utf-8-sig"))
    pages = request.get("pages") if isinstance(request.get("pages"), list) else []
    queries = [str(item).strip() for item in request.get("queries", []) if str(item).strip()]
    english_question = str(request.get("englishQuestion") or "").strip()
    if english_question:
        queries.insert(0, english_question)
    cache_dir = Path(str(request.get("cacheDir") or ".paperqa_sparse_cache"))
    chunk_size = int(request.get("chunkSize") or 1100)
    overlap = int(request.get("overlap") or 220)
    max_chunks = int(request.get("maxChunks") or 6)

    chunks, cache_reused, key = load_or_build_chunks(
        pages,
        cache_dir,
        str(request.get("documentId") or "document"),
        chunk_size,
        overlap,
    )
    evidence = None
    engine = "local-sparse-compatible"
    warnings: list[str] = []
    if paperqa_available():
        evidence = asyncio.run(try_paperqa2_sparse(chunks, queries, cache_dir, key, max_chunks))
        if evidence is not None:
            engine = "paperqa2-sparse"
        else:
            warnings.append("PaperQA2 sparse retrieval was unavailable for this request; used compatible sparse scorer.")
    else:
        warnings.append("PaperQA2 package not installed; used compatible sparse scorer.")
    if evidence is None:
        evidence = score_chunks(chunks, queries, max_chunks)
    response = {
        "engine": engine,
        "embedding": "sparse",
        "cacheReused": cache_reused,
        "corpusHash": key,
        "chunkCount": len(chunks),
        "evidence": evidence,
        "warnings": warnings,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
