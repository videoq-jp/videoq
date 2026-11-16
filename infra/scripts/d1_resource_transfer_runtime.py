"""Compose owned transfer components under one local executor lock.

No credential discovery, command-line entry point, vector promotion or release.
Opener injection is for HTTP-shaped isolated integration tests only.
"""
from pathlib import Path
from d1_resource_executor_lock import ExecutorLock
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_fence_transport import CloudflareFenceQuery
from d1_resource_verify_transport import CloudflareVerifyQuery
from d1_resource_write_fence import assert_fenced, validate_plan, fingerprint
from d1_resource_verify import inspect_database, assert_identical
from d1_resource_files import PrivateSqlFiles
from d1_resource_dump import validate_sql_dump
from d1_resource_transfer_journal import TransferJournal
from d1_resource_transfer_api import TransferApi
from d1_resource_transfer_control import TransferControl


def prepare_source_snapshot(token, plan, assert_owned, opener=None):
    validate_plan(plan)
    schema_query = CloudflareFenceQuery(token, opener=opener)
    query = CloudflareVerifyQuery(token, plan, opener=opener)
    def fenced():
        assert_owned()
        assert_fenced(schema_query(SOURCE, SCHEMA_SQL), plan)
    return inspect_database(query, SOURCE, fenced)


def run_transfer(token, config, assert_owned, assert_import_safe, status_only=False, opener=None):
    if (not isinstance(config, dict) or set(config) != {'run', 'source', 'planSha256', 'fencePlan', 'sourceSnapshot', 'directory'}
            or not callable(assert_owned) or not callable(assert_import_safe) or type(status_only) is not bool):
        raise ValueError('RESOURCE_TRANSFER_RUNTIME_CONTEXT_REQUIRED')
    plan = config['fencePlan']
    validate_plan(plan)
    if plan['owner'] != config['run']:
        raise ValueError('RESOURCE_TRANSFER_RUNTIME_OWNER_REQUIRED')
    assert_owned()
    with ExecutorLock(config['directory']) as lock:
        def owned():
            lock.check()
            assert_owned()
        owned()
        files = PrivateSqlFiles(config['directory'], opener=opener)
        journal_root = Path(config['directory']) / 'transfer-journal'
        if not status_only:
            journal_root.mkdir(mode=0o700, exist_ok=True)
            files.sync_directory()
        elif not journal_root.exists():
            return {'phase': None, 'databaseVerified': False, 'reconciliationRequired': False}
        journal = TransferJournal(str(journal_root), config['run'], config['source'], config['planSha256'])
        schema_query = CloudflareFenceQuery(token, opener=opener)
        query = CloudflareVerifyQuery(token, plan, opener=opener)
        def source_fenced():
            owned()
            assert_fenced(schema_query(SOURCE, SCHEMA_SQL), plan)
        def target_fenced():
            owned()
            assert_fenced(schema_query(TARGET, SCHEMA_SQL), plan)
        def import_safe(action, etag, filename):
            owned()
            assert_import_safe(action, etag, filename)
            source_fenced()
            # Reuse is permitted only before an import starts; a populated or
            # partial target must be reconciled, never imported over again.
            rows = schema_query(TARGET, SCHEMA_SQL)
            if any(row['type'] == 'table' and not row['name'].startswith(('sqlite_', '_cf_')) for row in rows):
                raise ValueError('RESOURCE_TRANSFER_TARGET_NOT_EMPTY')
            records = {row['phase']: row['value'] for row in journal.read()}
            proof = files.inspect()
            if (records.get('downloaded') != proof or records.get('dump-verified', {}).get('fileSha256') != proof['sha256']
                    or records['dump-verified'].get('verified') is not True or proof['md5'] != etag):
                raise ValueError('RESOURCE_TRANSFER_FILE_NOT_VERIFIED')
        def verify_database():
            source = inspect_database(query, SOURCE, source_fenced)
            assert_identical(config['sourceSnapshot'], source)
            target = inspect_database(query, TARGET, target_fenced)
            return assert_identical(source, target)
        records = journal.read()
        if status_only:
            phase = records[-1]['phase'] if records else None
            if phase == 'database-verified':
                proof = verify_database()
                if records[-1]['value'] != proof:
                    raise ValueError('RESOURCE_TRANSFER_DATABASE_PROOF_CHANGED')
                return {'phase': phase, 'databaseVerified': True, 'receiptSha256': fingerprint(proof), 'reconciliationRequired': False}
            return {'phase': phase, 'databaseVerified': False, 'reconciliationRequired': phase in ('export-intent', 'ingest-intent')}
        api = TransferApi(token, owned, source_fenced, import_safe, opener=opener)
        control = TransferControl(journal, api, files,
                                  lambda proof: validate_sql_dump(files, proof, config['sourceSnapshot'], plan, owned),
                                  verify_database, owned)
        result = control.run_next()
        owned()
        return result
