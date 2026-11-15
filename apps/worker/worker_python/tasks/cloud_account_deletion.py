"""Cloud account deletion through leased API steps; no SQL or media imports."""
from worker_python.internal_api import call_internal_api


def delete_account_data(user_id: str, *, job_id: str, lease_token: str) -> None:
    identity = {"jobId": job_id, "leaseToken": lease_token}
    for _ in range(500):
        if call_internal_api("heartbeat", identity).get("updated") is not True:
            raise RuntimeError("Account deletion execution lease was lost")
        status = call_internal_api("account-delete/step", {**identity, "userId": user_id}).get("status")
        if status == "completed":
            return
        if status != "progress":
            raise RuntimeError("Account deletion authorization was lost")
    # Durable row deletion is the cursor. A later SQS delivery resumes safely.
    raise RuntimeError("Account deletion step budget exhausted; retry remaining work")
