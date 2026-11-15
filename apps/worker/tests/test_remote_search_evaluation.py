import io
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import pytest

from worker_python import remote_search_evaluation as remote, search_evaluation, search_evaluation_lambda


@pytest.fixture
def setup(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    policy = 'synthetic-policy'
    for key in list(os.environ):
        if key.startswith(('EMBEDDING_', 'OPENAI_', 'OPENROUTER_', 'AWS_', 'VIDEOQ_SEARCH_EVALUATION_')):
            monkeypatch.delenv(key)
    values = {'OPENROUTER_FEDERATION_POLICY_ID': policy, 'OPENAI_BASE_URL': 'https://openrouter.ai/api/v1',
              'EMBEDDING_MODEL': 'openai/text-embedding-3-small', 'VIDEOQ_SEARCH_EVALUATION_ENABLED': 'true'}
    for key, value in {**values, 'AWS_REGION': 'ap-northeast-1'}.items():
        monkeypatch.setenv(key, value)
    target = {'version': 1, 'functionArn': 'arn:aws:lambda:ap-northeast-1:111122223333:function:videoq-search-evaluation-prod',
              'functionVersion': '7', 'imageUri': '111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:' + 'a' * 64,
              'roleArn': 'arn:aws:iam::111122223333:role/videoq-worker-prod', 'federationPolicyId': policy}
    manifest = {'version': 1, 'cohort': 'synthetic', 'corpusSha256': 'b' * 64,
                'embedding': {'provider': 'openai', 'profile': 'openai', 'model': values['EMBEDDING_MODEL'], 'dimensions': 1536,
                              'baseUrl': values['OPENAI_BASE_URL'], 'authentication': 'workload-federation'},
                'samples': 3, 'cases': [{'id': f'q{i}', 'question': f'private question {i}', 'userId': 'owner', 'videoIds': [1, 2], 'limit': 20} for i in range(17)]}
    manifest['cases'].append({**manifest['cases'][0], 'id': 'duplicate-scope', 'userId': 'peer', 'videoIds': [9]})
    source, destination, pin = tmp_path / 'questions.json', tmp_path / 'vectors.json', tmp_path / 'target.json'
    def save():
        for path, value in [(source, manifest), (pin, target)]:
            path.write_text(json.dumps(value));path.chmod(0o600)
    save()
    provider = Mock(side_effect=lambda texts, **_: [[float(int(text.split()[-1]) + 1)] + [0.0] * 1535 for text in texts])
    monkeypatch.setattr(search_evaluation, 'embed_texts', provider)
    metadata = {'Code': {'ResolvedImageUri': target['imageUri']}, 'Concurrency': {'ReservedConcurrentExecutions': 1},
                'Configuration': {'Version': '7', 'FunctionArn': target['functionArn'] + ':7', 'Role': target['roleArn'], 'PackageType': 'Image',
                                  'State': 'Active', 'LastUpdateStatus': 'Successful', 'Architectures': ['arm64'], 'MemorySize': 512, 'Timeout': 300,
                                  'Environment': {'Variables': values.copy()}, 'ImageConfigResponse': {'ImageConfig': {'Command': ['worker_python.search_evaluation_lambda.handler']}}}}
    client = Mock()
    client.get_function.return_value = metadata
    client.get_function_concurrency.side_effect = lambda **_: metadata['Concurrency']
    bodies = []
    def invoke(**kwargs):
        event = json.loads(kwargs['Payload'])
        context = Mock();context.get_remaining_time_in_millis.return_value = 300000
        value = search_evaluation_lambda.handler(event, context)
        body = io.BytesIO(json.dumps(value).encode());bodies.append(body)
        return {'StatusCode': 200, 'ExecutedVersion': '7', 'Payload': body}
    client.invoke.side_effect = invoke
    return {'source': source, 'destination': destination, 'pin': pin, 'manifest': manifest, 'target': target, 'save': save,
            'metadata': metadata, 'client': client, 'provider': provider, 'invoke': invoke, 'bodies': bodies}


def run(f, execute=True):
    return remote.prepare_remote(f['source'], f['destination'], f['pin'], execute=execute, client=f['client'])


def test_preflight_is_offline_and_does_not_verify_nonexistent_runtime(setup):
    assert run(setup, False) == {'status': 'ready', 'cases': 18, 'unique_queries': 17, 'invocations': 2,
                                 'aws_calls_made': False, 'target_verified': False, 'execute_required': True}
    assert setup['client'].mock_calls == []
    assert not setup['destination'].exists()


def test_pinned_runtime_batches_and_merges_exact_scopes_without_regenerating_duplicates(setup):
    f = setup
    assert run(f)['status'] == 'written'
    f['client'].get_function.assert_called_once_with(FunctionName=f['target']['functionArn'], Qualifier='7')
    f['client'].get_function_concurrency.assert_called_once_with(FunctionName=f['target']['functionArn'])
    assert [len(json.loads(call.kwargs['Payload'])['manifest']['cases']) for call in f['client'].invoke.call_args_list] == [16, 1]
    assert all(call.kwargs['Qualifier'] == '7' and call.kwargs['LogType'] == 'None' and call.kwargs['InvocationType'] == 'RequestResponse' for call in f['client'].invoke.call_args_list)
    data = json.loads(f['destination'].read_text())
    assert data['samples'] == 3 and len(data['cases']) == 18
    assert data['cases'][-1] == {**data['cases'][0], 'userId': 'peer', 'videoIds': [9]}
    assert data['generation']['case_ids'] == [case['id'] for case in f['manifest']['cases']]
    assert [case['queryEmbedding'][0] for case in data['cases']] == list(range(1, 18)) + [1]
    assert 'private question' not in f['destination'].read_text()
    assert f['destination'].stat().st_mode & 0o777 == 0o600
    assert all(body.closed for body in f['bodies'])
    assert not list(f['destination'].parent.glob('.*.lock'))


def test_qualified_metadata_without_concurrency_uses_function_level_api(setup):
    setup['metadata'].pop('Concurrency')
    setup['client'].get_function_concurrency.side_effect = None
    setup['client'].get_function_concurrency.return_value = {'ReservedConcurrentExecutions': 1}
    assert run(setup)['status'] == 'written'


@pytest.mark.parametrize('setting', [{}, {'ReservedConcurrentExecutions': 0}, {'ReservedConcurrentExecutions': True}])
def test_missing_or_disabled_authoritative_concurrency_refuses_invocation(setup, setting):
    setup['client'].get_function_concurrency.side_effect = None
    setup['client'].get_function_concurrency.return_value = setting
    with pytest.raises(remote.EvaluationError, match='runtime_mismatch'):
        run(setup)
    setup['client'].invoke.assert_not_called()


def test_failed_concurrency_inspection_refuses_invocation(setup):
    setup['client'].get_function_concurrency.side_effect = RuntimeError('private SDK details')
    with pytest.raises(remote.EvaluationError, match='runtime_inspection_failed'):
        run(setup)
    setup['client'].invoke.assert_not_called()


@pytest.mark.parametrize('change', [
    lambda x: x.update(functionVersion='$LATEST'),
    lambda x: x.update(functionVersion='live'),
    lambda x: x.update(functionArn=x['functionArn'].replace('videoq-search-evaluation-prod', 'videoq-worker-prod')),
    lambda x: x.update(imageUri=x['imageUri'].split('@')[0] + ':latest'),
    lambda x: x.update(roleArn=x['roleArn'].replace('worker-prod', 'administrator')),
])
def test_unpinned_or_non_evaluation_targets_are_rejected_without_aws_calls(setup, change):
    change(setup['target']);setup['save']()
    with pytest.raises(remote.EvaluationError, match='invalid_target'):
        run(setup)
    assert setup['client'].mock_calls == []


@pytest.mark.parametrize('change', [
    lambda x: x['Code'].update(ResolvedImageUri='different-image'),
    lambda x: x['Concurrency'].update(ReservedConcurrentExecutions=2),
    lambda x: x['Configuration'].update(Version='8'),
    lambda x: x['Configuration'].update(Role='different-role'),
    lambda x: x['Configuration'].update(Timeout=900),
    lambda x: x['Configuration']['Environment']['Variables'].update(DB_PARAM_NAME='/forbidden/db'),
    lambda x: x['Configuration']['Environment']['Variables'].update(OPENROUTER_FEDERATION_POLICY_ID='other-policy'),
    lambda x: x['Configuration']['Environment']['Variables'].update(EMBEDDING_MODEL='other-model'),
    lambda x: x['Configuration']['ImageConfigResponse']['ImageConfig'].update(Command=['handler.handler']),
])
def test_runtime_drift_is_refused_before_any_paid_invocation(setup, change):
    change(setup['metadata'])
    with pytest.raises(remote.EvaluationError, match='runtime_mismatch'):
        run(setup)
    setup['client'].invoke.assert_not_called()
    assert not setup['destination'].exists()


@pytest.mark.parametrize('change', [
    lambda x: x.update(manifest_sha256='wrong'),
    lambda x: x['evaluation_input'].update(corpusSha256='wrong'),
    lambda x: x['evaluation_input'].update(model='other-model'),
    lambda x: x['evaluation_input']['cases'][0].update(userId='other-owner'),
    lambda x: x['evaluation_input']['cases'][0].update(videoIds=[9]),
    lambda x: x['evaluation_input']['cases'][0].update(queryEmbedding=[0] * 1536),
    lambda x: x['evaluation_input']['generation'].update(case_ids=['wrong']),
])
def test_tampered_results_are_not_published(setup, change):
    original = setup['invoke']
    def tamper(**kwargs):
        response = original(**kwargs)
        with response['Payload'] as stream:
            data = json.loads(stream.read())
        change(data)
        response['Payload'] = io.BytesIO(json.dumps(data).encode())
        return response
    setup['client'].invoke.side_effect = tamper
    with pytest.raises(remote.EvaluationError, match='invalid_remote_result'):
        run(setup)
    assert not setup['destination'].exists()
    assert setup['client'].invoke.call_count == 1


def test_executed_version_mismatch_and_function_errors_close_payloads(setup):
    original = setup['invoke']
    def mismatch(**kwargs):
        response = original(**kwargs);response['ExecutedVersion'] = '8';return response
    setup['client'].invoke.side_effect = mismatch
    with pytest.raises(remote.EvaluationError, match='remote_invocation_failed'):
        run(setup)
    assert all(body.closed for body in setup['bodies'])
    assert not setup['destination'].exists()


def test_lost_late_reply_is_not_retried_or_partially_published(setup):
    original = setup['invoke'];count = 0
    def late(**kwargs):
        nonlocal count
        count += 1
        if count == 2:raise RuntimeError('secret SDK request and private-question')
        return original(**kwargs)
    setup['client'].invoke.side_effect = late
    with pytest.raises(remote.EvaluationError, match='^remote_invocation_failed$'):
        run(setup)
    assert count == 2 and not setup['destination'].exists()
    assert not list(setup['destination'].parent.glob('.*.lock'))


def test_existing_output_is_not_overwritten_or_billed(setup):
    setup['destination'].write_text('verified output')
    with pytest.raises(remote.EvaluationError, match='output_exists'):
        run(setup)
    assert setup['client'].mock_calls == []
    assert setup['destination'].read_text() == 'verified output'


def test_cli_preflight_does_not_import_aws_sdk_or_print_question_data(setup):
    script = '''import importlib.abc,sys
class Block(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname in ['boto3','botocore','psycopg','worker_python.db']: raise AssertionError('Forbidden offline import')
sys.meta_path.insert(0,Block())
from worker_python.remote_search_evaluation import cli
sys.exit(cli(sys.argv[1:]))
'''
    result = subprocess.run([sys.executable, '-c', script, '--input', str(setup['source']), '--output', str(setup['destination']), '--target', str(setup['pin'])],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['aws_calls_made'] is False
    assert 'private question' not in result.stdout + result.stderr


def test_sdk_client_uses_fixed_endpoint_single_attempt_and_no_role_acquisition(monkeypatch):
    session = Mock()
    session._session.get_scoped_config.return_value = {}
    module = Mock()
    module.Session.return_value = session
    monkeypatch.setitem(sys.modules, 'boto3', module)
    assert remote._lambda_client() is session.client.return_value
    resolver = session._session.get_component.return_value
    assert [call.args[0] for call in resolver.remove.call_args_list] == ['assume-role', 'assume-role-with-web-identity', 'custom-process']
    args = session.client.call_args.kwargs
    assert args['endpoint_url'] == 'https://lambda.ap-northeast-1.amazonaws.com'
    assert args['config'].retries['total_max_attempts'] == 1


def test_worker_sso_role_is_refused_without_constructing_client(monkeypatch):
    session = Mock()
    session._session.get_scoped_config.return_value = {'sso_role_name': 'videoq-worker-prod'}
    module = Mock();module.Session.return_value = session
    monkeypatch.setitem(sys.modules, 'boto3', module)
    with pytest.raises(remote.EvaluationError, match='operator_credentials_required'):
        remote._lambda_client()
    session.client.assert_not_called()
