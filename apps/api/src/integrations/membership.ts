import { reorderVideos } from "../repositories/course-repository";
import {
  attachTags,
  detachTag,
  addVideoToCourse,
  removeVideoFromCourse,
  addVideosBulk,
} from "../repositories/membership-repository";
import type { Bindings } from "../types/bindings";

import { createMembershipService } from "../features/membership/core";
import { notifyCourseSkillInput } from './course-skill-inputs';

export function membershipService(env: Bindings) {
  return createMembershipService({
    attachTags: (...args) => attachTags(env, ...args),
    detachTag: (...args) => detachTag(env, ...args),
    reorderVideos: (...args) => reorderVideos(env, ...args),
    addVideosBulk: async (...args) => {
      const result = await addVideosBulk(env, ...args);
      if (!('notFound' in result)) await notifyCourseSkillInput(env, args[0], args[2]);
      return result;
    },
    addVideoToCourse: async (...args) => {
      const result = await addVideoToCourse(env, ...args);
      if (!('notFound' in result)) await notifyCourseSkillInput(env, args[0], args[2]);
      return result;
    },
    removeVideoFromCourse: async (...args) => {
      const result = await removeVideoFromCourse(env, ...args);
      if (!('notFound' in result) && !('notMember' in result)) await notifyCourseSkillInput(env, args[0], args[2]);
      return result;
    },
  });
}
