import { Script } from 'node:vm';
import { expect, it } from 'vitest';
import { questionView } from '../src/features/lti/view';
import { authenticationScript, discoveryScript, page, playerScript, popupScript } from '../src/features/classroom/view';
import type { ClassroomLaunch } from '../src/features/classroom/config';
const launch: ClassroomLaunch = { courseId: 'course', itemId: 'item', itemType: 'courseWork', view: 'student', attachmentId: 'attachment', login_hint: '</script><img src=x onerror=alert(1)>' };
function scripts(html: string) {
  const found = [...html.matchAll(/<script nonce="nonce">([\s\S]*?)<\/script>/g)];
  expect(found).toHaveLength(1);return found[0][1];
}
it('renders parseable Classroom and LTI scripts while keeping each transport independent', () => {
  const classroom = questionView('nonce', '', '', 'ja', ['https://classroom.google.com'], { bootstrapScript: authenticationScript(launch), playerScript });
  expect(() => new Script(scripts(classroom))).not.toThrow();
  expect(classroom).not.toContain("fetch('/api/lti/");
  expect(classroom).toContain("fetch('/api/classroom/messages/stream'");
  expect(classroom).toContain('classroomConnect()');expect(classroom).toContain('classroomPlayerInit');
  expect(classroom).not.toContain('</script><img');
  const lti = questionView('nonce', 'state', 'id-token');
  expect(() => new Script(scripts(lti))).not.toThrow();
  expect(lti).not.toContain('classroomConnect');expect(lti).toContain("fetch('/api/lti/session'");
});
it('renders discovery and popup scripts safely and validates message origins and popup source', () => {
  const discovery = page('nonce', 'Classroom', '', discoveryScript({ ...launch, view: 'discovery', attachmentId: undefined, addOnToken: 'token' }));
  expect(() => new Script(scripts(discovery))).not.toThrow();
  expect(discovery).not.toContain('</script><img');
  expect(discovery).toContain('event.origin!==location.origin||event.source!==popup');
  expect(discovery).toContain("window.parent.postMessage({type:'Classroom',action:'closeIframe'},'https://classroom.google.com')");
  expect(() => new Script(scripts(page('nonce', 'Google', '', popupScript)))).not.toThrow();
});
it('requires login_hint before reusing cached identity and does not send an account credential to Classroom', () => {
  const script = authenticationScript(launch);
  expect(script).toContain('if(cached&&classroomLaunch.login_hint)');
  expect(script).toContain("Authorization:'Bearer '+account");
  expect(script).not.toContain('parent.postMessage');
  expect(playerScript).toContain('playback=null');
});
