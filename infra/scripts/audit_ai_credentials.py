"""Read-only inventory for retiring hosted AI credentials; never output secret values."""
import json
import os
import re
import sys
from contextlib import closing
from urllib.error import HTTPError
from urllib.request import Request, HTTPRedirectHandler, build_opener

AI_KEYS = ("OPENAI_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY", "EMBEDDING_API_KEY")
BASE_KEYS = ("OPENAI_BASE_URL", "LLM_BASE_URL", "EMBEDDING_BASE_URL")
PROJECT_ID = "proj_gJhot9A6qlH7E1nAze2Z33sH"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_json(url, token):
    request = Request(url, headers={"Authorization": "Bearer " + token}, method="GET")
    with build_opener(NoRedirect).open(request, timeout=20) as response:
        return json.load(response)


def error_summary(error):
    result = {"errorType": type(error).__name__}
    code = getattr(error, "response", {}).get("Error", {}).get("Code")
    if code in {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "NoSuchEntity", "ParameterNotFound"}:
        result["awsErrorCode"] = code
    if isinstance(error, HTTPError):
        result["httpStatus"] = error.code
        error.close()
    return result


def selected_presence(values):
    return {key: bool(values.get(key)) for key in AI_KEYS}


def router_configuration(values):
    return {
        "federationConfigured": bool(values.get("OPENROUTER_FEDERATION_POLICY_ID")),
        "openRouterBase": values.get("OPENAI_BASE_URL", "").rstrip("/") == "https://openrouter.ai/api/v1",
        "purposeBaseOverrides": [key for key in BASE_KEYS[1:] if values.get(key)],
    }


def audit(session, environ):
    result = {"status": "ai_credential_audit", "readOnly": True}
    try:
        with closing(session.client("ssm")) as client:
            parameter = client.get_parameter(Name="/videoq/prod/app", WithDecryption=True)["Parameter"]
            payload = json.loads(parameter["Value"])
            if not isinstance(payload, dict):
                raise ValueError("Invalid parameter format")
            result["workerSecretCopies"] = {"version": parameter["Version"], "present": selected_presence(payload),
                "purposeBaseOverrides": [key for key in BASE_KEYS[1:] if payload.get(key)]}
    except Exception as error:
        result["workerSecretCopies"] = error_summary(error)
    try:
        with closing(session.client("lambda")) as client:
            config = client.get_function_configuration(FunctionName="videoq-worker-prod")
            values = config.get("Environment", {}).get("Variables", {})
            result["worker"] = {**router_configuration(values), "secretCopies": selected_presence(values)}
    except Exception as error:
        result["worker"] = error_summary(error)
    try:
        account = environ["CLOUDFLARE_ACCOUNT_ID"]
        if not re.fullmatch(r"[a-f0-9]{32}", account):
            raise ValueError("Invalid account ID")
        data = api_json(f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/videoq-api/settings", environ["CLOUDFLARE_API_TOKEN"])
        if data.get("success") is not True:
            raise ValueError("Settings unavailable")
        bindings = data["result"]["bindings"]
        values = {binding["name"]: binding.get("text", "") for binding in bindings if binding.get("type") == "plain_text"}
        names = {binding["name"] for binding in bindings if binding.get("type") == "secret_text"}
        result["api"] = {**router_configuration(values), "secretCopies": {key: key in names for key in AI_KEYS},
                         "awsStaticKeyPresent": {key: key in names for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")}}
    except Exception as error:
        result["api"] = error_summary(error)
    try:
        project = api_json(f"https://api.openai.com/v1/organization/projects/{PROJECT_ID}", environ["OPENAI_ADMIN_KEY"])
        if project.get("id") != PROJECT_ID or project.get("name") != "videoq-prod":
            raise ValueError("Project identity mismatch")
        keys, after = [], ""
        for _ in range(20):
            data = api_json(f"https://api.openai.com/v1/organization/projects/{PROJECT_ID}/api_keys?limit=100" + ("&after="+after if after else ""), environ["OPENAI_ADMIN_KEY"])
            for entry in data["data"]:
                key_id = entry["id"]
                if not re.fullmatch(r"key_[A-Za-z0-9_-]+", key_id):
                    raise ValueError("Invalid key identifier")
                keys.append(key_id)
            if not data.get("has_more"):
                break
            after = data["last_id"]
            if not re.fullmatch(r"key_[A-Za-z0-9_-]+", after):
                raise ValueError("Invalid page cursor")
        else:
            raise ValueError("Inventory exceeds page limit")
        result["openaiProject"] = {"projectId": PROJECT_ID, "projectVerified": True, "projectStatus": project.get("status"), "keyIds": keys, "keyCount": len(keys)}
    except Exception as error:
        result["openaiProject"] = error_summary(error)
    return result


if __name__ == "__main__":
    import boto3
    result = audit(boto3.Session(), os.environ)
    print(json.dumps(result))
    sys.exit(1 if any(isinstance(value, dict) and "errorType" in value for value in result.values()) else 0)
