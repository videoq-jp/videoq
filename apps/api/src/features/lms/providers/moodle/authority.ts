import { courseAuthorityResponse } from '../../contracts';
import { readServiceJson } from '../../connector-client';

export async function resolveMoodleAuthority(issuer: string, request: {
  contextId: string; resourceLinkId: string; accessProof?: { token: string; subject: string };
}) {
  if (!request.accessProof) throw new Error('Moodle access proof required');
  const response = await fetch(issuer.replace(/\/$/, '') + '/local/videoq/access.php', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request.accessProof, contextId: request.contextId, resourceLinkId: request.resourceLinkId,
      includePermissions: true, includeContentManagement: true, includeCourseEntries: true, includeReports: true,
      includeYoutubeSources: true }),
  });
  if (!response.ok) throw new Error('Moodle access denied');
  const access = courseAuthorityResponse.parse(await readServiceJson(response, 512_000));
  if (access.contextId !== request.contextId || access.resourceLinkId !== request.resourceLinkId) throw new Error('Wrong Moodle course');
  return access;
}
