import { expect, test } from "../fixtures";

test.describe
  .serial("/api/finance/query", () => {
    test("Ada cannot query finance endpoint with invalid body", async ({
      adaContext,
    }) => {
      const response = await adaContext.request.post("/api/finance/query", {
        data: {},
      });
      expect(response.status()).toBe(400);
    });

    test("Ada can query sum with empty data (returns 0)", async ({ adaContext }) => {
      const response = await adaContext.request.post("/api/finance/query", {
        data: {
          query_type: "sum",
          document_type: "bank_statement",
          filters: {
            date_start: "2020-01-01",
            date_end: "2030-01-01",
          },
        },
      });
      expect(response.status()).toBe(200);

      const json = (await response.json()) as {
        query_type: string;
        document_type: string;
        total: string;
        count: number;
      };

      expect(json.query_type).toBe("sum");
      expect(json.document_type).toBe("bank_statement");
      expect(typeof json.total).toBe("string");
      expect(typeof json.count).toBe("number");
    });
  });


