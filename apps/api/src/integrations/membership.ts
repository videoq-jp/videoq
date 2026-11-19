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

export function membershipService(env: Bindings) {
  return createMembershipService({
    attachTags: (...args) => attachTags(env, ...args),
    detachTag: (...args) => detachTag(env, ...args),
    reorderVideos: (...args) => reorderVideos(env, ...args),
    addVideosBulk: (...args) => addVideosBulk(env, ...args),
    addVideoToCourse: (...args) => addVideoToCourse(env, ...args),
    removeVideoFromCourse: (...args) => removeVideoFromCourse(env, ...args),
  });
}
