"""Shared credential HTTP and configuration guards for AWS key maintenance."""
import json
from urllib.error import HTTPError
from urllib.request import Request, HTTPRedirectHandler, build_opener



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


