"""Staged rotation for one IAM user/Worker. Credentials never leave protected stores."""
import datetime
import json
import os
import re
import sys
import time
from contextlib import closing
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from audit_ai_credentials import NoRedirect, api_json, error_summary
from retire_ai_credentials import API_POLICY, verify_router

USER = 'videoq-workers-api'
USER_ARN = 'arn:aws:iam::257240362763:user/'+USER
QUEUE_ARNS = ['arn:aws:sqs:ap-northeast-1:257240362763:'+name for name in
              ('videoq-worker-prod', 'videoq-worker-search-prod', 'videoq-worker-account-prod')]
JOURNAL = '/videoq/prod/api-key-rotation'
REPO = 'videoq-jp/videoq'


class RotationGuardError(ValueError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def parse_time(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def normalized(statement):
    if set(statement)-{'Sid', 'Effect', 'Action', 'Resource', 'Condition'}:
        raise RotationGuardError('UNEXPECTED_POLICY_FIELDS')
    def values(value):
        return tuple(sorted(str(v) for v in (value if isinstance(value, list) else [value])))
    condition = tuple(sorted((op, key, values(value)) for op, entries in statement.get('Condition', {}).items() for key, value in entries.items()))
    return (statement.get('Effect'), values(statement.get('Action')), values(statement.get('Resource')), condition)


def require_permissions(iam):
    user = iam.get_user(UserName=USER)['User']
    if user['Arn'] != USER_ARN or user.get('PermissionsBoundary'):
        raise RotationGuardError('UNEXPECTED_USER_OR_BOUNDARY')
    if any(page.get('Groups') for page in iam.get_paginator('list_groups_for_user').paginate(UserName=USER)):
        raise RotationGuardError('INHERITED_GROUP_POLICY_REQUIRES_REVIEW')
    if any(page.get('AttachedPolicies') for page in iam.get_paginator('list_attached_user_policies').paginate(UserName=USER)):
        raise RotationGuardError('MANAGED_POLICY_REQUIRES_REVIEW')
    statements = []
    for page in iam.get_paginator('list_user_policies').paginate(UserName=USER):
        for name in page.get('PolicyNames', []):
            document = iam.get_user_policy(UserName=USER, PolicyName=name)['PolicyDocument']
            value = document.get('Statement', [])
            statements.extend(value if isinstance(value, list) else [value])
    expected = [
        {'Effect': 'Allow', 'Action': 'sqs:SendMessage', 'Resource': QUEUE_ARNS},
        {'Effect': 'Allow', 'Action': 'sts:GetWebIdentityToken', 'Resource': '*', 'Condition': {
            'ForAllValues:StringEquals': {'sts:IdentityTokenAudience': ['https://openrouter.ai']},
            'StringEquals': {'sts:SigningAlgorithm': 'RS256'},
            'NumericLessThanEquals': {'sts:DurationSeconds': '900'},
        }},
    ]
    if sorted(map(normalized, statements)) != sorted(map(normalized, expected)):
        raise RotationGuardError('USER_POLICY_MUST_MATCH_REVIEWED_LEAST_PRIVILEGE')


def list_keys(iam):
    return [key for page in iam.get_paginator('list_access_keys').paginate(UserName=USER) for key in page.get('AccessKeyMetadata', [])]


def load_journal(ssm):
    try:
        value = ssm.get_parameter(Name=JOURNAL, WithDecryption=True)['Parameter']['Value']
    except Exception as error:
        if getattr(error, 'response', {}).get('Error', {}).get('Code') == 'ParameterNotFound':
            return None
        raise
    data = json.loads(value)
    if data.get('userArn') != USER_ARN or data.get('stage') not in {'created', 'installed', 'old_disabled'}:
        raise RotationGuardError('INVALID_ROTATION_JOURNAL')
    if data.get('oldId') == data.get('newId') or any(not re.fullmatch(r'AKIA[A-Z0-9]{16}', data.get(name, '')) for name in ('oldId', 'newId')):
        raise RotationGuardError('INVALID_KEY_IDENTIFIERS')
    if not isinstance(data.get('newSecret'), str) or not data['newSecret']:
        raise RotationGuardError('MISSING_PERSISTED_NEW_SECRET')
    return data


def save_journal(ssm, data, *, create=False):
    ssm.put_parameter(Name=JOURNAL, Value=json.dumps(data), Type='SecureString', Overwrite=not create)


def validate_new_key(data):
    import boto3
    from botocore.config import Config
    # IAM propagation can briefly reject a newly created key. Never print errors.
    for attempt in range(6):
        try:
            with closing(boto3.client('sts', region_name='ap-northeast-1',
                                     aws_access_key_id=data['newId'], aws_secret_access_key=data['newSecret'],
                                     config=Config(connect_timeout=10, read_timeout=10, retries={'max_attempts': 0}))) as sts:
                identity = sts.get_caller_identity()
            if identity['Arn'] != USER_ARN:
                raise RotationGuardError('NEW_KEY_IDENTITY_MISMATCH')
            return
        except RotationGuardError:
            raise
        except Exception:
            if attempt == 5:
                raise RotationGuardError('NEW_KEY_AUTHENTICATION_NOT_READY') from None
            time.sleep(3)


def patch_worker(url, token, data):
    secrets = {key: {'name': key, 'type': 'secret_text', 'text': value} for key, value in (
        ('AWS_ACCESS_KEY_ID', data['newId']), ('AWS_SECRET_ACCESS_KEY', data['newSecret']))}
    secrets['AWS_SESSION_TOKEN'] = None
    request = Request(url+'/secrets-bulk', data=json.dumps({'secrets': secrets}).encode(),
                      headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'}, method='PATCH')
    with build_opener(NoRedirect).open(request, timeout=30) as response:
        result = json.load(response)
    if result.get('success') is not True:
        raise RotationGuardError('WORKER_SECRET_UPDATE_NOT_CONFIRMED')


def smoke_log(job_id, token):
    # Obtain GitHub's signed download URL without forwarding the token to storage.
    request = Request('https://api.github.com/repos/'+REPO+'/actions/jobs/'+str(job_id)+'/logs',
                      headers={'Authorization': 'Bearer '+token, 'Accept': 'application/vnd.github+json'})
    opener = build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=30) as response:
            return response.read().decode('utf-8', errors='replace')
    except HTTPError as error:
        if error.code != 302:
            raise RotationGuardError('SMOKE_LOG_API_HTTP_'+str(error.code)) from None
        location = error.headers.get('Location', '')
    target = urlsplit(location)
    if target.scheme != 'https' or not target.hostname or target.username or target.password:
        raise RotationGuardError('UNSAFE_SMOKE_LOG_DOWNLOAD_URL')
    try:
        with opener.open(Request(location), timeout=30) as response:
            return response.read().decode('utf-8', errors='replace')
    except HTTPError as error:
        raise RotationGuardError('SMOKE_LOG_DOWNLOAD_HTTP_'+str(error.code)) from None


def verify_smoke(run_id, since, token):
    if not re.fullmatch(r'[0-9]{1,20}', run_id or ''):
        raise RotationGuardError('EXPLICIT_SMOKE_RUN_REQUIRED')
    root = 'https://api.github.com/repos/'+REPO+'/actions/runs/'+run_id
    run = api_json(root, token)
    if run.get('path') != '.github/workflows/operations.yml' or run.get('event') != 'workflow_dispatch' or run.get('status') != 'completed' or run.get('conclusion') != 'success' or parse_time(run['created_at']) <= parse_time(since):
        raise RotationGuardError('SMOKE_MUST_SUCCEED_AFTER_THIS_ROTATION_STAGE')
    jobs = api_json(root+'/jobs?per_page=100', token)['jobs']
    matches = [job for job in jobs if job['name'] == 'production-smoke' and job['conclusion'] == 'success']
    if len(matches) != 1:
        raise RotationGuardError('SUCCESSFUL_PRODUCTION_SMOKE_JOB_REQUIRED')
    output = smoke_log(matches[0]['id'], token)
    required = ('VERIFY_AI_ANSWERS: true', 'Production smoke stage: cited-question-answer', 'Production smoke checks: ok', 'Production smoke cleanup: complete')
    if not all(marker in output for marker in required):
        raise RotationGuardError('CITED_QA_AND_COMPLETE_CLEANUP_MUST_BE_VERIFIED')


def rotate(session, environ, operation, proof=''):
    if operation not in {'install', 'disable-old', 'finalize'}:
        raise RotationGuardError('UNKNOWN_ROTATION_OPERATION')
    account = environ['CLOUDFLARE_ACCOUNT_ID']
    if not re.fullmatch(r'[a-f0-9]{32}', account):
        raise RotationGuardError('INVALID_CLOUDFLARE_ACCOUNT')
    url = f'https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/videoq-api'
    token = environ['CLOUDFLARE_API_TOKEN']
    settings = api_json(url+'/settings', token)
    if settings.get('success') is not True:
        raise RotationGuardError('WORKER_SETTINGS_UNAVAILABLE')
    plain = {b['name']: b.get('text', '') for b in settings['result']['bindings'] if b.get('type') == 'plain_text'}
    verify_router(plain, API_POLICY)
    if plain.get('AWS_SESSION_TOKEN'):
        raise RotationGuardError('UNEXPECTED_PLAINTEXT_SESSION_TOKEN')
    with closing(session.client('iam')) as iam, closing(session.client('ssm')) as ssm:
        require_permissions(iam)
        data = load_journal(ssm)
        current = list_keys(iam)
        if data is None:
            if operation != 'install' or len(current) != 1 or current[0]['Status'] != 'Active':
                raise RotationGuardError('ONE_ACTIVE_OLD_KEY_AND_NO_JOURNAL_REQUIRED')
            new = iam.create_access_key(UserName=USER)['AccessKey']
            data = {'userArn': USER_ARN, 'oldId': current[0]['AccessKeyId'], 'newId': new['AccessKeyId'],
                    'newSecret': new['SecretAccessKey'], 'stage': 'created', 'createdAt': now(), 'sourceSha': environ['GITHUB_SHA']}
            # On a persistence error, do not change the Worker or disable either key.
            # A fresh audit must resolve ambiguous AWS responses before retrying.
            save_journal(ssm, data, create=True)
            data = load_journal(ssm)
            current = list_keys(iam)
        statuses = {key['AccessKeyId']: key['Status'] for key in current}
        if set(statuses)-{data['oldId'], data['newId']} or statuses.get(data['newId']) != 'Active':
            raise RotationGuardError('KEY_SET_CHANGED_DURING_ROTATION')
        validate_new_key(data)
        if operation == 'install':
            if data['stage'] == 'created':
                if statuses.get(data['oldId']) != 'Active':
                    raise RotationGuardError('OLD_KEY_MUST_REMAIN_ACTIVE_FOR_INSTALLATION')
                patch_worker(url, token, data)
                data.update(stage='installed', installedAt=now())
                save_journal(ssm, data)
            if data['stage'] != 'installed':
                raise RotationGuardError('INSTALLATION_STAGE_ALREADY_PASSED')
        elif operation == 'disable-old':
            if data['stage'] != 'installed':
                raise RotationGuardError('INSTALLATION_MUST_PRECEDE_DISABLE')
            verify_smoke(proof, data['installedAt'], environ['GH_TOKEN'])
            if statuses.get(data['oldId']) == 'Active':
                iam.update_access_key(UserName=USER, AccessKeyId=data['oldId'], Status='Inactive')
            elif statuses.get(data['oldId']) != 'Inactive':
                raise RotationGuardError('OLD_KEY_STATE_CHANGED')
            data.update(stage='old_disabled', disabledAt=now(), firstProof=proof)
            save_journal(ssm, data)
        else:
            if data['stage'] != 'old_disabled' or proof == data.get('firstProof'):
                raise RotationGuardError('SECOND_POST_DISABLE_SMOKE_REQUIRED')
            verify_smoke(proof, data['disabledAt'], environ['GH_TOKEN'])
            if statuses.get(data['oldId']) == 'Inactive':
                iam.delete_access_key(UserName=USER, AccessKeyId=data['oldId'])
            elif data['oldId'] in statuses:
                raise RotationGuardError('OLD_KEY_MUST_BE_INACTIVE_BEFORE_DELETION')
            remaining = list_keys(iam)
            if len(remaining) != 1 or remaining[0]['AccessKeyId'] != data['newId'] or remaining[0]['Status'] != 'Active':
                raise RotationGuardError('FINAL_KEY_SET_NOT_CONFIRMED')
            ssm.delete_parameter(Name=JOURNAL)
            return {'status': 'api_key_rotation', 'stage': 'complete', 'oldKeyDeleted': True, 'temporarySecretJournalDeleted': True}
        return {'status': 'api_key_rotation', 'stage': data['stage'], 'oldKeyDeleted': False}


if __name__ == '__main__':
    import boto3
    operation = os.environ.get('OPERATION', '')
    try:
        result = rotate(boto3.Session(), os.environ, operation, os.environ.get('VERIFICATION_RUN_ID', ''))
    except Exception as error:
        result = {'status': 'api_rotation_failed', 'operation': operation, **error_summary(error)}
        if isinstance(error, RotationGuardError):
            result['reason'] = str(error)
        print(json.dumps(result))
        sys.exit(1)
    print(json.dumps(result))
