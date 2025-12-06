#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

try:
    from dotenv import load_dotenv
except Exception:
    load_dotenv = None

try:
    import requests
except Exception as exc:
    print("Missing dependency 'requests'. Install from requirements.txt", file=sys.stderr)
    raise

try:
    from pypdf import PdfReader
except Exception as exc:
    print("Missing dependency 'pypdf'. Install from requirements.txt", file=sys.stderr)
    raise


def log(msg: str) -> None:
    print(msg, file=sys.stdout)


def read_env():
    # Prefer .env.local at repo root if present to match Next.js conventions
    # Fallback to default .env discovery if python-dotenv is available
    if load_dotenv:
        # Attempt to load from repo root .env.local (two levels up from this file)
        repo_root = Path(__file__).resolve().parents[2]
        env_local = repo_root / ".env.local"
        if env_local.exists():
            load_dotenv(env_local)
        else:
            load_dotenv()

    openai_key = os.getenv("OPENAI_API_KEY")
    turbopuffer_key = os.getenv("TURBOPUFFER_API_KEY")
    namespace = os.getenv("TURBOPUFFER_NAMESPACE", "_synergy_lava_ridge")
    return openai_key, turbopuffer_key, namespace


def list_pdfs(directory: Path) -> List[Path]:
    return sorted(p for p in directory.rglob("*.pdf") if p.is_file())


def extract_text_per_page(pdf_path: Path) -> List[str]:
    reader = PdfReader(str(pdf_path))
    texts: List[str] = []
    for page in reader.pages:
        try:
            content = page.extract_text() or ""
        except Exception:
            content = ""
        texts.append(content.strip())
    return texts


def chunk_text(text: str, max_len: int = 1800, overlap: int = 200) -> List[str]:
    chunks: List[str] = []
    i = 0
    n = len(text)
    if n == 0:
        return chunks
    while i < n:
        end = min(i + max_len, n)
        slice_ = text[i:end].strip()
        if slice_:
            chunks.append(slice_)
        if end == n:
            break
        i = max(0, end - overlap)
    return chunks


def stable_id(source_pdf: str, page_num: int, chunk_index: int) -> str:
    base = f"{source_pdf}::{page_num}::{chunk_index}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def embed_batch_openai(api_key: str, texts: List[str]) -> List[List[float]]:
    url = "https://api.openai.com/v1/embeddings"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "text-embedding-3-small",
        "input": texts,
    }
    res = requests.post(url, headers=headers, json=payload, timeout=60)
    if res.status_code >= 400:
        raise RuntimeError(f"Embedding failed: {res.status_code} {res.text}")
    data = res.json()
    return [item["embedding"] for item in data["data"]]


def upsert_rows_turbopuffer(
    api_key: str,
    namespace: str,
    rows: List[Dict],
) -> None:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    attempted: List[Tuple[str, int, str]] = []

    # Try common endpoint variants
    endpoints = [
        f"https://api.turbopuffer.com/v2/namespaces/{namespace}/rows",
        f"https://api.turbopuffer.com/v2/namespaces/{namespace}/rows/upsert",
        f"https://api.turbopuffer.com/v2/namespaces/{namespace}/upsert",
    ]
    last_status = None
    last_text = ""
    for url in endpoints:
        res = requests.post(url, headers=headers, json={"rows": rows}, timeout=120)
        if res.status_code < 400:
            return
        attempted.append((url, res.status_code, res.text))
        last_status = res.status_code
        last_text = res.text

    message = "Upsert failed. Attempted endpoints:\n"
    for (u, code, text) in attempted:
        message += f" - {u} -> {code} {text[:200]}\n"
    raise RuntimeError(message)


