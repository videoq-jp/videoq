import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from './evaluate-policy.mjs';
const at='2026-11-25T12:00:00Z';
const snapshot=(readiness=[],cleanup=[])=>({observedAt:at,readiness,cleanup});
const ready=(overrides={})=>({id:'video-1',currentRevision:'new',transcriptAcceptedAt:'2026-11-25T11:45:00Z',...overrides});
const clean=(overrides={})=>({id:'object-1',scope:'active-object',logicalDeletedAt:'2026-11-25T11:00:00Z',...overrides});
test('readiness target is strict >15m, measures transcript acceptance and current revision',()=>{
 assert.deepEqual(evaluatePolicy(snapshot([ready()])).events,[]);
 assert.equal(evaluatePolicy(snapshot([ready({transcriptAcceptedAt:'2026-11-25T11:44:59Z'})])).events[0].kind,'search_readiness_overdue');
 assert.equal(evaluatePolicy(snapshot([ready({transcriptAcceptedAt:'2026-11-25T11:00:00Z',readyRevision:'old',readyAt:'2026-11-25T11:01:00Z'})])).events[0].kind,'search_readiness_overdue');
 assert.deepEqual(evaluatePolicy(snapshot([ready({readyRevision:'new',readyAt:'2026-11-25T11:50:00Z'})])).events,[]);
 assert.equal(evaluatePolicy(snapshot([ready({transcriptAcceptedAt:'2026-11-25T11:00:00Z',readyRevision:'new',readyAt:'2026-11-25T11:30:00Z'})])).events[0].kind,'search_readiness_target_missed');
});
test('cleanup warns after 1h, escalates after 24h, excludes backups',()=>{
 assert.deepEqual(evaluatePolicy(snapshot([], [clean()])).events,[]);
 assert.equal(evaluatePolicy(snapshot([], [clean({logicalDeletedAt:'2026-11-25T10:59:59Z'})])).events[0].severity,'warning');
 assert.equal(evaluatePolicy(snapshot([], [clean({logicalDeletedAt:'2026-11-24T12:00:00Z'})])).events[0].severity,'warning');
 assert.equal(evaluatePolicy(snapshot([], [clean({logicalDeletedAt:'2026-11-24T11:59:59Z'})])).events[0].severity,'incident');
 assert.deepEqual(evaluatePolicy(snapshot([], [clean({scope:'backup',logicalDeletedAt:'2026-01-01T00:00:00Z'})])).events,[]);
});
test('completion suppresses pending notifications but retains missed target evidence',()=>{
 assert.deepEqual(evaluatePolicy(snapshot([], [clean({completedAt:'2026-11-25T11:30:00Z'})])).events,[]);
 assert.equal(evaluatePolicy(snapshot([], [clean({logicalDeletedAt:'2026-11-24T00:00:00Z',completedAt:'2026-11-25T11:30:00Z'})])).events[0].kind,'active_cleanup_target_missed');
});
test('invalid/future/misordered times fail closed',()=>{
 for(const value of ['nonsense','2027-01-01T00:00:00Z']) assert.throws(()=>evaluatePolicy(snapshot([ready({transcriptAcceptedAt:value})])));
 assert.throws(()=>evaluatePolicy(snapshot([ready({readyRevision:'new',readyAt:'2026-11-25T11:00:00Z'})])));
 assert.throws(()=>evaluatePolicy(snapshot([], [clean({scope:'unknown'})])));
});
