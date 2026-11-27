import { expect, it } from 'vitest';
import { nativeCourseAccessAllowed, nativeCourseExternalAllowed, type NativeCourseLogic } from '../src/domain/learning/native-course-access';

const logic: NativeCourseLogic<boolean> = { and: (a, b) => a && b, or: (a, b) => a || b };
const bits = [false, true];
for (const independentlyManaged of bits) for (const nativeAccessEnabled of bits) for (const noLmsVideo of bits) {
  it(`checks all native external requirements: ${independentlyManaged}/${nativeAccessEnabled}/${noLmsVideo}`, () => {
    expect(nativeCourseExternalAllowed({ independentlyManaged, nativeAccessEnabled, noLmsVideo }, logic))
      .toBe(independentlyManaged && nativeAccessEnabled && noLmsVideo);
  });
}
for (const usingShare of bits) for (const owner of bits) for (const nativeEnabled of bits) for (const participant of bits) for (const shareMatches of bits) {
  it(`preserves owner/participant/share precedence: ${usingShare}/${owner}/${nativeEnabled}/${participant}/${shareMatches}`, () => {
    expect(nativeCourseAccessAllowed(usingShare, { owner, nativeEnabled, participant, shareMatches }, logic))
      .toBe(usingShare ? nativeEnabled && shareMatches : owner || nativeEnabled && participant);
  });
}
