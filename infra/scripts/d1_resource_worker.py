"""One-shot private-pipe worker for owned fence operations. No credential lookup.

The parent is trusted reviewed coordinator code, not a security boundary. Never
write plans, provider responses or credentials to stderr/logs. This entry point
is disabled unless explicitly enabled by its private initial protocol message.
"""
import json
import sys
from d1_resource_fence_control import FenceControl, SOURCE, SCHEMA_SQL
from d1_resource_fence_transport import CloudflareFenceQuery
from d1_resource_write_fence import plan_fence

LIMIT = 1024 * 1024


def read_message():
    line = sys.stdin.buffer.readline(LIMIT + 1)
    if not line or len(line) > LIMIT or not line.endswith(b'\n'):
        raise ValueError('RESOURCE_WORKER_MESSAGE_REQUIRED')
    return json.loads(line)


def send(value):
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False)
    if len(raw.encode()) > LIMIT:
        raise ValueError('RESOURCE_WORKER_RESPONSE_LIMIT')
    print(raw, flush=True)


def main():
    sequence = 0
    def check(kind='ownership'):
        nonlocal sequence
        sequence += 1
        send({'event': 'check', 'sequence': sequence, 'kind': kind})
        answer = read_message()
        if answer != {'sequence': sequence, 'allowed': True}:
            raise ValueError('RESOURCE_WORKER_OWNERSHIP_REQUIRED')

    try:
        request = read_message()
        if (not isinstance(request, dict) or set(request) != {'version', 'enabled', 'action', 'input', 'token'}
                or request['version'] != 1 or request['enabled'] is not True or not isinstance(request['input'], dict)):
            raise ValueError('RESOURCE_WORKER_DISABLED')
        action, value = request['action'], request['input']
        if action not in ('ownership-check', 'prepare-fence', 'inspect-source-fence', 'inspect-target-fence', 'install-source-fence', 'remove-target-fence', 'remove-source-fence', 'prepare-copy', 'advance-copy', 'inspect-copy', 'prepare-vectors', 'advance-vectors', 'inspect-vectors'):
            raise ValueError('RESOURCE_WORKER_ACTION_REQUIRED')
        check()
        if action == 'ownership-check':
            result = {'owned': True}
        elif action in ('prepare-vectors', 'advance-vectors', 'inspect-vectors'):
            from d1_resource_vector_runtime import vector_sync
            result = vector_sync(request['token'], value, check, lambda: check('vector-safe'),
                                 prepare=action == 'prepare-vectors', status=action == 'inspect-vectors')
        elif action in ('prepare-copy', 'advance-copy', 'inspect-copy', 'prepare-vectors', 'advance-vectors', 'inspect-vectors'):
            from d1_resource_transfer_runtime import prepare_source_snapshot, run_transfer
            if action == 'prepare-copy':
                result = prepare_source_snapshot(request['token'], value['plan'], check)
            else:
                result = run_transfer(request['token'], value, check,
                                      lambda *_args: check('import-safe'), status_only=action == 'inspect-copy')
        elif action == 'prepare-fence':
            query = CloudflareFenceQuery(request['token'])
            result = plan_fence(query(SOURCE, SCHEMA_SQL), value.get('run'))
        else:
            plan = value['plan']
            mutate = action in ('install-source-fence', 'remove-target-fence', 'remove-source-fence')
            query = CloudflareFenceQuery(request['token'], plan, mutate, allow_source_unfence=action == 'remove-source-fence')
            control = FenceControl(query, check, lambda _plan: check('target-safe'), lambda _plan: check('source-safe'))
            if action == 'install-source-fence':
                result = control.fence_source(plan)
            elif action == 'remove-source-fence':
                result = control.unfence_source(plan)
            elif action == 'remove-target-fence':
                result = control.unfence_target(plan)
            else:
                result = control.observe(plan, target=action == 'inspect-target-fence')
        check()
        send({'event': 'result', 'value': result})
        return 0
    except Exception:
        send({'event': 'error', 'code': 'RESOURCE_WORKER_FAILED'})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
