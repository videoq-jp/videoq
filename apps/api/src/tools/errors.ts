/** A public, transport-independent domain error. Infrastructure errors stay private. */
export class ToolError extends Error {
  constructor(message: string, public readonly data: unknown = undefined) {
    super(message);
    this.name = "ToolError";
  }
}
