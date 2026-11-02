import { vi } from 'vitest';

// These tests exercise the real graph and model streaming, not database I/O.
// PostgreSQL persistence is covered separately against a real local server.
vi.mock('pg', () => ({ default: { Client: class {} } }));
vi.mock('../../src/repositories/vector-repository', () => ({ openSceneSearch: vi.fn() }));

// Run the compaction/checkpoint tests under workerd as well as Node, including
// native agent persistence, custom events and cancellation.
import '../conversation.test';
