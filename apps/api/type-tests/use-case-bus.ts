import { createUseCaseBus } from '../src/application/use-case-bus';
const bus = createUseCaseBus({ describe: async (input: { id: number }) => ({ title: String(input.id) }),
  count: async (userId: string, limit: number) => userId.length + limit });
const description: Promise<{ title: string }> = bus.execute('describe', { id: 1 });
const count: Promise<number> = bus.execute('count', 'user', 2);
void [description, count];
function invalidCalls() {
  // @ts-expect-error Wrong input for the registered command.
  void bus.execute('describe', { id: 'one' });
  // @ts-expect-error No unregistered use case can be called.
  void bus.execute('missing', {});
  // @ts-expect-error Output type follows the selected input port.
  const wrong: Promise<string> = bus.execute('count', 'user', 2);
  void wrong;
  // @ts-expect-error Every required application argument is preserved.
  void bus.execute('count', 'user');
}

void invalidCalls;
