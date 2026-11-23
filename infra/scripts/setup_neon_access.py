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


def install(account, role, environment, policy, duration=3600, secret_name=None):
    existing = subprocess.run([AWS, "iam", "get-role", "--role-name", role], capture_output=True)
    if existing.returncode:
        aws("iam", "create-role", "--role-name", role, "--max-session-duration", str(duration),
            "--assume-role-policy-document", json.dumps(trust(account, environment)))
    else:
        aws("iam", "update-assume-role-policy", "--role-name", role,
            "--policy-document", json.dumps(trust(account, environment)))
        aws("iam", "update-role", "--role-name", role, "--max-session-duration", str(duration))
    subprocess.run([AWS,"iam","put-role-policy","--role-name",role,"--policy-name",("aws-database-request" if secret_name=="AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN" else "neon-parameter-access"),
                    "--policy-document",json.dumps(policy)], check=True, capture_output=True)
    subprocess.run(["gh","secret","set",secret_name or ("AWS_GITHUB_ACTIONS_NEON_ROLE_ARN" if duration==3600 else
                    "AWS_GITHUB_ACTIONS_NEON_ROTATION_ROLE_ARN"),"--repo",REPO,"--env",environment],
                   input=f"arn:aws:iam::{account}:role/{role}",text=True,check=True,capture_output=True)


def ensure_environment(environment):
    result=subprocess.run(["gh","api",f"repos/{REPO}/environments/{environment}"],capture_output=True,text=True)
    if result.returncode:
        gh("PUT",f"repos/{REPO}/environments/{environment}",{
            "deployment_branch_policy":{"protected_branches":False,"custom_branch_policies":True}})
    policies=json.loads(subprocess.check_output(["gh","api",f"repos/{REPO}/environments/{environment}/deployment-branch-policies"],text=True))["branch_policies"]
    if not any(p["name"]=="main" for p in policies):
        gh("POST",f"repos/{REPO}/environments/{environment}/deployment-branch-policies",{"name":"main","type":"branch"})
    if any(p["name"]!="main" for p in policies):
        raise SystemExit("Unexpected deployment branch policy")


def main():
    raise SystemExit("AWS database invokers are retired after verified Cloudflare cutover; this historical provisioner must not recreate them.")


if __name__=="__main__":
    main()
