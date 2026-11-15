import {withClient} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import type {NativeSessionRepository} from '../contracts/native-session-repository';
import {nativeSessionDenied as denied,matchesNativeSession,validateNativeSessionInput} from '../../shared/native-session';
export function createPostgresNativeSessionRepository(env:Bindings):NativeSessionRepository{return {async ensure(input){
 validateNativeSessionInput(input);
  await withClient(env, async client => {
    await client.query("BEGIN");
    try {
      if (!(await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [input.ownerUserId])).rowCount) throw denied();
      const nonce = await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
        VALUES($1,'moodle-native-request','{}',$2) ON CONFLICT DO NOTHING RETURNING id`,
      [input.nonceHash, input.nonceExpiresAt]);
      if (nonce.rowCount !== 1) throw denied();
      const marker = await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
        VALUES($1,'moodle-native-started','{}',$2) ON CONFLICT DO NOTHING RETURNING id`,
      [input.markerHash, new Date(input.expiresAt.getTime() + 120_000)]);
      if (marker.rowCount === 1) {
        const created = await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
          VALUES($1,'session',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
        [input.sessionHash, JSON.stringify(input.grant), input.expiresAt]);
        if (created.rowCount !== 1) throw denied();
      }
      const markerState=await client.query<{kind:string}>('SELECT kind FROM lti_credentials WHERE id=$1 FOR SHARE',[input.markerHash]);
      if(markerState.rows[0]?.kind!=='moodle-native-started')throw denied();
      const existing = await client.query<{ payload: unknown; expiresAt: Date }>(
        `SELECT payload,expires_at AS "expiresAt" FROM lti_credentials
          WHERE id=$1 AND kind='session' AND expires_at>clock_timestamp() FOR SHARE`, [input.sessionHash]);
      if(!matchesNativeSession(existing.rows[0]?.payload,existing.rows[0]?.expiresAt??new Date(NaN),input))throw denied();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}};}
