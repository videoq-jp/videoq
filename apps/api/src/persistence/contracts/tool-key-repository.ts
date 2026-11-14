/** Only encrypted key rings cross the persistence boundary. */
export interface ToolKeyRepository {
  readEncrypted():Promise<string|null>;
  initializeEncrypted(candidate:string):Promise<string>;
}
