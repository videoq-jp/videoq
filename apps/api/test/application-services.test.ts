import { describe, expect, it, vi } from 'vitest';
import { createCourseService } from '../src/features/courses/service';
import { createConversationService, type ConversationDependencies } from '../src/features/chat/conversation-service';
import { createChatHistoryService, type ChatHistoryDependencies } from '../src/features/chat/service';
import { createBillingService, type BillingDependencies } from '../src/features/billing/service';
import { BillingStateChangedError } from '../src/persistence/contracts/billing-repository';
import type { CourseRepository } from '../src/persistence/contracts/course-repository';
import type { ConversationScope, ConversationTurn } from '../src/persistence/contracts/conversation-read';

function courses() {
  return {
    getInfo: vi.fn(), getDetail: vi.fn(), getShared: vi.fn(), create: vi.fn(), update: vi.fn(),
    delete: vi.fn(), reorder: vi.fn(), ownedBy: vi.fn(), setShareSlug: vi.fn(), clearShareSlug: vi.fn(), listPage: vi.fn(),
  } satisfies CourseRepository;
}
function conversations() {
  return {
    conversations: { list: vi.fn(), detail: vi.fn(), delete: vi.fn() },
    courseContext: vi.fn(), feedbackToken: vi.fn(),
  } satisfies ConversationDependencies;
}
function billing() {
  return {
    repository: { findUser: vi.fn(), assignCustomer: vi.fn(), hasEvent: vi.fn(), commitEvent: vi.fn() },
    gateway: {
      configured: true, listPrices: vi.fn(), createCustomer: vi.fn(), createCheckout: vi.fn(),
      createPortal: vi.fn(), retrieveSubscription: vi.fn(),
    },
  } satisfies BillingDependencies;
}

// These tests exercise workflows using only ports; no runtime, DB or SDK mocks.
describe('course application workflow', () => {
  it('hides validation details from someone who does not own the course', async () => {
    const repository = courses();
    repository.ownedBy.mockResolvedValue(false);
    expect(await createCourseService(repository).saveShareLink(1, 'stranger', 'admin')).toEqual({ notFound: true });
    expect(repository.setShareSlug).not.toHaveBeenCalled();
  });

  it('stops an idempotency conflict before loading course details', async () => {
    const repository = courses();
    repository.create.mockResolvedValue({ idempotencyConflict: true });
    const service = createCourseService(repository);
    expect(await service.createUserCourseIdempotent('owner', 'Math', '', {
      action: 'create_course', key: 'retry-key', requestHash: 'different-payload',
    })).toEqual({ idempotencyConflict: true });
    expect(repository.getDetail).not.toHaveBeenCalled();
  });
});

describe('conversation application workflow', () => {
  const scope: ConversationScope = { ownerUserId: 'owner', actorUserId: 'reader', courseId: 1, shareSlug: null };
  const turn: ConversationTurn = {
    id: 'turn', question: 'Why?', answer: { segments: [], sources: [{ id: 1, video_id: 10, title: 'Math', start_time: null, end_time: null }] },
    createdAt: '2026-01-01', chatLogId: 42, feedback: null,
  };

  it('rejects missing identity and malformed share scope before accessing persistence', async () => {
    const deps = conversations();
    const service = createConversationService(deps);
    await expect(service.conversationScope(null, {})).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(service.conversationScope(null, { shareSlug: 'math' })).rejects.toMatchObject({ kind: 'validation' });
    expect(deps.courseContext).not.toHaveBeenCalled();
    expect(deps.conversations.detail).not.toHaveBeenCalled();
  });

  it('resolves a public share without granting the signed-in user owner authority', async () => {
    const deps = conversations();
    deps.courseContext.mockResolvedValue({ id: 1, userId: 'owner', memberVideoIds: [10] });
    expect(await createConversationService(deps).conversationScope('signed-in', { courseId: 1, shareSlug: 'math' }, 'visitor'))
      .toEqual({ ...scope, actorUserId: null, shareSlug: 'math', visitorSessionId: 'visitor' });
    expect(deps.courseContext).toHaveBeenCalledWith({ courseId: 1, userId: null, shareToken: 'math' });
  });

  it('does not return historical sources outside the current LMS video scope', async () => {
    const deps = conversations();
    deps.conversations.detail.mockResolvedValue({ id: 'conversation', turns: [turn], hasMore: false });
    const service = createConversationService(deps);
    for (const resourceVideoIds of [[], [11]]) {
      await expect(service.getConversation({ ...scope, ltiSubject: { subjectKey: 'learner', resourceVideoIds } }, {
        conversationId: 'conversation', limit: 10,
      })).rejects.toMatchObject({ kind: 'not_found', code: 'NOT_FOUND' });
    }
    expect(deps.feedbackToken).not.toHaveBeenCalled();
  });

  it('issues feedback tokens only for share-origin turns with persisted chat logs', async () => {
    const deps = conversations();
    deps.feedbackToken.mockResolvedValue('signed-token');
    deps.conversations.detail.mockResolvedValue({ id: 'conversation', turns: [turn, { ...turn, id: 'unlogged', chatLogId: null }], hasMore: false });
    const result = await createConversationService(deps).getConversation({ ...scope, shareSlug: 'math' }, {
      conversationId: 'conversation', limit: 10,
    });
    expect(result.turns[0]).toMatchObject({ feedbackToken: 'signed-token' });
    expect(result.turns[1]).not.toHaveProperty('feedbackToken');
    expect(result.turns[0]).not.toHaveProperty('createdAt');
    expect(deps.feedbackToken).toHaveBeenCalledExactlyOnceWith(42, 'math');
  });
});

