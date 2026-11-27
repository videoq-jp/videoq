import { beforeEach, describe, expect, it, vi } from "vitest";
import { addVideosToCourseBulk } from "../src/features/membership/service";
import { addVideosBulk } from "../src/repositories/membership-repository";
import type { Bindings } from "../src/types/bindings";

vi.mock("../src/repositories/membership-repository");
vi.mock('../src/integrations/course-skill-inputs', () => ({ notifyCourseSkillInput: vi.fn().mockResolvedValue(undefined) }));

describe("bulk course membership counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([0, 1, 2])("includes concurrent additions in the skipped count when %i videos were inserted", async (added) => {
    vi.mocked(addVideosBulk).mockResolvedValue({ added });
    const result = await addVideosToCourseBulk({} as Bindings, "owner", 42, [1, 2, 2, 3]);
    expect(result).toMatchObject({ ok: true, added_count: added, skipped_count: 4 - added });
    expect(addVideosBulk).toHaveBeenCalledExactlyOnceWith({}, 42, [1, 2, 2, 3], "owner");
  });
});
