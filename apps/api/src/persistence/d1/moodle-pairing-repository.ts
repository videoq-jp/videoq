import type {Bindings} from '../../types/bindings';
import type {MoodlePairingRepository} from '../contracts/moodle-pairing-repository';
import {LmsSyncError} from '../../features/lms/resource';
import {ltiMaterialsEnabled} from '../../features/lti/config';
import {digest} from '../../features/lti/store';
import {hasSecretEncryptionKey} from '../../lib/secret-encryption';
import {identity,parseKeys,parseStoredToolKeyRing,generateEncryptedToolKeyRing} from '../../shared/lti-tool-keyring';
import {pairingPayloadSchema,requireProof,PAIRING_SECONDS} from '../../shared/moodle-pairing-policy';
const ACTIVE=`owner.is_active=1 AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now'))`;
const ownerActive='EXISTS(SELECT 1 FROM users owner WHERE owner.id=? AND '+ACTIVE+')';
type Predicate={sql:string;values:unknown[]};
const and=(...terms:Predicate[]):Predicate=>({sql:terms.map(p=>`(${p.sql})`).join(' AND '),values:terms.flatMap(p=>p.values)});
export function createD1MoodlePairingRepository(database:D1Database,env:Bindings):MoodlePairingRepository {
  return {
    async issue(input){
      if(!await database.prepare(`SELECT id FROM users owner WHERE id=? AND ${ACTIVE}`).bind(input.ownerUserId).first())throw new LmsSyncError(403,'INACTIVE_ACCOUNT');
      // A competing first initializer can win while RSA generation runs. Retry only
      // the key comparison; no code or owner pointer is written by a losing batch.
      for(let attempt=0;attempt<3;attempt++){
        let encrypted:string|null=null;
        let candidate=false;
        if(input.payload.mode==='materials'){
          if(env.LTI_TOOL_KEYS?.trim())parseKeys(env.LTI_TOOL_KEYS);
          else{
            if(!hasSecretEncryptionKey(env))throw new Error('LTI signing keys are unavailable');
            try{
              encrypted=await database.prepare('SELECT encrypted_key_ring FROM lti_tool_keys WHERE id=?').bind(identity).first<string>('encrypted_key_ring');
              if(encrypted)await parseStoredToolKeyRing(env,encrypted);
              else{encrypted=await generateEncryptedToolKeyRing(env);candidate=true;}
            }catch{throw new Error('LTI signing-key initialization failed');}
          }
        }
        const token=crypto.randomUUID();
        const guard=and({sql:ownerActive,values:[input.ownerUserId]},encrypted?{sql:'EXISTS(SELECT 1 FROM lti_tool_keys WHERE id=? AND encrypted_key_ring=?)',values:[identity,encrypted]}:{sql:'1',values:[]});
        const batch:D1PreparedStatement[]=[];
        if(candidate)batch.push(database.prepare(`INSERT INTO lti_tool_keys(id,encrypted_key_ring) SELECT ?,? WHERE ${ownerActive} ON CONFLICT(id) DO NOTHING`).bind(identity,encrypted,input.ownerUserId));
        batch.push(database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'pairing_issue',0 WHERE ${guard.sql}`).bind(token,...guard.values),
          database.prepare("DELETE FROM lti_credentials WHERE id=? AND kind='moodle-pairing' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)").bind(input.ownerKey,token),
          database.prepare("INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT ?,'moodle-pairing-code',?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
            .bind(input.codeHash,JSON.stringify(input.payload),new Date(input.expiresAt).toISOString(),token),
          database.prepare("INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT ?,'moodle-pairing',?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
            .bind(input.ownerKey,JSON.stringify({codeHash:input.codeHash}),new Date(input.expiresAt).toISOString(),token),
          database.prepare(`SELECT EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AS issued,(${ownerActive}) AS active`).bind(token,input.ownerUserId),
          database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token));
        const result=await database.batch<{issued:number;active:number}>(batch);
        const row=result[result.length-2].results[0];if(row.issued)return;
        if(!row.active)throw new LmsSyncError(403,'INACTIVE_ACCOUNT');
      }
      throw new Error('LTI signing-key initialization failed');
    },
    async exchange(input,codeHash,receiptId){
      if(input.mode==='materials' && !ltiMaterialsEnabled(env))throw new LmsSyncError(403,'LTI_MATERIALS_DISABLED');
      const snapshots=await database.batch<{payload:string}>([
        database.prepare("SELECT payload FROM lti_credentials WHERE id=? AND kind='materials-pairing' AND julianday(expires_at)>julianday('now')").bind(receiptId),
        database.prepare("SELECT payload FROM lti_credentials WHERE id=? AND kind='moodle-pairing-code' AND julianday(expires_at)>julianday('now')").bind(codeHash),
      ]);
      const receiptRaw=snapshots[0].results[0]?.payload;
      const receipt=receiptRaw?JSON.parse(receiptRaw) as Record<string,unknown>:null;
      const canReplay=input.mode==='materials' && receipt?.issuer===input.issuer && receipt.clientId===input.clientId && receipt.deploymentId===input.deploymentId;
      const rawCode=snapshots[1].results[0]?.payload;
      const parsed=pairingPayloadSchema.safeParse(rawCode?JSON.parse(rawCode):undefined);
      const payload=parsed.success && parsed.data.moodleUrl===input.issuer && parsed.data.mode===input.mode?parsed.data:null;
      if(!canReplay && !payload)throw new LmsSyncError(401,'INVALID_PAIRING_CODE');
      const challenge=canReplay?receipt.codeChallenge:payload!.codeChallenge;
      await requireProof(challenge,input.codeVerifier);
      const ownerId=payload?.ownerUserId??null;
      const ownerKey=ownerId?await digest('moodle-pairing-owner:'+ownerId):'';
      const replay:Predicate=input.mode==='materials'?{
        sql:`EXISTS(SELECT 1 FROM lti_credentials r WHERE r.id=? AND r.kind='materials-pairing' AND julianday(r.expires_at)>julianday('now')
          AND json_extract(r.payload,'$.issuer')=? AND json_extract(r.payload,'$.clientId')=? AND json_extract(r.payload,'$.deploymentId')=?
          AND json_extract(r.payload,'$.codeChallenge') IS ? ${canReplay?'AND r.payload=?':''})`,
        values:[receiptId,input.issuer,input.clientId,input.deploymentId,challenge??null,...(canReplay?[receiptRaw]:[])],
      }:{sql:'0',values:[]};
      const connection:Predicate={sql:`EXISTS(SELECT 1 FROM lms_installations connection JOIN users owner ON owner.id=connection.owner_user_id
        JOIN lti_credentials r ON r.id=? WHERE connection.id=json_extract(r.payload,'$.installationId') AND connection.active=1 AND ${ACTIVE}
        AND (? IS NULL OR owner.id=?))`,values:[receiptId,canReplay?null:ownerId,canReplay?null:ownerId]};
      const code:Predicate=payload?{sql:"EXISTS(SELECT 1 FROM lti_credentials WHERE id=? AND kind='moodle-pairing-code' AND julianday(expires_at)>julianday('now') AND payload=?)",values:[codeHash,rawCode]}:{sql:'0',values:[]};
      const active:Predicate={sql:ownerActive,values:[ownerId]};
      const pointer:Predicate={sql:"EXISTS(SELECT 1 FROM lti_credentials WHERE id=? AND kind='moodle-pairing' AND julianday(expires_at)>julianday('now') AND json_extract(payload,'$.codeHash')=?)",values:[ownerKey,codeHash]};
      const conflict:Predicate={sql:'EXISTS(SELECT 1 FROM lms_installations WHERE issuer=? AND client_id=? AND (?<>\'materials\' OR owner_user_id<>?))',values:[input.issuer,input.clientId,input.mode,ownerId]};
      const eligible=and(code,active,pointer,{sql:`NOT (${replay.sql})`,values:replay.values},{sql:`NOT (${conflict.sql})`,values:conflict.values});
      const token=crypto.randomUUID(),replayToken=token+':replay',candidateId=crypto.randomUUID();
      const syncHash=input.mode==='materials'?null:await digest(input.syncToken!);
      const service=input.materialsService?JSON.stringify(input.materialsService):null;
      const flags=await database.batch<{replay:number;connected:number;code:number;active:number;pointer:number;conflict:number;installationId:string;ownerUserId:string}>([
        database.prepare(`SELECT (${replay.sql}) AS replay,(${connection.sql}) AS connected,(${code.sql}) AS code,(${active.sql}) AS active,(${pointer.sql}) AS pointer,(${conflict.sql}) AS conflict`)
          .bind(...replay.values,...connection.values,...code.values,...active.values,...pointer.values,...conflict.values),
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'pairing_replay',0 WHERE ${and(replay,connection).sql}`).bind(replayToken,...and(replay,connection).values),
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'pairing_exchange',0 WHERE ${eligible.sql}`).bind(token,...eligible.values),
        database.prepare(`UPDATE lms_installations SET name=?,deployment_id=?,authorization_url=?,jwks_url=?,sync_token_hash=?,materials_service=?,active=1
          WHERE issuer=? AND client_id=? AND owner_user_id=? AND ?='materials' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(input.issuer,input.deploymentId,input.issuer+'/mod/lti/auth.php',input.issuer+'/mod/lti/certs.php',syncHash,service,input.issuer,input.clientId,ownerId,input.mode,token),
        database.prepare(`INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash,materials_service)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AND NOT EXISTS(SELECT 1 FROM lms_installations WHERE issuer=? AND client_id=?)`)
          .bind(candidateId,ownerId,input.issuer,input.issuer,input.clientId,input.deploymentId,input.issuer+'/mod/lti/auth.php',input.issuer+'/mod/lti/certs.php',syncHash,service,token,input.issuer,input.clientId),
        database.prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
          SELECT ?,'materials-pairing',json_patch(json_object('installationId',id,'issuer',?,'clientId',?,'deploymentId',?),?),?
          FROM lms_installations WHERE issuer=? AND client_id=? AND ?='materials' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(receiptId,input.issuer,input.clientId,input.deploymentId,JSON.stringify(challenge?{codeChallenge:challenge}:{}),new Date(Date.now()+PAIRING_SECONDS*1000).toISOString(),input.issuer,input.clientId,input.mode,token),
        database.prepare('DELETE FROM lti_credentials WHERE id IN(?,?) AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(codeHash,ownerKey,token),
        database.prepare(`SELECT connection.id AS installationId,connection.owner_user_id AS ownerUserId FROM lms_installations connection WHERE
          (connection.issuer=? AND connection.client_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)) OR
          (connection.id=(SELECT json_extract(payload,'$.installationId') FROM lti_credentials WHERE id=?) AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?))`)
          .bind(input.issuer,input.clientId,token,receiptId,replayToken),
        database.prepare('DELETE FROM mutation_receipts WHERE token IN(?,?)').bind(token,replayToken),
      ]);
      const saved=flags[flags.length-2].results[0];if(saved)return saved;
      const state=flags[0].results[0];
      if(state.replay || !state.code)throw new LmsSyncError(401,'INVALID_PAIRING_CODE');
      if(!state.active)throw new LmsSyncError(403,'INACTIVE_ACCOUNT');
      if(!state.pointer)throw new LmsSyncError(401,'INVALID_PAIRING_CODE');
      if(state.conflict)throw new LmsSyncError(409,'CONNECTION_EXISTS');
      throw new Error('Pairing exchange did not commit');
    },
  };
}
