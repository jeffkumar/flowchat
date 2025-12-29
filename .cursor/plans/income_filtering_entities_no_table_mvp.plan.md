## Goals

- **Income / deposits / “how much did we make”** uses **bank statements only** by default (never credit card statements).
- Add **personal vs business + multiple businesses** delineation **at ingest time** with no extra tables.

## Data model (no new table)

Update `ProjectDoc` in [`lib/db/schema.ts`](/Users/jeff/Desktop/Focus/projects/flowchat/lib/db/schema.ts) with:

- `entityName` (nullable `text`) — e.g. `Personal`, `Acme LLC`
- `entityKind` (nullable `varchar` enum: `personal|business`)

Add a migration in [`lib/db/migrations/`](/Users/jeff/Desktop/Focus/projects/flowchat/lib/db/migrations/).

## API endpoints (derived from docs)

Add endpoints under `app/(chat)/api/projects/[projectId]/entities` that operate on **distinct values** in `ProjectDoc`:

- `GET /api/projects/:projectId/entities`
  - returns distinct `{ entityName, entityKind, docCount }` for the project.
- Optional: `POST /api/projects/:projectId/entities/rename`
  - body: `{ fromName, fromKind, toName, toKind }`
  - updates matching `ProjectDoc` rows.

No entity deletion semantics needed for MVP.

## Ingest-time tagging

Plumb `entityName`/`entityKind` through:

- Upload: [`app/(chat)/api/files/upload/route.ts`](/Users/jeff/Desktop/Focus/projects/flowchat/app/(chat)/api/files/upload/route.ts)
- Microsoft import: [`app/(chat)/api/projects/[projectId]/integrations/microsoft/import/route.ts`](/Users/jeff/Desktop/Focus/projects/flowchat/app/(chat)/api/projects/[projectId]/integrations/microsoft/import/route.ts)
- Persist on `createProjectDoc()`.

## Query behavior

- Update finance tools to support filtering by `entityName`/`entityKind`.
- Update “income/deposits/make” routing so it **chooses bank_statement** and excludes cc_statement/invoice.

## UI

- Add an **Entity** selector in the upload/import flows.
- Add a lightweight “Manage entities” (derived list + rename) modal.