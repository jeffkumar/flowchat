import { type NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { auth } from "@/app/(auth)/auth";
import { getProjectByIdForUser } from "@/lib/db/queries";
import { myProvider } from "@/lib/ai/providers";
import { ChatSDKError } from "@/lib/errors";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";
import {
  formatRetrievedContext,
  queryTurbopuffer,
} from "@/lib/rag/turbopuffer";

export async function POST(request: NextRequest) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { description, projectId, fileType } = body as {
      description?: string;
      projectId?: string;
      fileType?: string;
    };

    if (
      !description ||
      typeof description !== "string" ||
      description.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "Description is required" },
        { status: 400 }
      );
    }

    if (description.length > 2000) {
      return NextResponse.json(
        { error: "Description too long (max 2000 characters)" },
        { status: 400 }
      );
    }

    // Retrieve document context if projectId is provided
    let documentContext = "";
    if (projectId) {
      const project = await getProjectByIdForUser({
        projectId,
        userId: session.user.id,
      });

      if (project) {
        const [docsNamespace] = namespacesForSourceTypes(
          ["docs"],
          project.id,
          project.isDefault
        );

        if (docsNamespace) {
          // Build a query based on the description and file type
          const queryText = fileType
            ? `${description} ${fileType} document extraction schema fields`
            : `${description} document extraction schema fields`;

          const rows = await queryTurbopuffer({
            query: queryText,
            topK: 10,
            namespace: docsNamespace,
          });

          documentContext = formatRetrievedContext(rows);
        }
      }
    }

    const model = myProvider.languageModel("chat-model");

    const systemPrompt = `You are a JSON Schema generator for document extraction workflows.

Given a description of what data should be extracted from documents, generate a valid JSON Schema (draft-07 compatible) that defines the expected output structure.

Rules:
1. Use appropriate types: "string", "number", "boolean", "array", "object"
2. For dates, use "string" with a description mentioning the format (e.g., "YYYY-MM-DD")
3. For currency/money values, use "number"
4. Include helpful descriptions for each field
5. Mark commonly expected fields as required
6. For arrays of objects, define the item schema properly
7. Keep field names in snake_case
8. Be practical - only include fields that make sense for document extraction
9. If document context is provided, analyze the actual document content to understand what fields and data structures exist
10. Tailor the schema to match the patterns and terminology found in the user's actual documents
11. IMPORTANT: Return ONLY valid JSON, no markdown code blocks, no explanations

Example input: "Extract invoice number, vendor name, total amount, and line items with description and price"
Example output:
{
  "type": "object",
  "properties": {
    "invoice_number": { "type": "string", "description": "The unique invoice identifier" },
    "vendor_name": { "type": "string", "description": "Name of the vendor or supplier" },
    "total_amount": { "type": "number", "description": "Total invoice amount" },
    "line_items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": { "type": "string", "description": "Item description" },
          "price": { "type": "number", "description": "Item price" }
        },
        "required": ["description", "price"]
      }
    }
  },
  "required": ["invoice_number", "vendor_name", "total_amount"]
}${documentContext ? `

## Document Context from User's Project
The following are excerpts from documents in the user's project. Use this context to understand the actual data patterns, field names, and structures that appear in their documents:

${documentContext}` : ""}`;

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: `Generate a JSON Schema for the following extraction requirements:\n\n${description.trim()}\n\nRespond with ONLY the JSON schema, no additional text.`,
      maxRetries: 2,
    });

    // Parse the JSON from the response
    let schema: Record<string, unknown>;
    try {
      // Clean up the response - remove markdown code blocks if present
      let jsonText = result.text.trim();
      if (jsonText.startsWith("```json")) {
        jsonText = jsonText.slice(7);
      } else if (jsonText.startsWith("```")) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith("```")) {
        jsonText = jsonText.slice(0, -3);
      }
      jsonText = jsonText.trim();

      schema = JSON.parse(jsonText);
    } catch {
      console.error("[generate-schema] Failed to parse JSON:", result.text);
      return NextResponse.json(
        { error: "Failed to parse generated schema as JSON" },
        { status: 500 }
      );
    }

    // Validate the generated schema is well-formed
    if (
      !schema.properties ||
      typeof schema.properties !== "object" ||
      Object.keys(schema.properties).length === 0
    ) {
      return NextResponse.json(
        { error: "Failed to generate schema with properties" },
        { status: 500 }
      );
    }

    // Ensure it has the expected structure
    if (schema.type !== "object") {
      schema.type = "object";
    }

    return NextResponse.json({ schema }, { status: 200 });
  } catch (error) {
    console.error("[generate-schema] Error:", error);

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate schema",
      },
      { status: 500 }
    );
  }
}
