"""Short-lived AWS identity for our Workers AI binding proxy; no API key."""
import base64
from contextlib import closing
import json
import math
import os
import threading
import time

import httpx

_LOCK = threading.Lock()
_CACHE: tuple[tuple[str, str], str, float] | None = None


def workload_token(audience: str) -> str:
    global _CACHE
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "")
    if not region:
        raise RuntimeError("Workers AI federation requires AWS_REGION")
    config = (region, audience)
    with _LOCK:
        if _CACHE and _CACHE[0] == config and _CACHE[2] > time.time() + 60:
            return _CACHE[1]
        try:
            import boto3
            from botocore.config import Config

            started = time.time()
            with closing(boto3.client("sts", region_name=region,
                         endpoint_url=f"https://sts.{region}.amazonaws.com",
                         config=Config(connect_timeout=10, read_timeout=10, retries={"max_attempts": 0}))) as sts:
                result = sts.get_web_identity_token(Audience=[audience], SigningAlgorithm="RS256", DurationSeconds=900)
            token = result["WebIdentityToken"]
            if not isinstance(token, str) or len(token) > 16384 or len(token.split(".")) != 3:
                raise ValueError("Invalid STS token")
            part = token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
            expiry = claims["exp"]
            aud = claims.get("aud")
            if (type(expiry) not in (int, float) or not math.isfinite(expiry)
                    or not started + 60 < expiry <= started + 930
                    or aud not in (audience, [audience])):
                raise ValueError("Invalid STS claims")
            # Signature and trust verification occur at the Worker, using AWS JWKS.
            _CACHE = (config, token, min(expiry, started + 900))
            return token
        except Exception:
            # SDK exceptions can contain the identity token or signed requests.
            raise RuntimeError("Workers AI workload identity failed; check AWS issuer, IAM permission and audience") from None


class WorkloadIdentityAuth(httpx.Auth):
    def __init__(self, endpoint: str):
        self.endpoint = endpoint

    def auth_flow(self, request):
        if str(request.url) != self.endpoint:
            raise RuntimeError("Workers AI identity destination mismatch")
        request.headers["Authorization"] = f"Bearer {workload_token(self.endpoint)}"
        yield request
