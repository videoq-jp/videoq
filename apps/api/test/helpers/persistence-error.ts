import { expect } from "vitest";

/** Drivers and Drizzle expose the same injected DB failure at different depths. */
export async function expectPersistenceFailure(
  operation: Promise<unknown>,
  message: string,
) {
  const failure: unknown = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  const seen = new Set<Error>(),
    messages: string[] = [];
  for (
    let error: unknown = failure;
    error instanceof Error && !seen.has(error);
    error = error.cause
  ) {
    seen.add(error);
    messages.push(error.message);
  }
  expect(messages.join("\n")).toContain(message);
}
