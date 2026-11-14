import {ltiConfig,ltiMaterialsEnabled} from '../../../lti/config';
import {presignR2Put} from '../../../../integrations/media';
import {armMaintenance} from '../../../../lib/task-scheduler';
import {createMoodlePairingRepository} from '../../../../persistence/factory';
import {digest,randomSecret} from '../../../lti/store';
import {LmsSyncError} from '../../resource';
import {PAIRING_SECONDS,pairingExchangeSchema,pairingRequestSchema} from '../../../../shared/moodle-pairing-policy';
import type {Bindings} from '../../../../types/bindings';
import type {z} from 'zod';
export {moodleUrlSchema,pairingRequestSchema,pairingExchangeSchema,pairingCodeChallenge,PAIRING_SECONDS} from '../../../../shared/moodle-pairing-policy';
/** No raw code is retained. Its account and exact Moodle base URL are fixed here. */
export async function issueMoodlePairing(env: Bindings, ownerUserId: string, moodleUrl: string, toolOrigin: string, codeChallenge?: string) {
  const mode = ltiMaterialsEnabled(env) ? "materials" : "legacy";
  if (codeChallenge !== undefined && (mode !== "materials" || !pairingRequestSchema.shape.codeChallenge.safeParse(codeChallenge).success)) throw new LmsSyncError(403, "LTI_MATERIALS_DISABLED");
  const secret = randomSecret();
  const expiresAt = new Date(Date.now() + PAIRING_SECONDS * 1000);
  await (await createMoodlePairingRepository(env)).issue({ownerUserId,ownerKey:await digest('moodle-pairing-owner:'+ownerUserId),
    codeHash:await digest('moodle-pairing:'+secret),payload:{ownerUserId,moodleUrl,mode,...(codeChallenge?{codeChallenge}:{})},expiresAt:expiresAt.getTime()});
  // Copyable text, not a URL: credentials never enter request paths or referrers.
  const code = (mode === "materials" ? "VIDEOQ2." : "VIDEOQ1.") + btoa(JSON.stringify({ origin: toolOrigin, secret }));
  return { code, moodleUrl, expiresAt: expiresAt.toISOString() };
}

/** Consuming the code and provisioning the connection commit atomically. */
export async function exchangeMoodlePairing(env: Bindings, rawInput: z.input<typeof pairingExchangeSchema>) {
  const input = pairingExchangeSchema.parse(rawInput);
  const codeHash = await digest("moodle-pairing:" + input.secret);
  const receiptId = await digest("lti-materials-pairing:" + input.secret);
  const settings = async (installationId: string) => {
    const url = new URL(await presignR2Put(env, 'videos/policy', "video/mp4", 1));
    return { installationId, toolOrigin: ltiConfig(env)!.toolOrigin,
      uploadTargets: [{ origin: url.origin, prefix: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) }] };
  };
  const result=await (await createMoodlePairingRepository(env)).exchange(input,codeHash,receiptId);
  if (input.mode === "materials") {
    await armMaintenance(env, Date.now());
    return settings(result.installationId);
  }
  return { installationId: result.installationId };
}
