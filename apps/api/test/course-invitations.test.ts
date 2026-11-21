import { invitationEmailSchema } from "@videoq/trpc/course-invitations";
import { describe, expect, it } from "vitest";
import {
  effectiveInvitationStatus,
  invitationExpiresAt,
  isInvitationExpired,
  maskInvitationEmail,
  planInvitationEmails,
} from "../src/lib/course-invitations";

describe("course invitation domain", () => {
  it("normalizes valid addresses and preserves first-seen order", () => {
    expect(
      planInvitationEmails([
        " Student@One.EXAMPLE ",
        "second@example.com",
      ]),
    ).toEqual([
      { email: "student@one.example", status: "ready" },
      { email: "second@example.com", status: "ready" },
    ]);
  });

  it("rejects invalid addresses and reports case-insensitive duplicates", () => {
    expect(
      planInvitationEmails([
        "not-an-email",
        "student@example.com",
        "STUDENT@example.com",
        "",
      ]),
    ).toEqual([
      { email: "not-an-email", status: "invalid" },
      { email: "student@example.com", status: "ready" },
      { email: "STUDENT@example.com", status: "duplicate" },
      { email: "", status: "invalid" },
    ]);
  });

  it("uses an exact seven-day lifetime and treats the boundary as expired", () => {
    const issuedAt = new Date("2026-08-22T00:00:00.000Z");
    const expiresAt = invitationExpiresAt(issuedAt);

    expect(expiresAt.toISOString()).toBe("2026-08-29T00:00:00.000Z");
    expect(
      isInvitationExpired(expiresAt, new Date("2026-08-28T23:59:59.999Z")),
    ).toBe(false);
    expect(isInvitationExpired(expiresAt, expiresAt)).toBe(true);
  });

  it("treats only time-expired pending invitations as terminal expired state", () => {
    const now = new Date("2026-08-29T00:00:00.000Z");

    expect(
      effectiveInvitationStatus(
        "pending",
        new Date("2026-08-28T23:59:59.999Z"),
        now,
      ),
    ).toBe("expired");
    expect(
      effectiveInvitationStatus(
        "pending",
        new Date("2026-08-29T00:00:00.001Z"),
        now,
      ),
    ).toBe("pending");
    expect(
      effectiveInvitationStatus(
        "accepted",
        new Date("2026-08-28T00:00:00.000Z"),
        now,
      ),
    ).toBe("accepted");
  });

  it("masks the local part in public invitation previews", () => {
    expect(maskInvitationEmail("student@example.com")).toBe("s*****t@example.com");
    expect(maskInvitationEmail("a@example.com")).toBe("a@example.com");
  });
});

describe("invitation email syntax at the adapter boundary", () => {
  it.each(["a b@example.com", "a\tb@example.com", "a:b@example.com", "a@b-.com", "a@b.-com", `a@${"b".repeat(64)}.com`, "a@@example.com"])("rejects %s without rejecting the valid recipient", invalid => {
    expect(invitationEmailSchema.safeParse(invalid).success).toBe(false);
    expect(planInvitationEmails([invalid, " Valid+tag@Example.COM "])).toEqual([
      { email: invalid, status: "invalid" },
      { email: "valid+tag@example.com", status: "ready" },
    ]);
  });
  it("preserves invitation-specific length limits", () => {
    expect(invitationEmailSchema.safeParse(`${"a".repeat(65)}@example.com`).success).toBe(false);
    expect(invitationEmailSchema.safeParse(`${"a".repeat(64)}@example.com`).success).toBe(true);
  });
});


describe("invitation email length boundaries", () => {
  const domain = `${"b".repeat(63)}.${"c".repeat(63)}.`;
  it.each([
    { length: 254, email: `${"a".repeat(64)}@${domain}${"d".repeat(61)}`, accepted: true },
    { length: 255, email: `${"a".repeat(64)}@${domain}${"d".repeat(62)}`, accepted: false },
  ])("accepts=$accepted at $length normalized characters", ({ email, length, accepted }) => {
    expect(email).toHaveLength(length);
    expect(invitationEmailSchema.safeParse(` ${email.toUpperCase()} `).success).toBe(accepted);
    expect(planInvitationEmails([email])[0].status).toBe(accepted ? "ready" : "invalid");
  });
});