def ingest_pdf(
    pdf_path: Path,
    project_name: str,
    source_link: str,
    *,
    openai_key: Optional[str],
    turbopuffer_key: Optional[str],
    namespace: str,
    dry_run: bool,
    batch_embed: int,
    write_batch: int,
    chunk_size: int,
    chunk_overlap: int,
) -> Tuple[int, int]:
    """
    Returns: (chunks_count, rows_written)
    """
    pages = extract_text_per_page(pdf_path)
    timestamp = datetime.now(tz=timezone.utc).isoformat()
    source_pdf = pdf_path.name

    total_chunks = 0
    rows_buffer: List[Dict] = []
    rows_written = 0

    for page_index, page_text in enumerate(pages):
        if not page_text:
            continue
        chunks = chunk_text(page_text, max_len=chunk_size, overlap=chunk_overlap)
        if not chunks:
            continue
        total_chunks += len(chunks)

        # Embed in batches (unless dry-run)
        for i in range(0, len(chunks), batch_embed):
            batch = chunks[i : i + batch_embed]
            vectors: List[List[float]]
            if dry_run:
                # Use zeros to avoid network usage in dry-run
                vectors = [[0.0] * 1536 for _ in batch]
            else:
                if not openai_key:
                    raise RuntimeError("OPENAI_API_KEY is not set but embeddings are requested.")
                vectors = embed_batch_openai(openai_key, batch)

            for j, text in enumerate(batch):
                chunk_index = i + j
                row_id = stable_id(source_pdf, page_index + 1, chunk_index)
                row = {
                    "id": row_id,
                    "projectName": project_name,
                    "link": source_link,
                    "source_pdf": source_pdf,
                    "page_num": page_index + 1,
                    "section": None,
                    "chunk_index": chunk_index,
                    "content": text,
                    "vector": vectors[j],
                    "timestamp": timestamp,
                }
                rows_buffer.append(row)

            # Flush in write batches
            if not dry_run and len(rows_buffer) >= write_batch:
                if not turbopuffer_key:
                    raise RuntimeError("TURBOPUFFER_API_KEY is not set.")
                upsert_rows_turbopuffer(turbopuffer_key, namespace, rows_buffer)
                rows_written += len(rows_buffer)
                rows_buffer.clear()

    # Final flush
    if not dry_run and rows_buffer:
        if not turbopuffer_key:
            raise RuntimeError("TURBOPUFFER_API_KEY is not set.")
        upsert_rows_turbopuffer(turbopuffer_key, namespace, rows_buffer)
        rows_written += len(rows_buffer)
        rows_buffer.clear()

    return total_chunks, rows_written


def main():
    parser = argparse.ArgumentParser(description="Ingest PDFs into Turbopuffer.")
    parser.add_argument("--dir", required=True, help="Directory containing PDFs")
    parser.add_argument("--project", required=True, help="Project name (e.g., 'Lava Ridge')")
    parser.add_argument("--link", required=True, help="Source link to store as metadata")
    parser.add_argument("--namespace", default=None, help="Turbopuffer namespace override")
    parser.add_argument("--max-pdfs", type=int, default=None, help="Limit number of PDFs processed")
    parser.add_argument("--dry-run", action="store_true", help="Do not call external APIs; no writes")
    parser.add_argument("--batch-embed", type=int, default=64, help="Embedding batch size")
    parser.add_argument("--write-batch", type=int, default=500, help="Rows per upsert batch")
    parser.add_argument("--chunk-size", type=int, default=1800, help="Max characters per chunk")
    parser.add_argument("--chunk-overlap", type=int, default=200, help="Characters overlap")

    args = parser.parse_args()

    openai_key, turbopuffer_key, env_namespace = read_env()
    namespace = args.namespace or env_namespace

    directory = Path(args.dir).expanduser().resolve()
    if not directory.exists():
        print(f"Directory not found: {directory}", file=sys.stderr)
        sys.exit(1)

    pdfs = list_pdfs(directory)
    if args.max_pdfs is not None:
        pdfs = pdfs[: args.max_pdfs]

    log(
        json.dumps(
            {
                "pdf_count": len(pdfs),
                "dir": str(directory),
                "namespace": namespace,
                "dry_run": args.dry_run,
            }
        )
    )

    total_chunks = 0
    total_written = 0

    for idx, pdf_path in enumerate(pdfs, start=1):
        log(f"Processing ({idx}/{len(pdfs)}): {pdf_path.name}")
        try:
            chunks, written = ingest_pdf(
                pdf_path=pdf_path,
                project_name=args.project,
                source_link=args.link,
                openai_key=openai_key,
                turbopuffer_key=turbopuffer_key,
                namespace=namespace,
                dry_run=args.dry_run,
                batch_embed=args.batch_embed,
                write_batch=args.write_batch,
                chunk_size=args.chunk_size,
                chunk_overlap=args.chunk_overlap,
            )
            total_chunks += chunks
            total_written += written
            log(f"  -> chunks: {chunks}, rows_written: {written}")
        except Exception as exc:
            log(f"  !! failed: {exc}")

    summary = {
        "processed_pdfs": len(pdfs),
        "total_chunks": total_chunks,
        "total_rows_written": total_written,
        "namespace": namespace,
        "dry_run": args.dry_run,
    }
    log(json.dumps(summary))


if __name__ == "__main__":
    main()


