"""Fixed-resource D1 fence control; query/ownership are supplied by coordinator.

No credentials, CLI or automatic rollback. Partial writes reconcile exact owned
trigger definitions before retry. Source removal requires separate abort safety.
"""
from d1_resource_write_fence import (
    plan_fence, validate_plan, schema_inventory, quote, fingerprint,
)

SOURCE = 'e57d0931-18cb-4f00-ae7f-b0068030fb04'
TARGET = '587bd210-6d9d-4f32-abb7-a490013e65d3'
SCHEMA_SQL = 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name'


class FenceControl:
    def __init__(self, query, assert_ownership, assert_target_safe, assert_source_safe=None):
        if not all(callable(v) for v in (query, assert_ownership, assert_target_safe)):
            raise ValueError('RESOURCE_FENCE_CONTEXT_REQUIRED')
        if assert_source_safe is not None and not callable(assert_source_safe):
            raise ValueError('RESOURCE_FENCE_CONTEXT_REQUIRED')
        self.assert_source_safe = assert_source_safe
        self.query = query
        self.assert_ownership = assert_ownership
        self.assert_target_safe = assert_target_safe

    def prepare(self, owner):
        return plan_fence(self.query(SOURCE, SCHEMA_SQL), owner)

    def observe(self, plan, target=False):
        validate_plan(plan)
        if type(target) is not bool:
            raise ValueError('RESOURCE_FENCE_TARGET_REQUIRED')
        actual = schema_inventory(self.query(TARGET if target else SOURCE, SCHEMA_SQL))
        original, fences = plan['original'], plan['fenceTriggers']
        if actual['tables'] != original['tables']:
            raise ValueError('RESOURCE_FENCE_SCHEMA_CHANGED')
        installed = {}
        for name, sql in actual['triggers'].items():
            if name in original['triggers'] and sql == original['triggers'][name]:
                continue
            if name not in fences or sql != fences[name]:
                raise ValueError('RESOURCE_FENCE_TRIGGER_CHANGED')
            installed[name] = sql
        if any(actual['triggers'].get(name) != sql for name, sql in original['triggers'].items()):
            raise ValueError('RESOURCE_FENCE_ORIGINAL_TRIGGER_MISSING')
        return {'installed': sorted(installed), 'total': len(fences),
                'schemaSha256': fingerprint(actual)}

    def fence_source(self, plan):
        self.assert_ownership()
        state = self.observe(plan)
        for name, sql in plan['fenceTriggers'].items():
            if name in state['installed']:
                continue
            # Recheck each mutation so a lost response or ownership never permits
            # guessing which triggers exist or overwriting an unexpected trigger.
            self.assert_ownership()
            current = self.observe(plan)
            if name not in current['installed']:
                self.query(SOURCE, sql)
        self.assert_ownership()
        state = self.observe(plan)
        if len(state['installed']) != state['total']:
            raise ValueError('RESOURCE_FENCE_INCOMPLETE')
        return state

    def unfence_target(self, plan):
        self.assert_ownership()
        self.assert_target_safe(plan)
        state = self.observe(plan, target=True)
        for name in state['installed']:
            self.assert_ownership()
            self.assert_target_safe(plan)
            current = self.observe(plan, target=True)
            if name in current['installed']:
                self.query(TARGET, 'DROP TRIGGER ' + quote(name))
        self.assert_ownership()
        self.assert_target_safe(plan)
        state = self.observe(plan, target=True)
        if state['installed']:
            raise ValueError('RESOURCE_TARGET_STILL_FENCED')
        return state

    def unfence_source(self, plan):
        # Only a parent with a durable pre-promotion abort and verified original
        # paused bindings may approve. Default deny; no generic rollback mode.
        if self.assert_source_safe is None:
            raise ValueError('RESOURCE_SOURCE_ABORT_SAFETY_REQUIRED')
        self.assert_ownership()
        self.assert_source_safe(plan)
        state = self.observe(plan)
        for name in state['installed']:
            self.assert_ownership()
            self.assert_source_safe(plan)
            current = self.observe(plan)
            if name in current['installed']:
                self.query(SOURCE, 'DROP TRIGGER ' + quote(name))
        self.assert_ownership()
        self.assert_source_safe(plan)
        state = self.observe(plan)
        if state['installed']:
            raise ValueError('RESOURCE_SOURCE_STILL_FENCED')
        return state
