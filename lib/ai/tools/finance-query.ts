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
};

export const financeQuery = ({ session }: FinanceQueryProps) =>
  tool({
    description:
      "Run deterministic finance queries over parsed financial documents. Always use this for totals/sums/aggregations; never do math over retrieved chunks. Use filters.amount_min > 0 for deposits-only and filters.amount_max < 0 for withdrawals-only.",
    inputSchema: z.object({
      query_type: z.enum(["sum", "list", "group_by_month", "group_by_merchant"]),
      document_type: z.enum(["bank_statement", "cc_statement", "invoice"]),
      filters: z
        .object({
          doc_ids: z.array(z.string().uuid()).optional(),
          date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          vendor_contains: z.string().min(1).max(200).optional(),
          amount_min: z.number().finite().optional(),
          amount_max: z.number().finite().optional(),
        })
        .optional(),
    }),
    execute: async (input) => {
      if (!session.user?.id) {
        return { error: "Unauthorized" };
      }

      if (input.query_type === "sum") {
        return await financeSum({
          userId: session.user.id,
          documentType: input.document_type,
          filters: input.filters,
        });
      }
      if (input.query_type === "list") {
        return await financeList({
          userId: session.user.id,
          documentType: input.document_type,
          filters: input.filters,
        });
      }
      if (input.query_type === "group_by_month") {
        return await financeGroupByMonth({
          userId: session.user.id,
          documentType: input.document_type,
          filters: input.filters,
        });
      }
      return await financeGroupByMerchant({
        userId: session.user.id,
        documentType: input.document_type,
        filters: input.filters,
      });
    },
  });


