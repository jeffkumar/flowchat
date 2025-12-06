## PDF → Turbopuffer Ingest (Python)

### Overview
Ingest local PDFs into a Turbopuffer namespace with per-page text extraction, chunking, OpenAI embeddings, and row upserts.

- Script: `server/ingest/ingest_pdfs.py`
- Deps: `server/ingest/requirements.txt`
- Works with `.env.local` at the project root

### Prerequisites
- Python 3.10+
- Env vars in `.env.local` at the project root:
  - `OPENAI_API_KEY=...`
  - `TURBOPUFFER_API_KEY=...`
  - `TURBOPUFFER_NAMESPACE=_synergy_lava_ridge` (or pass `--namespace`)

### Install
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/ingest/requirements.txt
```

### Dry‑run (no network writes)
Validates parsing/chunking and prints counts.
```bash
source .venv/bin/activate
python3 server/ingest/ingest_pdfs.py \
  --dir "/Users/jeff/Desktop/Focus/projects/synergy/LavaRidge" \
  --project "Lava Ridge" \
  --link "https://eplanning.blm.gov/eplanning-ui/project/2013782/570" \
  --dry-run
```

### Full ingest
Writes to Turbopuffer (namespace is created implicitly on first write).
```bash
source .venv/bin/activate
python3 server/ingest/ingest_pdfs.py \
  --dir "/Users/jeff/Desktop/Focus/projects/synergy/LavaRidge" \
  --project "Lava Ridge" \
  --link "https://eplanning.blm.gov/eplanning-ui/project/2013782/570" \
  --namespace "_synergy_lava_ridge"
```

### Common options
- `--max-pdfs N` limit the number of PDFs (handy for tests)
- `--chunk-size 1800` characters per chunk
- `--chunk-overlap 200` characters overlap between chunks
- `--batch-embed 64` number of chunks per embedding request
- `--write-batch 500` rows per Turbopuffer write

### Idempotency (safe to re‑run)
- Each chunk gets a stable ID derived from a per‑file SHA1, page number, and chunk index.
- Re‑runs use upsert: same IDs are overwritten, no duplicates created.
- Note: changing chunk size/overlap changes chunking and thus IDs.

### Troubleshooting
- 404/422 write errors:
  - Ensure API key is valid and region is correct for your org.
  - Write endpoint used: `POST /v2/namespaces/:namespace` with body `{ upsert_rows, distance_metric }`.
- Verify namespaces:
  ```bash
  curl -s -H "Authorization: Bearer $TURBOPUFFER_API_KEY" \
    https://api.turbopuffer.com/v2/namespaces | jq
  ```

### Verify ingestion (quick query)
Fetch some rows (adjust `top_k` as needed):
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TURBOPUFFER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.turbopuffer.com/v2/namespaces/_synergy_lava_ridge/query" \
  -d '{
    "rank_by": ["id", "asc"],
    "top_k": 5,
    "include_attributes": true
  }' | jq
```

### Notes
- PDF parsing uses `pypdf`’s per‑page `extract_text()`.
- Embeddings use `text-embedding-3-small` (1536 dims).
- Distance metric is `cosine_distance`. Adjust if your namespace uses a different metric.


