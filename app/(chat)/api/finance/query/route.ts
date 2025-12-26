import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  financeGroupByMerchant,
  financeGroupByMonth,
  financeList,
  financeSum,
} from "@/lib/db/queries";

const DocumentTypeSchema = z.enum(["bank_statement", "cc_statement", "invoice"]);

const FiltersSchema = z.object({
  doc_ids: z.array(z.string().uuid()).optional(),
  date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vendor_contains: z.string().min(1).max(200).optional(),
  amount_min: z.number().finite().optional(),
  amount_max: z.number().finite().optional(),
});

const BodySchema = z.object({
  query_type: z.enum(["sum", "list", "group_by_month", "group_by_merchant"]),
  document_type: DocumentTypeSchema,
  filters: FiltersSchema.optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { query_type: queryType, document_type: documentType, filters } = parsed.data;

  try {
    if (queryType === "sum") {
      const result = await financeSum({
        userId: session.user.id,
        documentType,
        filters,
      });
      return NextResponse.json(result, { status: 200 });
    }
    if (queryType === "list") {
      const result = await financeList({
        userId: session.user.id,
        documentType,
        filters,
      });
      return NextResponse.json(result, { status: 200 });
    }
    if (queryType === "group_by_month") {
      const result = await financeGroupByMonth({
        userId: session.user.id,
        documentType,
        filters,
      });
      return NextResponse.json(result, { status: 200 });
    }
    const result = await financeGroupByMerchant({
      userId: session.user.id,
      documentType,
      filters,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


