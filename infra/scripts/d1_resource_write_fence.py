"""Plan and verify an owner-bound D1 write fence for resource replacement.

Pure SQL planning only: this module never connects to D1, pauses admissions or
claims a maintenance lock. A reviewed coordinator must own those prerequisites.
"""
import hashlib
import json
import re

PREFIX = 'videoq_resource_fence_'
OPERATIONS = ('INSERT', 'UPDATE', 'DELETE')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def schema_inventory(rows):
    if not isinstance(rows, list):
        raise ValueError('SCHEMA_INVENTORY_REQUIRED')
    tables, triggers = {}, {}
    for row in rows:
        name, kind, sql = row.get('name'), row.get('type'), row.get('sql')
        if not isinstance(name, str) or not name or not isinstance(kind, str):
            raise ValueError('INVALID_SCHEMA_ROW')
        if name.startswith(('sqlite_', '_cf_')):
            continue
        if kind not in ('table', 'trigger'):
            continue
        if not isinstance(sql, str) or not sql:
            raise ValueError('SCHEMA_SQL_REQUIRED')
        if kind == 'table' and re.match(r'\s*CREATE\s+VIRTUAL\s+TABLE\b', sql, re.I):
            raise ValueError('VIRTUAL_TABLE_FENCE_REQUIRES_SEPARATE_DESIGN')
        values = tables if kind == 'table' else triggers
        if name in values:
            raise ValueError('DUPLICATE_SCHEMA_NAME')
        values[name] = sql.rstrip().rstrip(';')
    if not tables:
        raise ValueError('APPLICATION_TABLES_REQUIRED')
    return {'tables': dict(sorted(tables.items())), 'triggers': dict(sorted(triggers.items()))}


def plan_fence(rows, owner):
    if not isinstance(owner, str) or not re.fullmatch('[a-f0-9]{32}', owner):
        raise ValueError('OWNED_MAINTENANCE_RUN_REQUIRED')
    original = schema_inventory(rows)
    if any(name.startswith(PREFIX) for name in original['triggers']):
        raise ValueError('EXISTING_RESOURCE_FENCE_REQUIRES_RECONCILIATION')
    triggers = {}
    for table in original['tables']:
        suffix = hashlib.sha256(table.encode()).hexdigest()[:24]
        for operation in OPERATIONS:
            name = PREFIX + owner + '_' + suffix + '_' + operation.lower()
            triggers[name] = (f'CREATE TRIGGER {quote(name)} BEFORE {operation} ON {quote(table)} '
                              "BEGIN SELECT RAISE(ABORT, 'VIDEOQ_RESOURCE_REPLACEMENT_FENCED'); END")
    if len(triggers) != len(original['tables']) * 3:
        raise ValueError('FENCE_NAME_COLLISION')
    return {'version': 1, 'owner': owner, 'original': original,
            'originalSha256': fingerprint(original), 'fenceTriggers': triggers}


def validate_plan(plan):
    if not isinstance(plan, dict) or plan.get('version') != 1:
        raise ValueError('INVALID_FENCE_PLAN')
    original = plan.get('original', {})
    if plan.get('originalSha256') != fingerprint(original):
        raise ValueError('FENCE_PLAN_CHANGED')
    rows = [{'type': kind, 'name': name, 'sql': sql}
            for field, kind in [('tables', 'table'), ('triggers', 'trigger')]
            for name, sql in original.get(field, {}).items()]
    if plan != plan_fence(rows, plan.get('owner')):
        raise ValueError('FENCE_PLAN_CHANGED')


def install_statements(plan):
    validate_plan(plan)
    return list(plan['fenceTriggers'].values())


def assert_fenced(rows, plan):
    validate_plan(plan)
    actual = schema_inventory(rows)
    expected = {'tables': plan['original']['tables'],
                'triggers': dict(sorted({**plan['original']['triggers'], **plan['fenceTriggers']}.items()))}
    if actual != expected:
        raise ValueError('INCOMPLETE_OR_CHANGED_WRITE_FENCE')
    return {'applicationTables': len(actual['tables']), 'fenceTriggers': len(plan['fenceTriggers']),
            'owner': plan['owner'], 'schemaSha256': fingerprint(actual)}


def removal_statements(rows, plan):
    assert_fenced(rows, plan)
    return ['DROP TRIGGER ' + quote(name) for name in plan['fenceTriggers']]
