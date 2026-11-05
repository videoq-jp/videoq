/** Operator-only initial connection. Reuses an existing VideoQ account. */
import { open, readFile } from "node:fs/promises";
import { provisionLmsInstallation, rotateLmsSyncToken } from "../src/repositories/lms-installation-repository";
import type { Bindings } from "../src/types/bindings";

const [command, inputFile, outputFile] = process.argv.slice(2);
if (!["register", "rotate"].includes(command) || !inputFile || !outputFile || !process.env.DATABASE_URL) {
  throw new Error("Usage: DATABASE_URL=... tsx scripts/provision-lms.ts register|rotate INPUT.json NEW_CREDENTIAL_FILE.json");
}
const input: unknown = JSON.parse(await readFile(inputFile, "utf8"));
// Exclusive creation prevents accidental replacement or disclosure through an
// existing symlink. Credentials are never printed to the console or logs.
const output = await open(outputFile, "wx", 0o600);
try {
  const env = { DATABASE_URL: process.env.DATABASE_URL } as Bindings;
  let result;
  if (command === "register") {
    const { provisionInstallationSchema } = await import("../src/features/lms/installation");
    result = await provisionLmsInstallation(env, provisionInstallationSchema.parse(input));
  } else {
    const { z } = await import("zod");
    const args = z.object({ ownerUserId: z.string().min(1), installationId: z.string().min(1) }).strict().parse(input);
    result = await rotateLmsSyncToken(env, args.ownerUserId, args.installationId);
    if (!result) throw new Error("Moodle connection not found for this account");
  }
  await output.writeFile(JSON.stringify(result, null, 2) + "\n");
  console.log("Moodle connection saved; the credential is in the private output file.");
} catch {
  // Query errors can embed SQL parameters. Do not print them, including the
  // hashed credential or connection metadata, in this operator workflow.
  console.error("Could not provision the Moodle connection. Verify the input and existing account, then retry with a new output file.");
  process.exitCode = 1;
} finally { await output.close(); }
