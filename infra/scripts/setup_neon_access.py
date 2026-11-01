"""Provision purpose-specific OIDC environments and IAM policies (no DB values)."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
REPO = "videoq-jp/videoq"
PREFIX = "repo:videoq-jp@349188820/videoq@1083911938"
REGION = "ap-northeast-1"
AWS = os.environ.get("VIDEOQ_AWS_CLI", "aws")


def aws(*args):
    value=subprocess.check_output([AWS, *args, "--output", "json"], text=True)
    return json.loads(value) if value.strip() else None


def gh(method, endpoint, value):
    return subprocess.run(["gh", "api", "--method", method, endpoint, "--input", "-"],
                          input=json.dumps(value), text=True, capture_output=True, check=True).stdout


def trust(account, environment):
    return {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {
        "Federated": f"arn:aws:iam::{account}:oidc-provider/token.actions.githubusercontent.com"},
        "Action": "sts:AssumeRoleWithWebIdentity", "Condition": {"StringEquals": {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": f"{PREFIX}:environment:{environment}"}}}]}


def install(account, role, environment, policy, duration=3600):
    existing = subprocess.run([AWS, "iam", "get-role", "--role-name", role], capture_output=True)
    if existing.returncode:
        aws("iam", "create-role", "--role-name", role, "--max-session-duration", str(duration),
            "--assume-role-policy-document", json.dumps(trust(account, environment)))
    else:
        aws("iam", "update-assume-role-policy", "--role-name", role,
            "--policy-document", json.dumps(trust(account, environment)))
    subprocess.run([AWS,"iam","put-role-policy","--role-name",role,"--policy-name","neon-parameter-access",
                    "--policy-document",json.dumps(policy)], check=True, capture_output=True)
    subprocess.run(["gh","secret","set","AWS_GITHUB_ACTIONS_NEON_ROLE_ARN" if duration==3600 else
                    "AWS_GITHUB_ACTIONS_NEON_ROTATION_ROLE_ARN","--repo",REPO,"--env",environment],
                   input=f"arn:aws:iam::{account}:role/{role}",text=True,check=True,capture_output=True)


def main():
    account=aws("sts","get-caller-identity")["Account"]
    if account!="257240362763":
        raise SystemExit("Unexpected AWS account")
    profiles=json.loads((ROOT/".github/scripts/neon-profiles.json").read_text())
    parameter=lambda name:f"arn:aws:ssm:{REGION}:{account}:parameter{name}"
    for purpose in ["migration","backup","audit","smoke","demo"]:
        environment="production-db-"+purpose
        gh("PUT",f"repos/{REPO}/environments/{environment}",{
            "deployment_branch_policy":{"protected_branches":False,"custom_branch_policies":True}})
        policies=json.loads(subprocess.check_output(["gh","api",f"repos/{REPO}/environments/{environment}/deployment-branch-policies"],text=True))["branch_policies"]
        if not any(p["name"]=="main" for p in policies):
            gh("POST",f"repos/{REPO}/environments/{environment}/deployment-branch-policies",{"name":"main","type":"branch"})
        if any(p["name"]!="main" for p in policies):
            raise SystemExit("Unexpected deployment branch policy")
        policy={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameter",
            "Resource":parameter(profiles[purpose]["parameter"])}]}
        install(account,"videoq-github-actions-neon-"+purpose,environment,policy)
        print("Scoped OIDC access configured: "+purpose)
    rotation={"Version":"2012-10-17","Statement":[
        {"Effect":"Allow","Action":"ssm:GetParameter","Resource":[parameter("/videoq/security/prod/db-admin"),
            *[parameter(p["parameter"]) for p in profiles.values()],parameter("/videoq/security/prod/db-rotation")]},
        {"Effect":"Allow","Action":"ssm:PutParameter","Resource":[*[parameter(p["parameter"]) for p in profiles.values()],
            parameter("/videoq/security/prod/db-rotation")]},
        {"Effect":"Allow","Action":"ssm:DescribeParameters","Resource":"*"},
        {"Effect":"Allow","Action":["lambda:GetFunctionConfiguration","lambda:UpdateFunctionConfiguration"],
            "Resource":f"arn:aws:lambda:{REGION}:{account}:function:videoq-worker-prod"}]}
    install(account,"videoq-github-actions-neon-rotation","production-infra",rotation,7200)
    print("Dedicated rotation role configured")


if __name__=="__main__":
    main()
