import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_USER_ID, testAuthHeaders } from "./helpers/auth";
import { requestTrpc, trpcData, trpcError } from "./helpers/trpc";

const service = vi.hoisted(() => ({
  inviteCourseMembers: vi.fn(),
  getCourseParticipants: vi.fn(),
  previewCourseInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  declineInvitation: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  removeMember: vi.fn(),
  leaveCourse: vi.fn(),
}));

vi.mock("../src/features/course-memberships/service", () => service);
vi.mock("../src/db/pool", () => ({
  withDb: vi.fn(async (_env, callback) => callback({})),
}));
vi.mock("../src/persistence/postgres/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => null) },
  })),
}));

const ENV = {
  ENVIRONMENT: "development",
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
} as never;

const jsonHeaders = {
  ...testAuthHeaders(),
  "content-type": "application/json",
};

describe("course membership routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a batch of email invitations for an authenticated owner", async () => {
    service.inviteCourseMembers.mockResolvedValue({
      results: [
        { email: "a@example.com", status: "queued", invitation_id: 10 },
        { email: "bad", status: "invalid" },
      ],
    });

    const response = await requestTrpc(
      "courseMemberships.invite",
      "mutation",
      { courseId: 5, emails: ["a@example.com", "bad"] },
      { headers: jsonHeaders },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await trpcData(response)).toEqual({
      results: [
        { email: "a@example.com", status: "queued", invitation_id: 10 },
        { email: "bad", status: "invalid" },
      ],
    });
    expect(service.inviteCourseMembers).toHaveBeenCalledWith(
      ENV,
      5,
      TEST_USER_ID,
      ["a@example.com", "bad"],
    );
  });

  it("passes an overlong address to per-recipient validation without rejecting valid peers", async () => {
    const overlong = `${"a".repeat(250)}@example.com`;
    service.inviteCourseMembers.mockResolvedValue({
      results: [
        { email: overlong, status: "invalid" },
        { email: "valid@example.com", status: "queued", invitation_id: 12 },
      ],
    });

    const response = await requestTrpc(
      "courseMemberships.invite",
      "mutation",
      { courseId: 5, emails: [overlong, "valid@example.com"] },
      { headers: jsonHeaders },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(service.inviteCourseMembers).toHaveBeenCalledWith(
      ENV,
      5,
      TEST_USER_ID,
      [overlong, "valid@example.com"],
    );
  });

  it("returns a public masked invitation preview without authentication", async () => {
    service.previewCourseInvitation.mockResolvedValue({
      course_id: 5,
      course_name: "Physics",
      inviter_name: "Teacher",
      email_hint: "s*****t@example.com",
      status: "pending",
      expires_at: "2026-08-29T00:00:00.000Z",
    });

    const response = await requestTrpc(
      "courseMemberships.preview",
      "query",
      { token: "public-token" },
      {},
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await trpcData(response)).toMatchObject({
      course_name: "Physics",
      email_hint: "s*****t@example.com",
      status: "pending",
    });
  });

  it("creates membership only through the authenticated accept endpoint", async () => {
    service.acceptInvitation.mockResolvedValue({ ok: true, courseId: 5 });

    const response = await requestTrpc(
      "courseMemberships.accept",
      "mutation",
      { token: "public-token" },
      { headers: testAuthHeaders() },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await trpcData(response)).toEqual({ course_id: 5, status: "accepted" });
    expect(service.acceptInvitation).toHaveBeenCalledWith(
      ENV,
      "public-token",
      TEST_USER_ID,
    );
  });

  it("rejects acceptance by an account with a different verified email", async () => {
    service.acceptInvitation.mockResolvedValue({ emailMismatch: true });

    const response = await requestTrpc(
      "courseMemberships.accept",
      "mutation",
      { token: "public-token" },
      { headers: testAuthHeaders() },
      ENV,
    );

    expect(response.status).toBe(403);
    expect(await trpcError(response)).toMatchObject({
      code: "INVITATION_EMAIL_MISMATCH",
    });
  });

  it("requires authentication for accepting an invitation", async () => {
    const response = await requestTrpc(
      "courseMemberships.accept",
      "mutation",
      { token: "public-token" },
      {},
      ENV,
    );

    expect(response.status).toBe(401);
    expect(service.acceptInvitation).not.toHaveBeenCalled();
  });
});
