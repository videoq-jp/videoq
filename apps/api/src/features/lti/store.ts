export { putCredential, readCredential, recordScopeVideos, consumeLogin,
  consumeCredential, pruneLtiCredentials, putLtiFeedback, replaceCredentialPayload,
} from '../../integrations/lti-credentials';

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}
