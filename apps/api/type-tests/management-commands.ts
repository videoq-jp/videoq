import type { z } from 'zod';
import type { CourseTagCommand } from '../src/application/course-tags';
import type { MaterialCommand, MaterialView } from '../src/application/material-management';
import type { PrivacyRequest } from '../src/domain/lms/privacy';
import type { courseTagInput } from '../src/shared/course-tags';
import type { materialManagementInput, materialView } from '../src/shared/material-management';
import type { privacyRequest } from '../src/shared/privacy';
type Assert<T extends true> = T;
type Compatible<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type TagsMatch = Assert<Compatible<CourseTagCommand, z.infer<typeof courseTagInput>>>;
export type MaterialsMatch = Assert<Compatible<MaterialCommand, z.infer<typeof materialManagementInput>>>;
export type MaterialViewMatches = Assert<Compatible<MaterialView, Awaited<ReturnType<typeof materialView>>>>;
export type PrivacyMatches = Assert<Compatible<PrivacyRequest, z.infer<typeof privacyRequest>>>;

import type { SavedCourseHistory } from '../src/application/course-history';
import type { savedCourseHistory } from '../src/shared/course-history';
export type HistoryRecordMatches = Assert<Compatible<SavedCourseHistory, z.infer<typeof savedCourseHistory>>>;
