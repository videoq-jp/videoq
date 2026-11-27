import { expect, it, vi } from 'vitest';
import { resolveCourseAccess } from '../src/features/lti/course-access-service';
import { deniedCoursePermissions, type CourseAccessRegistration, type CourseGrant } from '../src/domain/lms/lms-authority';

const grant: CourseGrant = { deploymentId: 'dep', contextId: 'ctx', resourceLinkId: 'entry', courseId: 1, resourceGeneration: 2 };
const registration: CourseAccessRegistration = { id: 'db:school', resources: [
  { ...grant, kind: 'course', generation: 2 },
  { deploymentId: 'dep', contextId: 'ctx', resourceLinkId: 'video', courseId: 1, videoId: 7, generation: 3, sourceGeneration: 3 },
] };

it('requires a fresh course entry even when visible videos are returned', async () => {
  const requestAuthority = vi.fn().mockResolvedValue({ contextId: 'ctx', resourceLinkId: 'entry', resources: [{ resourceLinkId: 'video', lesson: '1', title: 'Video', generation: 3 }] });
  await expect(resolveCourseAccess(registration, grant, { requestAuthority })).rejects.toThrow('LMS access denied');
});

it('intersects current authority generations with local bindings and keeps management separate', async () => {
  const requestAuthority = vi.fn().mockResolvedValue({ contextId: 'ctx', resourceLinkId: 'entry', courseEntry: { generation: 2 },
    permissions: { ...deniedCoursePermissions, manageContent: true }, resources: [
      { resourceLinkId: 'video', lesson: '1', title: 'Video', generation: 3, learning: false, management: { generation: 3 } },
      { resourceLinkId: 'unknown', lesson: '2', title: 'Unbound', generation: 3 },
      { resourceLinkId: 'video', lesson: '3', title: 'Stale', generation: 1 },
    ] });
  const result = await resolveCourseAccess(registration, grant, { requestAuthority });
  expect(result).toMatchObject({ videos: [], materialOrder: [7], managementVideos: [{ videoId: 7, title: 'Video', sourceGeneration: 3 }] });
});

it('uses the linked teacher-owned course and removes remote management/report privileges', async () => {
  const linked = { id: 'db:school', resources: [{ ...grant, kind: 'linked' as const }] };
  const requestAuthority = vi.fn().mockResolvedValue({ contextId: 'ctx', resourceLinkId: 'entry', courseEntry: { generation: 2 },
    permissions: { ...deniedCoursePermissions, manageContent: true, viewReports: true }, resources: [] });
  const findLinkedCourse = vi.fn().mockResolvedValue({ courseId: 1, ownerUserId: 'owner', teacherSubject: 'teacher', resourceLinkId: 'entry', courseTitle: 'Linked', videos: [{ videoId: 8, title: 'Local video', lesson: '8' }] });
  await expect(resolveCourseAccess(linked, { ...grant, serviceSubject: 'teacher' }, { requestAuthority, findLinkedCourse })).resolves.toMatchObject({ ownerHistory: true, course: { id: 1, userId: 'owner', memberVideoIds: [8] }, permissions: { manageContent: false, viewReports: false } });
  findLinkedCourse.mockResolvedValue(null);
  await expect(resolveCourseAccess(linked, grant, { requestAuthority, findLinkedCourse })).rejects.toThrow('LMS access denied');
});
