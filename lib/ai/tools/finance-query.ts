import { tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import {
  financeGroupByMerchant,
  financeGroupByMonth,
  financeList,
  financeSum,
} from "@/lib/db/queries";

type FinanceQueryProps = {
  session: Session;
  projectId?: string;
};

export const financeQuery = ({ session, projectId }: FinanceQueryProps) =>
  tool({
    description:
      "Run deterministic finance queries over parsed financial documents. Always use this for totals/sums/aggregations; never do math over retrieved chunks. Use filters.amount_min > 0 for deposits-only and filters.amount_max < 0 for withdrawals-only. IMPORTANT: date_end is exclusive; for a month, use the first day of the next month. The 'list' query type returns header fields and line items for invoices, and transaction details (including running balance) for bank statements. When checking for payments, ensure date_start is set to the invoice date or later.",
    inputSchema: z.object({
      query_type: z.enum(["sum", "list", "group_by_month", "group_by_merchant"]),
      document_type: z.enum(["bank_statement", "cc_statement", "invoice"]),
      time_window: z
        .object({
          kind: z.enum(["year", "month"]),
          year: z.number().int().min(1900).max(2200).optional(),
          month: z.number().int().min(1).max(12).optional(),
        })
        .optional(),
      filters: z
        .object({
          doc_ids: z.array(z.string().uuid()).optional(),
          date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          vendor_contains: z.string().min(1).max(200).optional(),
          sender_contains: z.string().min(1).max(200).optional(),
          recipient_contains: z.string().min(1).max(200).optional(),
          amount_min: z.number().finite().optional(),
          amount_max: z.number().finite().optional(),
        })
        .optional(),
    }),
    execute: async (input) => {
      if (!session.user?.id) {
        return { error: "Unauthorized" };
      }

      const nowYear = new Date().getUTCFullYear();
      const filtersFromTimeWindow = (() => {
        if (!input.time_window) return null;

        const year = input.time_window.year ?? nowYear;
        if (input.time_window.kind === "year") {
          const start = `${year}-01-01`;
          const end = `${year + 1}-01-01`;
          return { date_start: start, date_end: end };
        }

        const month = input.time_window.month;
        if (typeof month !== "number") return null;
        const mm = String(month).padStart(2, "0");
        const start = `${year}-${mm}-01`;
        const endYear = month === 12 ? year + 1 : year;
        const endMonth = month === 12 ? 1 : month + 1;
        const endMm = String(endMonth).padStart(2, "0");
        const end = `${endYear}-${endMm}-01`;
        return { date_start: start, date_end: end };
      })();

      const effectiveFilters =
        input.filters || filtersFromTimeWindow
          ? {
              ...(input.filters ?? {}),
              ...(filtersFromTimeWindow ?? {}),
            }
          : undefined;

      console.log("[financeQuery] execute", {
        userId: session.user.id,
        query_type: input.query_type,
        document_type: input.document_type,
        time_window: input.time_window ?? null,
        filters: effectiveFilters ?? null,
      });

      if (input.query_type === "sum") {
        const out = await financeSum({
          userId: session.user.id,
          projectId,
          documentType: input.document_type,
          filters: effectiveFilters,
        });
        console.log("[financeQuery] result", {
          query_type: out.query_type,
          document_type: out.document_type,
          total: out.total,
          count: out.count,
        });
        return out;
      }
      if (input.query_type === "list") {
        const out = await financeList({
          userId: session.user.id,
          projectId,
          documentType: input.document_type,
          filters: effectiveFilters,
        });
        console.log("[financeQuery] result", {
          query_type: out.query_type,
          document_type: out.document_type,
          rowCount: out.rows.length,
        });
        return out;
      }
      if (input.query_type === "group_by_month") {
        const out = await financeGroupByMonth({
          userId: session.user.id,
          projectId,
          documentType: input.document_type,
          filters: effectiveFilters,
        });
        console.log("[financeQuery] result", {
          query_type: out.query_type,
          document_type: out.document_type,
          rowCount: out.rows.length,
        });
        return out;
      }
      const out = await financeGroupByMerchant({
        userId: session.user.id,
        projectId,
        documentType: input.document_type,
        filters: effectiveFilters,
      });
      console.log("[financeQuery] result", {
        query_type: out.query_type,
        document_type: out.document_type,
        rowCount: out.rows.length,
      });
      return out;
    },
  });


