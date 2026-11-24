"""Weekly read-only rotation reminder; no credentials are created or modified."""
import json
import sys
from credential_http import error_summary
from audit_api_iam import audit_api_iam

def rotation_due(keys):
    active = [key for key in keys if key['status'] == 'Active']
    return not active or any(key['ageDays'] >= 80 for key in active)


if __name__ == '__main__':
    import boto3
    try:
        result = audit_api_iam(boto3.Session())
        result['rotationDue'] = rotation_due(result['keys'])
    except Exception as error:
        print(json.dumps({'status': 'api_key_age_audit_failed', **error_summary(error)}))
        sys.exit(1)
    print(json.dumps(result))
    sys.exit(1 if result['rotationDue'] else 0)
