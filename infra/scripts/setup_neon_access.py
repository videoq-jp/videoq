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
    account=aws("sts","get-caller-identity")["Account"]
    if account!="257240362763":
        raise SystemExit("Unexpected AWS account")
    for purpose in ["maintenance", "migration", "backup", "smoke"]:
        alias=aws("lambda","get-alias","--region",REGION,"--function-name",
            "videoq-db-start-"+purpose+"-prod","--name","live")
        if not alias.get("FunctionVersion", "").isdigit():
            raise SystemExit("Deploy and verify the immutable AWS starters before provisioning invokers")
    for filename, command, option in [
        ("videoq-neon-plan-deny.json", "put-role-policy", "--policy-document"),
        ("videoq-github-actions-plan-trust.json", "update-assume-role-policy", "--policy-document"),
    ]:
        document=(ROOT/"infra/iam"/filename).read_text().replace("<ACCOUNT_ID>",account)
        args=[AWS,"iam",command,"--role-name","videoq-github-actions-plan",option,document]
        if command=="put-role-policy":args.extend(["--policy-name","deny-protected-neon-credentials"])
        subprocess.run(args,check=True,capture_output=True)
    print("Production planning role restricted to main and denied protected DB secrets")
    profiles=json.loads((ROOT/".github/scripts/neon-profiles.json").read_text())
    parameter=lambda name:f"arn:aws:ssm:{REGION}:{account}:parameter{name}"
    for purpose in ["audit","demo"]:
        environment="production-db-"+purpose
        ensure_environment(environment)
        policy={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameter",
            "Resource":parameter(profiles[purpose]["parameter"])}]}
        install(account,"videoq-github-actions-neon-"+purpose,environment,policy)
        print("Scoped OIDC access configured: "+purpose)
    for purpose in ["maintenance", "migration", "backup", "smoke"]:
        environment="production-db-"+purpose
        ensure_environment(environment)
        policy={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction",
            "Resource":f"arn:aws:lambda:{REGION}:{account}:function:videoq-db-start-{purpose}-prod:live"}]}
        install(account,"videoq-github-actions-db-start-"+purpose,environment,policy,7200,
            secret_name="AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN")
        print("AWS-only operation request access configured: "+purpose)
    bootstrap={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:PutParameter",
        "Resource":parameter("/videoq/security/prod/hyperdrive-credentials")}]}
    install(account,"videoq-github-actions-neon-bootstrap","production-infra",bootstrap,
        secret_name="AWS_GITHUB_ACTIONS_NEON_BOOTSTRAP_ROLE_ARN")
    print("Dedicated AWS invokers configured; retire legacy SSM reader roles only after successful main cutover")


if __name__=="__main__":
    main()
