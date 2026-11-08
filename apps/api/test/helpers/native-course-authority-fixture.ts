import { beforeAll, beforeEach } from 'vitest';
import { withClient } from '../../src/db/pool';
import type { Bindings } from '../../src/types/bindings';

/** Add current authority columns to intentionally sparse native regression
 * fixtures after their own setup. These fixtures contain independent VideoQ
 * data; full migrations and protected Moodle data are tested separately.
 */
export function nativeCourseAuthorityFixture(environment: () => Bindings) {
  const prepare = () => withClient(environment(), client => client.query(`DO $fixture$
    BEGIN
      IF to_regclass('video_courses') IS NOT NULL THEN
        ALTER TABLE video_courses ADD COLUMN IF NOT EXISTS managed_by_lms boolean NOT NULL DEFAULT false;
        ALTER TABLE video_courses ADD COLUMN IF NOT EXISTS native_access_disabled boolean NOT NULL DEFAULT false;
        CREATE TABLE IF NOT EXISTS videos(id bigint PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS video_course_members(course_id bigint, video_id bigint);
      END IF;
      IF to_regclass('videos') IS NOT NULL THEN
        ALTER TABLE videos ADD COLUMN IF NOT EXISTS managed_by_lms boolean NOT NULL DEFAULT false;
      END IF;
    END $fixture$;`));
  beforeAll(prepare);
  beforeEach(prepare);
}
