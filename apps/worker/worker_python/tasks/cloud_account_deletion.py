"""Cloud account deletion through leased API steps; no SQL or media imports."""
from worker_python.internal_api import call_internal_api

from worker_python.use_cases.account_deletion import execute_leased_account_deletion


def delete_account_data(user_id: str, *, job_id: str, lease_token: str) -> None:
    identity = {"jobId": job_id, "leaseToken": lease_token}
    execute_leased_account_deletion(
        renew=lambda: call_internal_api("heartbeat", identity).get("updated") is True,
        step=lambda: call_internal_api("account-delete/step", {**identity, "userId": user_id}).get("status"),
    )
