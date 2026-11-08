import { digest } from '../lti/store';

/** Preserve deployed keys for delimiter-free IDs; encode opaque IDs unambiguously. */
export function materialStateKey(prefix: string, ...parts: (string | number)[]) {
  return digest(parts.every(part => !String(part).includes(':'))
    ? prefix + parts.join(':') : JSON.stringify([prefix, ...parts]));
}
