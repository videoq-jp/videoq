/** Disconnect one owned app, including all resource grants and rotation replay
 * records. Every deletion commits together; an unknown/unowned grant is a no-op. */
export interface OAuthGrantRepository {
  revoke(userId: string, consentId: string): Promise<boolean>;
}
