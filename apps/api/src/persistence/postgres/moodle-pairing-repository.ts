import {and,eq,gt} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {lmsInstallations,ltiCredentials,users} from '../../db/schema';
import {activeLmsOwner} from './lms-owner-policy';
import {ensureToolKeys} from './tool-keys';
import {digest} from '../../features/lti/store';
import {ltiMaterialsEnabled} from '../../features/lti/config';
import {LmsSyncError} from '../../features/lms/resource';
import {pairingPayloadSchema,requireProof,PAIRING_SECONDS} from '../../shared/moodle-pairing-policy';
import type {Bindings} from '../../types/bindings';
import type {MoodlePairingRepository} from '../contracts/moodle-pairing-repository';
export function createPostgresMoodlePairingRepository(env:Bindings):MoodlePairingRepository {
  return {
    async issue(input){
      const {ownerUserId,ownerKey,codeHash,payload}=input;
      const expiresAt=new Date(input.expiresAt);
      await withDb(env,db=>db.transaction(async tx=>{
        const [owner]=await tx.select({id:users.id}).from(users).where(and(eq(users.id,ownerUserId),activeLmsOwner())).for('update');
        if(!owner)throw new LmsSyncError(403,'INACTIVE_ACCOUNT');
        if(payload.mode==='materials')await ensureToolKeys(env,tx);
        await tx.delete(ltiCredentials).where(and(eq(ltiCredentials.kind,'moodle-pairing'),eq(ltiCredentials.id,ownerKey)));
        await tx.insert(ltiCredentials).values({id:codeHash,kind:'moodle-pairing-code',payload,expiresAt});
        await tx.insert(ltiCredentials).values({id:ownerKey,kind:'moodle-pairing',payload:{codeHash},expiresAt});
      }));
    },
    async exchange(input,codeHash,receiptId){
      return withDb(env, db => db.transaction(async tx => {
        if(input.mode==='materials' && !ltiMaterialsEnabled(env))throw new LmsSyncError(403,'LTI_MATERIALS_DISABLED');
        const replay=async()=>{
          if(input.mode!=='materials')return null;
          const [receipt] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, receiptId),
            eq(ltiCredentials.kind, "materials-pairing"), gt(ltiCredentials.expiresAt, new Date())));
          if (receipt && receipt.payload.issuer === input.issuer && receipt.payload.clientId === input.clientId && receipt.payload.deploymentId === input.deploymentId) {
            await requireProof(receipt.payload.codeChallenge, input.codeVerifier);
            const [connection] = await tx.select({ id: lmsInstallations.id, ownerUserId: lmsInstallations.ownerUserId }).from(lmsInstallations)
              .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
              .where(and(eq(lmsInstallations.id, String(receipt.payload.installationId)), eq(lmsInstallations.active, true), activeLmsOwner()));
            if (connection) return { installationId: connection.id, ownerUserId: connection.ownerUserId };
            throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
          }
          return null;
        };
        const prior=await replay();if(prior)return prior;
        const [row] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, codeHash),
          eq(ltiCredentials.kind, "moodle-pairing-code"), gt(ltiCredentials.expiresAt, new Date()))).for("update");
        // A competing exchange can commit while SELECT FOR UPDATE waits, deleting
        // the code and creating the retry receipt. Recheck after that lock wait.
        if(!row){const committed=await replay();if(committed)return committed;}
        const payload = pairingPayloadSchema.safeParse(row?.payload);
        if (!payload.success || payload.data.moodleUrl !== input.issuer || payload.data.mode !== input.mode) throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
        await requireProof(payload.data.codeChallenge, input.codeVerifier);
        const ownerKey = await digest("moodle-pairing-owner:" + payload.data.ownerUserId);
        const [owner] = await tx.select({ id: users.id }).from(users)
          .where(and(eq(users.id, payload.data.ownerUserId), activeLmsOwner())).for("update");
        if (!owner) throw new LmsSyncError(403, "INACTIVE_ACCOUNT");
        // Recheck after locking the owner: a concurrent code issuance can revoke this code.
        const [current] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, ownerKey),
          eq(ltiCredentials.kind, "moodle-pairing"), gt(ltiCredentials.expiresAt, new Date())));
        if (current?.payload.codeHash !== codeHash) throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
        const [existing] = await tx.select({ id: lmsInstallations.id, ownerUserId: lmsInstallations.ownerUserId }).from(lmsInstallations)
          .where(and(eq(lmsInstallations.issuer, input.issuer), eq(lmsInstallations.clientId, input.clientId)));
        if (existing && (input.mode !== "materials" || existing.ownerUserId !== owner.id)) throw new LmsSyncError(409, "CONNECTION_EXISTS");
        const installationId = existing?.id ?? crypto.randomUUID();
        const values = { id: installationId, ownerUserId: owner.id, name: input.issuer,
          issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId,
          authorizationUrl: input.issuer + "/mod/lti/auth.php", jwksUrl: input.issuer + "/mod/lti/certs.php",
          syncTokenHash: input.mode === "materials" ? null : await digest(input.syncToken!),
          ...(input.mode === "materials" ? { materialsService: input.materialsService! } : {}) };
        if (existing) await tx.update(lmsInstallations).set({ ...values, active: true }).where(eq(lmsInstallations.id, existing.id));
        else {
          const inserted=await tx.insert(lmsInstallations).values(values).onConflictDoNothing({target:[lmsInstallations.issuer,lmsInstallations.clientId]}).returning({id:lmsInstallations.id});
          if(!inserted.length)throw new LmsSyncError(409,'CONNECTION_EXISTS');
        }
        if (input.mode === "materials") await tx.insert(ltiCredentials).values({ id: receiptId, kind: "materials-pairing", expiresAt: new Date(Date.now() + PAIRING_SECONDS * 1000),
          payload: { installationId, issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId,
            ...(payload.data.codeChallenge ? { codeChallenge: payload.data.codeChallenge } : {}) } });
        await tx.delete(ltiCredentials).where(eq(ltiCredentials.id, codeHash));
        await tx.delete(ltiCredentials).where(eq(ltiCredentials.id, ownerKey));
        return { installationId, ownerUserId: owner.id };
      }));
    },
  };
}
