"""Read-only policy/age audit for the single production API IAM user."""
import datetime
import json
from contextlib import closing
from credential_http import error_summary

USER = "videoq-workers-api"
ARN = "arn:aws:iam::257240362763:user/" + USER


def audit_api_iam(session):
    with closing(session.client("iam")) as iam:
        user = iam.get_user(UserName=USER)["User"]
        if user["Arn"] != ARN:
            raise ValueError("Unexpected IAM principal")
        policies = []
        for page in iam.get_paginator("list_user_policies").paginate(UserName=USER):
            for name in page.get("PolicyNames", []):
                document = iam.get_user_policy(UserName=USER, PolicyName=name)["PolicyDocument"]
                policies.append({"type": "inline", "name": name, "document": document})
        for page in iam.get_paginator("list_attached_user_policies").paginate(UserName=USER):
            for entry in page.get("AttachedPolicies", []):
                policy = iam.get_policy(PolicyArn=entry["PolicyArn"])["Policy"]
                document = iam.get_policy_version(PolicyArn=entry["PolicyArn"], VersionId=policy["DefaultVersionId"])["PolicyVersion"]["Document"]
                policies.append({"type": "managed", "arn": entry["PolicyArn"], "document": document})
        keys = []
        now = datetime.datetime.now(datetime.timezone.utc)
        for page in iam.get_paginator("list_access_keys").paginate(UserName=USER):
            for key in page.get("AccessKeyMetadata", []):
                usage = iam.get_access_key_last_used(AccessKeyId=key["AccessKeyId"])["AccessKeyLastUsed"]
                keys.append({"status": key["Status"], "ageDays": (now-key["CreateDate"]).days,
                             "lastUsedService": usage.get("ServiceName"), "lastUsedAt": str(usage.get("LastUsedDate", ""))})
        return {"status": "api_iam_audit", "readOnly": True, "principal": ARN,
                "permissionsBoundaryPresent": "PermissionsBoundary" in user,
                "groups": [group["GroupName"] for page in iam.get_paginator("list_groups_for_user").paginate(UserName=USER) for group in page.get("Groups", [])],
                "policies": policies, "keys": keys}


if __name__ == "__main__":
    import boto3
    import sys
    try:
        result = audit_api_iam(boto3.Session())
    except Exception as error:
        print(json.dumps({"status": "api_iam_audit_failed", **error_summary(error)}))
        sys.exit(1)
    print(json.dumps(result))
