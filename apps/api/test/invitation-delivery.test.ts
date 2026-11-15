import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  recordInvitationDeliveryOutcomes: vi.fn(),
  rotateInvitationTokenForDelivery: vi.fn(),
}));
const mail = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("../src/repositories/course-invitation-repository", () => repo);
vi.mock("../src/lib/mail", () => mail);

import { deliverInvitationEmail } from "../src/lib/invitation-delivery";

const ENV = { FRONTEND_URL: "https://videoq.example" } as never;
const NOW = new Date("2026-08-22T00:00:00.000Z");
const LEASE = { id: 77, attempt: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  // mockRejectedValue は clearAllMocks では消えないため、実装ごと戻す。
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue(undefined);
  repo.recordInvitationDeliveryOutcomes.mockReset();
  repo.recordInvitationDeliveryOutcomes.mockResolvedValue(undefined);
});

describe("deliverInvitationEmail", () => {
  it("送信直前にトークンを発行し、そのトークンだけをメールに載せる", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({
      email: "a@example.com",
      courseName: "Physics",
      inviterName: "Teacher",
    });

    const result = await deliverInvitationEmail(ENV, 10, LEASE, NOW);

    expect(result).toEqual({ delivered: true });
    const storedHash = repo.rotateInvitationTokenForDelivery.mock.calls[0][2];
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

    const lines = (mail.sendMail.mock.calls[0][3] as string[]).join("\n");
    expect(lines).toContain("https://videoq.example/course-invitations/");
    // メール本文に載るのは平文トークン。保存されるのはその hash だけ。
    const token = lines.match(/course-invitations\/([^\s]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(lines).not.toContain(storedHash);

    expect(repo.recordInvitationDeliveryOutcomes).toHaveBeenCalledWith(
      ENV,
      [{ invitationId: 10, status: "sent", attemptedAt: NOW }],
      { lease: LEASE, completeTask: true },
    );
  });

  it("送信失敗はfailedとして記録したうえで再スローする", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({
      email: "a@example.com",
      courseName: "Physics",
      inviterName: "Teacher",
    });
    mail.sendMail.mockRejectedValue(new Error("provider unavailable"));

    await expect(deliverInvitationEmail(ENV, 10, LEASE, NOW)).rejects.toThrow(
      "INVITATION_EMAIL_DELIVERY_FAILED",
    );
    expect(repo.recordInvitationDeliveryOutcomes).toHaveBeenCalledWith(ENV, [
      expect.objectContaining({ invitationId: 10, status: "failed" }),
    ], { lease: LEASE });
  });

  it("does not retain a generated invitation link echoed by a failing mail transport", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({ email: "a@example.com", courseName: "Physics", inviterName: "Teacher" });
    let privateMessage = "";
    mail.sendMail.mockImplementationOnce((_env, _email, _subject, lines: string[]) => {
      privateMessage = lines.join("\n");
      return Promise.reject(new Error(privateMessage));
    });
    const failure = await deliverInvitationEmail(ENV, 10, LEASE, NOW).catch(error => error);
    const link = privateMessage.split("\n").find(line => line.includes("/course-invitations/"));
    expect(link).toBeTruthy();
    expect(repo.recordInvitationDeliveryOutcomes).toHaveBeenCalledWith(ENV, [
      expect.objectContaining({ invitationId: 10, status: "failed", error: "INVITATION_EMAIL_DELIVERY_FAILED" }),
    ], { lease: LEASE });
    expect(JSON.stringify(repo.recordInvitationDeliveryOutcomes.mock.calls)).not.toContain(link);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(link);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("取り消された招待にはメールを送らない", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({
      invalidState: "revoked",
    });

    const result = await deliverInvitationEmail(ENV, 10, LEASE, NOW);

    expect(result).toEqual({ skipped: true, reason: "revoked" });
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(repo.recordInvitationDeliveryOutcomes).not.toHaveBeenCalled();
  });

  it("削除済みの招待も同様にスキップする", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({ notFound: true });

    const result = await deliverInvitationEmail(ENV, 10, LEASE, NOW);

    expect(result).toEqual({ skipped: true, reason: "notFound" });
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});

describe("配送タスクの完了", () => {
  it("成功時は配信結果とタスク完了を同じ書き込みにまとめる", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({
      email: "a@example.com",
      courseName: "Physics",
      inviterName: "Teacher",
    });

    await deliverInvitationEmail(ENV, 10, LEASE, NOW);

    expect(repo.recordInvitationDeliveryOutcomes).toHaveBeenCalledWith(
      ENV,
      [{ invitationId: 10, status: "sent", attemptedAt: NOW }],
      { lease: LEASE, completeTask: true },
    );
  });

  it("送信失敗時はタスクを完了させない（再試行させる）", async () => {
    repo.rotateInvitationTokenForDelivery.mockResolvedValue({
      email: "a@example.com",
      courseName: "Physics",
      inviterName: "Teacher",
    });
    mail.sendMail.mockRejectedValue(new Error("provider unavailable"));

    await expect(
      deliverInvitationEmail(ENV, 10, LEASE, NOW),
    ).rejects.toThrow("INVITATION_EMAIL_DELIVERY_FAILED");

    const call = repo.recordInvitationDeliveryOutcomes.mock.calls[0];
    expect(call[2]).toEqual({ lease: LEASE });
  });
});
