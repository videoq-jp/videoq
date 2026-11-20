import type { LtiLaunchClaims, LtiLaunchLogin, LtiLaunchRegistration } from '../../application/lti-launch';

const rolePrefix = 'http://purl.imsglobal.org/vocab/lis/v2/membership#';
const allowedRoles = new Set(['Learner', 'Instructor', 'Administrator', 'ContentDeveloper', 'Mentor'].map(role => rolePrefix + role));

/** Accept only a verified launch bound to the initiated login and configured resource. */
export function authorizeLtiLaunch(claims: LtiLaunchClaims, reg: LtiLaunchRegistration, login: LtiLaunchLogin) {
  if (claims.nonce !== login.nonce
    || (claims.authorizedParty !== undefined && claims.authorizedParty !== reg.clientId)
    || (Array.isArray(claims.audience) && claims.audience.length > 1 && claims.authorizedParty !== reg.clientId)
    || claims.messageType !== 'LtiResourceLinkRequest' || claims.version !== '1.3.0'
    || claims.target !== login.target) throw new Error('Invalid LTI launch');
  if (!claims.roles.some(role => allowedRoles.has(role))
    || (login.deploymentHint && login.deploymentHint !== claims.deploymentId)) {
    throw new Error('LTI access is not allowed');
  }
  const binding = reg.resources.find(item => item.deploymentId === claims.deploymentId
    && item.contextId === claims.contextId && item.resourceLinkId === claims.resourceLinkId);
  if (!binding) throw new Error('LTI resource is not configured');
  if (reg.requiresAccessProof && !claims.accessToken) throw new Error('LTI access proof is required');
  return {
    locale: claims.locale, subject: claims.subject, deploymentId: claims.deploymentId,
    contextId: claims.contextId, resourceLinkId: claims.resourceLinkId, roles: claims.roles,
    courseId: binding.courseId,
    ...(reg.serviceAuthority ? { serviceSubject: claims.subject } : {}),
    ...(reg.requiresAccessProof ? { accessProof: { token: claims.accessToken!, subject: claims.subject } } : {}),
    ...(binding.videoId ? { videoId: binding.videoId } : {}),
    ...(binding.generation ? { resourceGeneration: binding.generation } : {}),
  };
}
