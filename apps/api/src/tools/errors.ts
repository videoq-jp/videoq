/** Public tool-adapter error; infrastructure details stay private. */
export class ToolError extends Error {
  constructor(message: string, public readonly data: unknown = undefined) {
    super(message);
    this.name = "ToolError";
  }
}
