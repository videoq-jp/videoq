import {and,eq,isNull,sql} from 'drizzle-orm';
import {createD1Connection} from '../../db/d1/connection';
import {teachingConnections,lmsInstallations,users} from '../../db/schema/sqlite';
import type {LmsInstallationRepository} from '../contracts/lms-installation-repository';
const ACTIVE=`owner.is_active=1 AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now'))`;
const active=sql`${users.isActive}=1 AND ${users.deactivatedAt} IS NULL AND (${users.banned} IS NOT TRUE OR julianday(${users.banExpires})<=julianday('now'))`;
export function createD1LmsInstallationRepository(database:D1Database):LmsInstallationRepository {
 const db=createD1Connection(database);
 return {
  managementAccess(userId,identity){return (async db=>{
   const [user]=await db.select({role:users.role}).from(users).where(eq(users.id,userId)).limit(1);
   if(!user)return null;
   const [connection]=await db.select({active:sql<boolean>`${lmsInstallations.active} AND ${teachingConnections.active}`.mapWith(Boolean)}).from(lmsInstallations)
    .innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsInstallations.id),eq(teachingConnections.ownerUserId,userId)))
    .where(and(eq(lmsInstallations.issuer,identity.issuer),eq(lmsInstallations.clientId,identity.clientId),eq(lmsInstallations.deploymentId,identity.deploymentId))).limit(1);
   return {systemAdmin:user.role==='admin',connectionActive:connection?.active??null};
  })(db);},
  async insert(p){
   const row=await database.prepare(`INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash,materials_service)
     SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users owner WHERE owner.id=? AND ${ACTIVE}) RETURNING id`)
     .bind(p.id,p.ownerUserId,p.name,p.issuer,p.clientId,p.deploymentId,p.authorizationUrl,p.jwksUrl,p.syncTokenHash,p.materialsService?JSON.stringify(p.materialsService):null,p.ownerUserId).first();
   if(!row)throw new Error('Active VideoQ account not found');
  },
  async authenticate(hash){return (await db.select({id:lmsInstallations.id,issuer:lmsInstallations.issuer,clientId:lmsInstallations.clientId,deploymentId:lmsInstallations.deploymentId})
   .from(lmsInstallations).where(and(eq(lmsInstallations.syncTokenHash,hash),isNull(lmsInstallations.materialsService),eq(lmsInstallations.active,true))).limit(1))[0]??null;},
  async rotate(ownerUserId,installationId,hash){return (await db.update(lmsInstallations).set({syncTokenHash:hash}).where(and(eq(lmsInstallations.id,installationId),eq(lmsInstallations.ownerUserId,ownerUserId),isNull(lmsInstallations.materialsService))).returning({id:lmsInstallations.id}))[0]?.id??null;},
  async disconnect(ownerUserId,installationId){
   const token=crypto.randomUUID();
   const results=await database.batch([
    database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'lms_disconnect',0 FROM lms_installations connection JOIN users owner ON owner.id=connection.owner_user_id
     WHERE connection.id=? AND owner.id=? AND ${ACTIVE}`).bind(token,installationId,ownerUserId),
    database.prepare('UPDATE lms_installations SET active=0 WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(installationId,token),
    database.prepare(`DELETE FROM lti_credentials WHERE kind='moodle-pairing' AND json_extract(payload,'$.codeHash') IN(
     SELECT code.id FROM lti_credentials code JOIN lms_installations connection ON connection.id=? WHERE code.kind='moodle-pairing-code'
     AND json_extract(code.payload,'$.ownerUserId')=? AND json_extract(code.payload,'$.moodleUrl')=connection.issuer)
     AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(installationId,ownerUserId,token),
    database.prepare('SELECT token FROM mutation_receipts WHERE token=?').bind(token),
    database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token),
   ]);
   return Boolean(results[3].results.length);
  },
  async listActive(ownerUserId){return db.select({id:lmsInstallations.id,moodleUrl:lmsInstallations.issuer,active:lmsInstallations.active})
   .from(lmsInstallations).innerJoin(users,eq(users.id,lmsInstallations.ownerUserId)).where(and(eq(lmsInstallations.ownerUserId,ownerUserId),eq(lmsInstallations.active,true),active));},
 };
}
