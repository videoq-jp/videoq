"""Advance one durable SQL-transfer stage; no loop, credentials or live caller.

The caller supplies the existing owned hold, source snapshot verification and
provider/file adapters. Lost export-start/ingest responses retain intent and
require explicit reconciliation, never a replacement provider operation.
"""
import uuid


class TransferControl:
    def __init__(self, journal, api, files, validate_dump, verify_database, assert_owned):
        if not all(callable(value) for value in (validate_dump, verify_database, assert_owned)):
            raise ValueError('RESOURCE_TRANSFER_CONTROL_CONTEXT_REQUIRED')
        self.journal, self.api, self.files = journal, api, files
        self.validate_dump, self.verify_database, self.owned = validate_dump, verify_database, assert_owned

    def save(self, phase, value):
        self.owned()
        self.journal.save(phase, value)
        self.owned()
        return {'phase': phase, 'databaseVerified': phase == 'database-verified'}

    def response(self, response, operation, bookmark=None):
        if not isinstance(response, dict) or response.get('success') is not True or response.get('type') != operation or response.get('status') not in (None, 'complete'):
            raise ValueError('RESOURCE_TRANSFER_RESPONSE_INVALID')
        found = self.api.bookmark(response.get('at_bookmark'))
        if bookmark is not None and found != bookmark:
            raise ValueError('RESOURCE_TRANSFER_BOOKMARK_CHANGED')
        return found

    def export_response(self, response, bookmark=None):
        found = self.response(response, 'export', bookmark)
        if bookmark is None:
            self.save('export-handle', {'bookmark': found})
        if response.get('status') != 'complete':
            return {'phase': 'export-handle', 'pending': True}
        result = response.get('result')
        if not isinstance(result, dict) or not isinstance(result.get('signed_url'), str):
            raise ValueError('RESOURCE_TRANSFER_EXPORT_URL_REQUIRED')
        return self.save('export-complete', {'bookmark': found, 'signedUrl': result['signed_url']})

    def run_next(self):
        self.owned()
        records = self.journal.read()
        values = {record['phase']: record['value'] for record in records}
        phase = records[-1]['phase'] if records else None
        if phase in ('export-intent', 'ingest-intent'):
            raise ValueError('RESOURCE_TRANSFER_START_RECONCILIATION_REQUIRED')
        if phase is None:
            self.save('export-intent', {'operationId': uuid.uuid4().hex})
            return self.export_response(self.api.export())
        if phase == 'export-handle':
            bookmark = values[phase]['bookmark']
            return self.export_response(self.api.export(bookmark), bookmark)
        if phase == 'export-complete':
            try:
                proof = self.files.inspect()
            except FileNotFoundError:
                proof = self.files.download(values[phase]['signedUrl'], self.owned)
            return self.save('downloaded', proof)
        if phase == 'downloaded':
            proof = self.validate_dump(values[phase])
            if (not isinstance(proof, dict) or proof.get('verified') is not True
                    or proof.get('ownerFenceVerified') is not True
                    or proof.get('fileSha256') != values[phase]['sha256']):
                raise ValueError('RESOURCE_TRANSFER_DUMP_PROOF_REQUIRED')
            return self.save('dump-verified', proof)
        file_proof = values['downloaded']
        if self.files.inspect() != file_proof:
            raise ValueError('RESOURCE_TRANSFER_FILE_CHANGED')
        if phase == 'dump-verified':
            response = self.api.init_import(file_proof['md5'])
            if not isinstance(response.get('filename'), str) or not response['filename']:
                raise ValueError('RESOURCE_TRANSFER_IMPORT_FILE_REQUIRED')
            upload = response.get('upload_url')
            if upload is not None and not isinstance(upload, str):
                raise ValueError('RESOURCE_TRANSFER_UPLOAD_URL_INVALID')
            return self.save('import-initialized', {'filename': response['filename'], 'uploadUrl': upload})
        if phase == 'import-initialized':
            if values[phase]['uploadUrl'] is not None:
                self.files.upload(values[phase]['uploadUrl'], file_proof, self.owned)
            return self.save('uploaded', {'filename': values[phase]['filename'], **file_proof})
        if phase == 'uploaded':
            filename = values[phase]['filename']
            self.save('ingest-intent', {'operationId': uuid.uuid4().hex, 'filename': filename, 'md5': file_proof['md5']})
            response = self.api.ingest(file_proof['md5'], filename)
            bookmark = self.response(response, 'import')
            self.save('import-handle', {'bookmark': bookmark})
            if response.get('status') == 'complete':
                return self.save('import-complete', {'bookmark': bookmark})
            return {'phase': 'import-handle', 'pending': True}
        if phase == 'import-handle':
            bookmark = values[phase]['bookmark']
            response = self.api.poll_import(bookmark)
            self.response(response, 'import', bookmark)
            if response.get('status') != 'complete':
                return {'phase': phase, 'pending': True}
            return self.save('import-complete', {'bookmark': bookmark})
        if phase == 'import-complete':
            proof = self.verify_database()
            if not isinstance(proof, dict) or proof.get('verified') is not True:
                raise ValueError('RESOURCE_TRANSFER_DATABASE_PROOF_REQUIRED')
            return self.save('database-verified', proof)
        if phase == 'database-verified':
            # Revalidate actual target on reentry, not just a historical marker.
            if self.verify_database() != values[phase]:
                raise ValueError('RESOURCE_TRANSFER_DATABASE_PROOF_CHANGED')
            return {'phase': phase, 'databaseVerified': True}
        raise ValueError('RESOURCE_TRANSFER_PHASE_INVALID')
