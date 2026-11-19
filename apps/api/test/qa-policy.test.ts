import { describe, expect, it } from "vitest";
import { qaBooleanLogic, qaContentAbilities, qaMutationAllowed, qaNativeAccessAllowed, validLtiQaScope, type QaOperation } from "../src/features/qa/policy";

const operations: QaOperation[] = ["qa.ask", "qa.reply", "qa.vote", "qa.feature", "qa.updateQuestion", "qa.deleteQuestion", "qa.updateReply", "qa.deleteReply"];
describe("Q&A business policy", () => {
  it.each([
    { label: "reader", post: false, vote: false, remove: false, moderate: false, own: true, expected: [] },
    { label: "author", post: true, vote: true, remove: true, moderate: false, own: true, expected: ["qa.ask", "qa.reply", "qa.vote", "qa.updateQuestion", "qa.deleteQuestion", "qa.updateReply", "qa.deleteReply"] },
    { label: "peer", post: true, vote: true, remove: true, moderate: false, own: false, expected: ["qa.ask", "qa.reply", "qa.vote"] },
    { label: "moderator without posting rights", post: false, vote: false, remove: false, moderate: true, own: false, expected: ["qa.feature", "qa.deleteQuestion", "qa.deleteReply"] },
    { label: "author with only own deletion", post: false, vote: false, remove: true, moderate: false, own: true, expected: ["qa.deleteQuestion", "qa.deleteReply"] },
    { label: "author without deletion", post: true, vote: false, remove: false, moderate: false, own: true, expected: ["qa.ask", "qa.reply", "qa.updateQuestion", "qa.updateReply"] },
  ])("enforces independent capabilities for $label", row => {
    const permissions = { canPost: row.post, canVote: row.vote, canDeleteOwn: row.remove, canModerate: row.moderate };
    expect(operations.filter(op => qaMutationAllowed(op, permissions, row.own, row.own, qaBooleanLogic))).toEqual(row.expected);
    expect(qaContentAbilities(permissions, row.own, qaBooleanLogic)).toEqual({
      canEdit: row.expected.includes("qa.updateQuestion"), canDelete: row.expected.includes("qa.deleteQuestion"),
    });
  });
  it("distinguishes ownership of a question from ownership of a reply", () => {
    const permissions = { canPost: true, canVote: true, canDeleteOwn: true, canModerate: false };
    expect(qaMutationAllowed("qa.updateQuestion", permissions, true, false, qaBooleanLogic)).toBe(true);
    expect(qaMutationAllowed("qa.updateReply", permissions, true, false, qaBooleanLogic)).toBe(false);
    expect(qaMutationAllowed("qa.deleteQuestion", permissions, false, true, qaBooleanLogic)).toBe(false);
    expect(qaMutationAllowed("qa.deleteReply", permissions, false, true, qaBooleanLogic)).toBe(true);
  });
  it("keeps owner operator access but never bypasses native restrictions through a share", () => {
    const facts = { owner: true, nativeEnabled: false, member: true, shareMatches: true };
    expect(qaNativeAccessAllowed(false, facts, qaBooleanLogic)).toBe(true);
    expect(qaNativeAccessAllowed(true, facts, qaBooleanLogic)).toBe(false);
    expect(qaNativeAccessAllowed(false, { ...facts, owner: false }, qaBooleanLogic)).toBe(false);
    expect(qaNativeAccessAllowed(true, { ...facts, nativeEnabled: true, shareMatches: false }, qaBooleanLogic)).toBe(false);
    expect(qaNativeAccessAllowed(true, { owner: false, nativeEnabled: true, member: false, shareMatches: true }, qaBooleanLogic)).toBe(true);
  });
  it("validates LMS scope without granting native or cross-course access", () => {
    const principal = { kind: "lti", courseId: 1, authorId: "a".repeat(64), videoIds: [], permissions: { view: true } };
    expect(validLtiQaScope(principal, { courseId: 1 })).toBe(true);
    expect(validLtiQaScope(principal, { courseId: 2 })).toBe(false);
    expect(validLtiQaScope(principal, { courseId: 1, shareSlug: "share" })).toBe(false);
    expect(validLtiQaScope({ ...principal, authorId: "invalid" }, { courseId: 1 })).toBe(false);
    expect(validLtiQaScope({ ...principal, permissions: { view: false } }, { courseId: 1 })).toBe(false);
    expect(validLtiQaScope({ ...principal, videoIds: Array.from({ length: 1001 }, (_, i) => i) }, { courseId: 1 })).toBe(false);
  });
});