it('rejects forged feedback before any write or history access', async () => {
  const deps = {
    chat: { feedback: vi.fn(), shareExists: vi.fn(), history: vi.fn(), deleteHistory: vi.fn(), analytics: vi.fn() },
    courseOwnedBy: vi.fn(), historyRows: vi.fn(), verifyFeedbackToken: vi.fn().mockResolvedValue(false),
  } satisfies ChatHistoryDependencies;
  expect(await createChatHistoryService(deps).submitFeedback(42, 'good', { shareSlug: 'math', feedbackToken: 'forged' }))
    .toEqual({ forbidden: 'Invalid feedback token' });
  expect(deps.chat.feedback).not.toHaveBeenCalled();
});

describe('billing application workflow', () => {
  const user = { id: 'owner', email: 'owner@example.test', stripeCustomerId: 'customer', stripeSubscriptionId: 'new', planCode: 'pro', subscriptionStatus: 'active', revision: 'r1' };
  const event = { id: 'event', type: 'customer.subscription.updated', target: { customerId: 'customer', subscriptionId: 'old' } };

  it('deduplicates before inspecting a redelivered event payload or calling the provider', async () => {
    const deps = billing();
    deps.repository.hasEvent.mockResolvedValue(true);
    const target = vi.fn(() => { throw new Error('Do not inspect a duplicate payload'); });
    await createBillingService(deps).handleBillingEvent({ id: 'duplicate', type: event.type, get target() { return target(); } });
    expect(target).not.toHaveBeenCalled();
    expect(deps.gateway.retrieveSubscription).not.toHaveBeenCalled();
    expect(deps.repository.commitEvent).not.toHaveBeenCalled();
  });

  it('keeps the current active subscription when a cancellation for an older contract arrives late', async () => {
    const deps = billing();
    deps.repository.findUser.mockResolvedValue(user);
    deps.gateway.retrieveSubscription.mockImplementation(async id => id === 'old'
      ? { id: 'old', customerId: 'customer', status: 'canceled', created: 1, lookupKey: 'basic_monthly' }
      : { id: 'new', customerId: 'customer', status: 'active', created: 2, lookupKey: 'pro_yearly' });
    await createBillingService(deps).handleBillingEvent(event);
    expect(deps.repository.commitEvent).toHaveBeenCalledWith(event, expect.objectContaining({
      expectedRevision: 'r1', patch: expect.objectContaining({ stripeSubscriptionId: 'new', planCode: 'pro', subscriptionStatus: 'active' }),
    }));
  });

  it('re-reads state on optimistic conflicts and bounds reconciliation retries', async () => {
    const deps = billing();
    deps.repository.commitEvent.mockRejectedValue(new BillingStateChangedError());
    await expect(createBillingService(deps).handleBillingEvent({ id: 'event', type: 'unhandled' }))
      .rejects.toBeInstanceOf(BillingStateChangedError);
    expect(deps.repository.hasEvent).toHaveBeenCalledTimes(3);
    expect(deps.repository.commitEvent).toHaveBeenCalledTimes(3);
  });

  it('refuses a mismatched customer subscription without modifying billing state', async () => {
    const deps = billing();
    deps.repository.findUser.mockResolvedValue(user);
    deps.gateway.retrieveSubscription.mockResolvedValue({ id: 'old', customerId: 'another', status: 'active', created: 1 });
    await createBillingService(deps).handleBillingEvent(event);
    expect(deps.repository.commitEvent).toHaveBeenCalledWith(event, null);
  });
});
