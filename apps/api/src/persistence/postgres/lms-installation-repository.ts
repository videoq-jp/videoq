import {and,eq,isNull,sql} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {teachingConnections,lmsInstallations,users} from '../../db/schema';
import {activeLmsOwner} from './lms-owner-policy';
import {revokeMoodlePairingPointer} from './moodle-pairing-lifecycle';
import type {Bindings} from '../../types/bindings';
import type {LmsInstallationRepository} from '../contracts/lms-installation-repository';
export function createPostgresLmsInstallationRepository(env:Bindings):LmsInstallationRepository {
 return {
  managementAccess(userId,identity){return withDb(env,async db=>{
   const [user]=await db.select({role:users.role}).from(users).where(eq(users.id,userId)).limit(1);
   if(!user)return null;
   const [connection]=await db.select({active:sql<boolean>`${lmsInstallations.active} AND ${teachingConnections.active}`}).from(lmsInstallations)
    .innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsInstallations.id),eq(teachingConnections.ownerUserId,userId)))
    .where(and(eq(lmsInstallations.issuer,identity.issuer),eq(lmsInstallations.clientId,identity.clientId),eq(lmsInstallations.deploymentId,identity.deploymentId))).limit(1);
   return {systemAdmin:user.role==='admin',connectionActive:connection?.active??null};
  });},
  async insert(registration){await withDb(env,db=>db.transaction(async tx=>{
    const [owner]=await tx.select({id:users.id}).from(users).where(and(eq(users.id,registration.ownerUserId),activeLmsOwner())).for('update');
    if(!owner)throw new Error('Active VideoQ account not found');await tx.insert(lmsInstallations).values(registration);
  }));},
  authenticate(hash){return withDb(env,async db=>(await db.select({id:lmsInstallations.id,issuer:lmsInstallations.issuer,clientId:lmsInstallations.clientId,deploymentId:lmsInstallations.deploymentId})
    .from(lmsInstallations).where(and(eq(lmsInstallations.syncTokenHash,hash),isNull(lmsInstallations.materialsService),eq(lmsInstallations.active,true))).limit(1))[0]??null);},
  rotate(ownerUserId,installationId,hash){return withDb(env,async db=>(await db.update(lmsInstallations).set({syncTokenHash:hash}).where(and(eq(lmsInstallations.id,installationId),eq(lmsInstallations.ownerUserId,ownerUserId),isNull(lmsInstallations.materialsService))).returning({id:lmsInstallations.id}))[0]?.id??null);},
  disconnect(ownerUserId,installationId){return withDb(env,db=>db.transaction(async tx=>{
    const [owner]=await tx.select({id:users.id}).from(users).where(and(eq(users.id,ownerUserId),activeLmsOwner())).for('update');if(!owner)return false;
    const [row]=await tx.update(lmsInstallations).set({active:false}).where(and(eq(lmsInstallations.id,installationId),eq(lmsInstallations.ownerUserId,ownerUserId))).returning({id:lmsInstallations.id,issuer:lmsInstallations.issuer});
    if(row)await revokeMoodlePairingPointer(tx,ownerUserId,row.issuer);return Boolean(row);
  }));},
  listActive(ownerUserId){return withDb(env,db=>db.select({id:lmsInstallations.id,moodleUrl:lmsInstallations.issuer,active:lmsInstallations.active})
    .from(lmsInstallations).innerJoin(users,eq(users.id,lmsInstallations.ownerUserId)).where(and(eq(lmsInstallations.ownerUserId,ownerUserId),eq(lmsInstallations.active,true),activeLmsOwner())));},
 };
}
