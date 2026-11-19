import { z } from "zod";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { expect, it } from "vitest";
import { withPublicToolErrors } from "../src/tools/output-schema";

it("advertises the exact success or error contract without weakening required fields", () => {
  const schema = withPublicToolErrors(z.object({ course: z.object({ id: z.number() }), reused: z.boolean() }));
  const validate = new CfWorkerJsonSchemaValidator().getValidator(z.toJSONSchema(schema));
  for (const [value, valid] of [
    [{ course: { id: 1 }, reused: false }, true],
    [{ status: 403, code: "FORBIDDEN" }, true],
    [{ course: { id: 1 } }, false],
    [{ status: "403", code: "FORBIDDEN" }, false],
    [{ course: { id: 1 }, reused: false, status: 403, code: "FORBIDDEN" }, false],
    [{ status: 403, code: "FORBIDDEN", private: "secret" }, false],
  ] as const) {
    expect(schema.safeParse(value).success).toBe(valid);
    expect(validate(value).valid).toBe(valid);
  }
});
