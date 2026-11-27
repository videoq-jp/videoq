/** Input ports describe plain application data, independent of any transport. */
export type UseCase<Input, Output> = (input: Input) => Promise<Output>;

type Callable = (...args: never[]) => unknown;
export type UseCaseBus<Handlers extends Record<string, Callable>> = {
  execute<Name extends keyof Handlers & string>(
    this: void, name: Name,
    ...input: Parameters<Handlers[Name]>
  ): Promise<Awaited<ReturnType<Handlers[Name]>>>;
};

/** One immutable registry per composition. The bus owns neither runtime config
 * nor adapters; production, in-memory and stub compositions supply them.
 * Variadic inputs preserve existing application ports without DTO duplication.
 */
export function createUseCaseBus<Handlers extends Record<string, Callable>>(
  handlers: Handlers,
): UseCaseBus<Handlers> {
  const registry = Object.freeze({ ...handlers });
  return {
    async execute<Name extends keyof Handlers & string>(this: void, name: Name, ...input: Parameters<Handlers[Name]>): Promise<Awaited<ReturnType<Handlers[Name]>>> {
      if (!Object.hasOwn(registry, name)) throw new Error(`Unregistered use case: ${name}`);
      // Indexing a heterogeneous registry loses the key/argument correlation in
      // TypeScript. Restore that correlation only at this dispatch boundary.
      const handler = registry[name] as (...args: Parameters<Handlers[Name]>) => ReturnType<Handlers[Name]>;
      return await Promise.resolve(handler(...input));
    },
  };
}
