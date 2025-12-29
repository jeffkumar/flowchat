-- MVP: per-document entity tagging (no new table)
ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "entityName" text;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "entityKind" varchar;

CREATE INDEX IF NOT EXISTS "project_doc_entity_idx"
  ON "ProjectDoc" USING btree ("projectId", "entityKind", "entityName");


