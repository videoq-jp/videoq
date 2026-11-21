import contextlib
import io
import json
from pathlib import Path
from urllib.error import HTTPError
import unittest
from unittest.mock import MagicMock, patch
from rotate_api_aws_key import rotate, verify_smoke, require_permissions, patch_worker, smoke_log, USER_ARN, API_POLICY, JOURNAL, RotationGuardError

ROOT = Path(__file__).resolve().parents[2]
OLD = 'AKIA'+'O'*16
NEW = 'AKIA'+'N'*16


class MissingParameter(Exception):
    response = {'Error': {'Code': 'ParameterNotFound'}}


class RotationTests(unittest.TestCase):
    def setup(self):
        self.keys = {OLD: 'Active'}
        self.journal = None
        self.session, self.iam, self.ssm = MagicMock(), MagicMock(), MagicMock()
        self.session.client.side_effect = lambda name: self.iam if name == 'iam' else self.ssm
        self.documents = {'sqs': json.loads((ROOT/'infra/iam/videoq-api-sqs-send.json').read_text()),
                          'sts': json.loads((ROOT/'infra/iam/videoq-openrouter-federation.json').read_text())}
        self.iam.get_user.return_value = {'User': {'Arn': USER_ARN}}
        def paginate(name, **kwargs):
            return [{'AccessKeyMetadata': [{'AccessKeyId': key, 'Status': status} for key, status in self.keys.items()]}] if name == 'list_access_keys' else [{'PolicyNames': list(self.documents)}] if name == 'list_user_policies' else []
        self.iam.get_paginator.side_effect = lambda name: MagicMock(paginate=MagicMock(side_effect=lambda **kw: paginate(name, **kw)))
        self.iam.get_user_policy.side_effect = lambda **kw: {'PolicyDocument': self.documents[kw['PolicyName']]}
        def create(**kwargs):
            self.keys[NEW] = 'Active'
            return {'AccessKey': {'AccessKeyId': NEW, 'SecretAccessKey': 'PRIVATE_NEW_SECRET'}}
        self.iam.create_access_key.side_effect = create
        self.iam.update_access_key.side_effect = lambda **kw: self.keys.update({kw['AccessKeyId']: kw['Status']})
        self.iam.delete_access_key.side_effect = lambda **kw: self.keys.pop(kw['AccessKeyId'])
        def get(**kwargs):
            self.assertEqual(kwargs['Name'], JOURNAL)
            if self.journal is None:
                raise MissingParameter()
            return {'Parameter': {'Value': json.dumps(self.journal)}}
        def put(**kwargs):
            self.assertEqual(kwargs['Name'], JOURNAL)
            self.assertEqual(kwargs['Type'], 'SecureString')
            self.journal = json.loads(kwargs['Value'])
            return {'Version': 1}
        def delete(**kwargs):
            self.assertEqual(kwargs['Name'], JOURNAL)
            self.journal = None
        self.ssm.get_parameter.side_effect = get
        self.ssm.put_parameter.side_effect = put
        self.ssm.delete_parameter.side_effect = delete
        self.env = {'CLOUDFLARE_ACCOUNT_ID': 'a'*32, 'CLOUDFLARE_API_TOKEN': 'PRIVATE_CF', 'GH_TOKEN': 'PRIVATE_GH', 'GITHUB_SHA': 'a'*40}
        self.settings = {'success': True, 'result': {'bindings': [
            {'type': 'plain_text', 'name': 'OPENROUTER_FEDERATION_POLICY_ID', 'text': API_POLICY},
            {'type': 'plain_text', 'name': 'OPENAI_BASE_URL', 'text': 'https://openrouter.ai/api/v1'}]}}
        return contextlib.ExitStack()

    def patches(self, stack):
        stack.enter_context(patch('rotate_api_aws_key.api_json', return_value=self.settings))
        stack.enter_context(patch('rotate_api_aws_key.validate_new_key'))
        self.patch_worker = stack.enter_context(patch('rotate_api_aws_key.patch_worker'))
        self.proof = stack.enter_context(patch('rotate_api_aws_key.verify_smoke'))

    def test_staged_rotation_keeps_old_key_until_two_distinct_verified_smokes(self):
        with self.setup() as stack:
            self.patches(stack)
            result = rotate(self.session, self.env, 'install')
            self.assertEqual(self.keys, {OLD: 'Active', NEW: 'Active'})
            self.assertEqual(result['stage'], 'installed')
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertEqual(self.journal['newSecret'], 'PRIVATE_NEW_SECRET')
            result = rotate(self.session, self.env, 'disable-old', '101')
            self.assertEqual(self.keys[OLD], 'Inactive')
            self.assertEqual(result['stage'], 'old_disabled')
            with self.assertRaises(RotationGuardError):
                rotate(self.session, self.env, 'finalize', '101')
            self.iam.delete_access_key.assert_not_called()
            result = rotate(self.session, self.env, 'finalize', '102')
            self.assertEqual(result['stage'], 'complete')
            self.assertEqual(self.keys, {NEW: 'Active'})
            self.assertIsNone(self.journal)
            self.assertNotIn('PRIVATE', json.dumps(result))

    def test_failed_verification_does_not_disable_old_key(self):
        with self.setup() as stack:
            self.patches(stack)
            rotate(self.session, self.env, 'install')
            self.proof.side_effect = RotationGuardError('NO_PROOF')
            with self.assertRaises(RotationGuardError):
                rotate(self.session, self.env, 'disable-old', '101')
            self.iam.update_access_key.assert_not_called()
            self.assertEqual(self.keys[OLD], 'Active')

    def test_install_retry_reuses_journal_and_does_not_create_another_key(self):
        with self.setup() as stack:
            self.patches(stack)
            self.patch_worker.side_effect = RuntimeError('PRIVATE_FAILURE')
            with self.assertRaises(RuntimeError):
                rotate(self.session, self.env, 'install')
            self.assertEqual(self.journal['stage'], 'created')
            self.assertEqual(self.keys[OLD], 'Active')
            self.patch_worker.side_effect = None
            rotate(self.session, self.env, 'install')
            self.iam.create_access_key.assert_called_once()
            self.assertEqual(self.journal['stage'], 'installed')

    def test_persistence_failure_never_changes_worker_or_disables_existing_key(self):
        with self.setup() as stack:
            self.patches(stack)
            self.ssm.put_parameter.side_effect = RuntimeError('PRIVATE_PERSISTENCE')
            with self.assertRaises(RuntimeError):
                rotate(self.session, self.env, 'install')
            self.patch_worker.assert_not_called()
            self.iam.update_access_key.assert_not_called()
            self.iam.delete_access_key.assert_not_called()
            self.assertEqual(self.keys[OLD], 'Active')

    def test_broader_permissions_stop_rotation_before_key_creation(self):
        with self.setup() as stack:
            self.patches(stack)
            self.documents['sqs']['Statement'][0]['Action'] = 'sqs:*'
            with self.assertRaises(RotationGuardError):
                rotate(self.session, self.env, 'install')
            self.iam.create_access_key.assert_not_called()
            self.patch_worker.assert_not_called()

    def test_inherited_group_policies_require_review(self):
        with self.setup() as stack:
            self.patches(stack)
            original = self.iam.get_paginator.side_effect
            self.iam.get_paginator.side_effect = lambda name: MagicMock(paginate=MagicMock(return_value=[{'Groups': [{'GroupName': 'other'}]}])) if name == 'list_groups_for_user' else original(name)
            with self.assertRaises(RotationGuardError):
                require_permissions(self.iam)
            self.iam.create_access_key.assert_not_called()

    def test_stale_smoke_and_incomplete_qa_are_rejected_without_printing_logs(self):
        run = {'path': '.github/workflows/operations.yml', 'event': 'workflow_dispatch', 'status': 'completed', 'conclusion': 'success', 'created_at': '2026-10-31T04:00:00Z'}
        jobs = {'jobs': [{'id': 999, 'name': 'production-smoke', 'conclusion': 'success'}]}
        logs = b'PRIVATE_LOG VERIFY_AI_ANSWERS: true Production smoke stage: cited-question-answer Production smoke checks: ok Production smoke cleanup: complete'
        with patch('rotate_api_aws_key.api_json', side_effect=[run, jobs]), patch('rotate_api_aws_key.smoke_log', return_value=logs.decode()), contextlib.redirect_stdout(io.StringIO()) as output:
            verify_smoke('123', '2026-10-31T03:00:00Z', 'PRIVATE_TOKEN')
        self.assertEqual(output.getvalue(), '')
        with patch('rotate_api_aws_key.api_json', return_value=run), self.assertRaises(RotationGuardError):
            verify_smoke('123', '2026-10-31T05:00:00Z', 'PRIVATE_TOKEN')
        with patch('rotate_api_aws_key.api_json', side_effect=[run, jobs]), patch('rotate_api_aws_key.smoke_log', return_value='Production smoke checks: ok'), self.assertRaises(RotationGuardError):
            verify_smoke('123', '2026-10-31T03:00:00Z', 'PRIVATE_TOKEN')

    def test_log_download_does_not_forward_token_or_follow_further_redirects(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'proof'
        opener = MagicMock()
        opener.open.side_effect = [HTTPError('https://api.github.com/logs', 302, '',
            {'Location': 'https://storage.example/log?signature=PRIVATE'}, None), response]
        with patch('rotate_api_aws_key.build_opener', return_value=opener):
            self.assertEqual(smoke_log(999, 'PRIVATE_TOKEN'), 'proof')
        first, second = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(first.get_header('Authorization'), 'Bearer PRIVATE_TOKEN')
        self.assertFalse(second.has_header('Authorization'))
        for status in (403, 404):
            opener.open.side_effect = HTTPError('https://api.github.com/logs', status, 'PRIVATE_BODY', {}, None)
            with patch('rotate_api_aws_key.build_opener', return_value=opener), self.assertRaisesRegex(RotationGuardError, 'SMOKE_LOG_API_HTTP_'+str(status)):
                smoke_log(999, 'PRIVATE_TOKEN')
        opener.open.side_effect = HTTPError('https://api.github.com/logs', 302, '', {'Location': 'http://storage.example/log'}, None)
        with patch('rotate_api_aws_key.build_opener', return_value=opener), self.assertRaisesRegex(RotationGuardError, 'UNSAFE_SMOKE_LOG_DOWNLOAD_URL'):
            smoke_log(999, 'PRIVATE_TOKEN')

    def test_worker_keys_are_patched_in_one_request_without_touching_other_secrets(self):
        response = MagicMock()
        response.read.return_value = b'{"success": true, "result": {"text": "PRIVATE_SERVER_BODY"}}'
        context = MagicMock()
        context.__enter__.return_value = response
        opener = MagicMock()
        opener.open.return_value = context
        with patch('rotate_api_aws_key.build_opener', return_value=opener), contextlib.redirect_stdout(io.StringIO()) as output:
            patch_worker('https://api.cloudflare.com/worker', 'PRIVATE_TOKEN', {'newId': NEW, 'newSecret': 'PRIVATE_SECRET'})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), 'PATCH')
        self.assertTrue(request.full_url.endswith('/secrets-bulk'))
        body = json.loads(request.data)
        self.assertEqual(set(body['secrets']), {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'})
        self.assertEqual(body['secrets']['AWS_SECRET_ACCESS_KEY']['text'], 'PRIVATE_SECRET')
        self.assertIsNone(body['secrets']['AWS_SESSION_TOKEN'])
        self.assertEqual(output.getvalue(), '')

    def test_age_monitor_warns_before_ninety_days_and_ignores_inactive_keys(self):
        from audit_api_key_age import rotation_due
        self.assertFalse(rotation_due([{'status': 'Active', 'ageDays': 79}]))
        self.assertTrue(rotation_due([{'status': 'Active', 'ageDays': 80}]))
        self.assertFalse(rotation_due([{'status': 'Inactive', 'ageDays': 100}, {'status': 'Active', 'ageDays': 0}]))
        self.assertTrue(rotation_due([]))

    def test_workflow_protects_writes_and_operator_grant_is_single_user_only(self):
        source = (ROOT/'.github/workflows/api-aws-key-rotation.yml').read_text()
        self.assertIn('default: audit', source)
        self.assertIn('environment: production-infra', source)
        self.assertIn('actions: read', source)
        self.assertNotIn('upload-artifact', source)
        self.assertNotIn('pull_request_target', source)
        audit = source.split('  audit:')[1].split('  rotate:')[0]
        self.assertNotIn('environment:', audit)
        self.assertNotIn('CLOUDFLARE_API_TOKEN', audit)
        self.assertIn('AWS_GITHUB_ACTIONS_PLAN_ROLE_ARN', audit)
        grant = json.loads((ROOT/'infra/iam/videoq-api-key-rotation-operator.json').read_text())
        for statement in grant['Statement']:
            self.assertEqual(statement['Resource'], USER_ARN)
            self.assertFalse(any('PutUserPolicy' in action or '*' in action for action in statement['Action']))


if __name__ == '__main__':
    unittest.main()
