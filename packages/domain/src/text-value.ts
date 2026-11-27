/** PostgreSQL text/varchar cannot store U+0000; preserve all other Unicode. */
export function textValueFailure(value: string): string | null {
  return value.includes(String.fromCharCode(0)) ? 'Text must not contain NUL characters.' : null;
}
