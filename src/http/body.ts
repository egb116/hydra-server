import type { Context } from "hono";
import type { z } from "zod";
import { BadRequest } from "../lib/errors";

export interface BodyIssue {
  path: string;
  message: string;
}

/**
 * Reads the request body as text and parses it as JSON regardless of the
 * Content-Type header (the app sends none), then validates it.
 * Invalid JSON and schema failures are 400s.
 */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch (err) {
    throw new BadRequest("Could not read the request body", { code: "invalid_body", cause: err });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BadRequest("Request body is not valid JSON", { code: "invalid_json" });
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues: BodyIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw new BadRequest("Invalid request body", { code: "invalid_body", details: issues });
  }
  return parsed.data;
}
