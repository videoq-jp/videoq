"""Offline plan budgets from the catalog, provider rates and explicit usage assumptions.

Run from the repository root. Defaults reserve Neon Launch costs at 50 paid
contracts, although the current Neon and Mailgun subscriptions are Free.
No credentials, network access, or production mutations are used by this script.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, replace
import json
import math
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PRICES = {
    "llm_input_usd_per_million": 0.15,
    "llm_output_usd_per_million": 0.60,
    "embedding_usd_per_million": 0.02,
    "whisper_usd_per_minute": 0.006,
    "r2_usd_per_gb_month": 0.015,
    "workers_account_usd_per_month": 5,
    "neon_launch_usd_per_cu_hour": 0.106,
    "neon_storage_usd_per_gb_month": 0.35,
    "lambda_arm_tokyo_usd_per_gb_second": 0.0000133334,
    "lambda_ephemeral_tokyo_usd_per_gb_second": 0.000000037,
    "lambda_usd_per_request": 0.0000002,
    "aws_tokyo_egress_usd_per_gb": 0.114,
    "sqs_usd_per_million_requests": 0.40,
    "ecr_usd_per_gb_month": 0.10,
    "stripe_payments_fraction": 0.036,
    "stripe_billing_fraction": 0.007,
}
SOURCES = {
    "openai": "https://developers.openai.com/api/docs/pricing",
    "whisper": "https://developers.openai.com/api/docs/models/whisper-1",
    "stripe": "https://stripe.com/jp/pricing",
    "r2": "https://developers.cloudflare.com/r2/pricing/",
    "workers": "https://developers.cloudflare.com/workers/platform/pricing/",
    "hyperdrive": "https://developers.cloudflare.com/hyperdrive/platform/pricing/",
    "neon": "https://neon.com/pricing",
    "mailgun": "https://www.mailgun.com/pricing/",
    "lambda_tokyo": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/ap-northeast-1/index.json",
    "aws_transfer_tokyo": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-northeast-1/index.json",
    "sqs": "https://aws.amazon.com/sqs/pricing/",
    "ecr": "https://aws.amazon.com/ecr/pricing/",
    "cloudwatch": "https://aws.amazon.com/cloudwatch/pricing/",
}


@dataclass(frozen=True)
class Assumptions:
    paid_contracts: int = 50
    usd_jpy: float = 160
    free_accounts: int = 13  # All observed plan-managed Free accounts, at FULL quota.
    neon_cu: float = 0.25
    neon_active_hours: float = 730
    mailgun_monthly_usd: float = 0
    transcription_usd_per_minute: float = PRICES["whisper_usd_per_minute"]
    lambda_seconds_per_video_minute: float = 6  # 60 seconds / 10-minute upload; NOT measured.
    video_minutes_per_upload: float = 10
    lambda_outbound_bytes_per_video_minute: int = 480000 + 65536  # 64kbps audio + DB/index allowance.
    ingestion_retry_fraction: float = 0.03
    transcript_tokens_per_minute: float = 600  # Observed uploaded corpus: ~257.5; reserve >2x.
    embedding_passes: int = 2  # Scene splitting, then vector index.
    database_horizon_months: int = 12  # Year-end footprint; not an enforced retention policy.
    database_bytes_per_answer: int = 16384  # Observed relation/index bytes per answer: ~10923.
    database_bytes_per_video_minute: int = 16384
    domain_and_misc_monthly_yen: float = 300  # Unverified planning reserve, not an invoice.
    human_operations_monthly_yen: float = 0  # No salary or outsourced support budget supplied.
    monitoring_and_logs_monthly_usd: float = 4  # Itemized reserve described in evidence file.
    other_cloud_monthly_usd: float = 0.10  # SNS/KMS/state storage reserve.
    tax_reserve_fraction: float = 0.10
    planning_answer_cost_yen: float = 1.0  # Provisional until attempt-level usage and invoice totals reconcile.

    def validate(self) -> None:
        for name, value in asdict(self).items():
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and nonnegative")
        for name in ("paid_contracts", "usd_jpy", "video_minutes_per_upload", "database_horizon_months"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        if self.neon_active_hours > 744:
            raise ValueError("neon_active_hours cannot exceed 31 days")


def read_catalog() -> dict:
    uri = (ROOT / "packages/domain/src/billing-catalog.ts").as_uri()
    return json.loads(subprocess.check_output([
        "node", "--import", "tsx", "--input-type=module", "-e",
        f"import {{ PLAN_CATALOG }} from {json.dumps(uri)}; "
        "process.stdout.write(JSON.stringify(PLAN_CATALOG));",
    ], text=True, cwd=ROOT))


def answer_scenarios(a: Assumptions) -> list[dict]:
    measured = json.loads((ROOT / "docs/verification/issue-996-comparison.json").read_text())["summary"]["course"]
    scenarios = []
    for name, inputs, outputs in [
        ("short_answer_fixture", measured["inputTokens"]["structured"], measured["outputTokens"]["structured"]),
        ("planning", 8000, 600), ("large_single_search", 15000, 1200),
        ("multiple_searches", 60000, 3000),
    ]:
        raw = (inputs * PRICES["llm_input_usd_per_million"] + outputs * PRICES["llm_output_usd_per_million"]
               + 1000 * PRICES["embedding_usd_per_million"]) / 1e6 * a.usd_jpy
        scenarios.append({"name": name, "total_input_tokens": inputs, "total_output_tokens": outputs,
                          "query_embedding_tokens": 1000, "failure_cost_allowance_fraction": 0.15,
                          "answer_cost_yen": raw * 1.15, "evaluation_cost_yen": 0})
    return scenarios


def fixed_costs(a: Assumptions) -> dict[str, float]:
    # All shared expenses are charged once for the service, then divided by N.
    return {
        "workers_including_hyperdrive": PRICES["workers_account_usd_per_month"] * a.usd_jpy,
        "neon_compute_reserve": a.neon_cu * a.neon_active_hours * PRICES["neon_launch_usd_per_cu_hour"] * a.usd_jpy,
        "neon_existing_database_0_1gb": 0.1 * PRICES["neon_storage_usd_per_gb_month"] * a.usd_jpy,
        "mailgun": a.mailgun_monthly_usd * a.usd_jpy,
        "ecr_1gb": PRICES["ecr_usd_per_gb_month"] * a.usd_jpy,
        "r2_account_storage_rounding": PRICES["r2_usd_per_gb_month"] * a.usd_jpy,
        "monitoring_and_logs_reserve": a.monitoring_and_logs_monthly_usd * a.usd_jpy,
        # Max concurrency disables the 2-poller idle optimization; reserve 5 long-pollers.
        "sqs_idle_polling": 5 * 730 * 3600 / 20 / 1e6 * PRICES["sqs_usd_per_million_requests"] * a.usd_jpy,
        "sns_kms_state_reserve": a.other_cloud_monthly_usd * a.usd_jpy,
        "domain_and_misc_reserve": a.domain_and_misc_monthly_yen,
        "human_operations": a.human_operations_monthly_yen,
    }


def chat_storage_per_answer(a: Assumptions) -> float:
    return a.database_bytes_per_answer * a.database_horizon_months / 1e9 * PRICES["neon_storage_usd_per_gb_month"] * a.usd_jpy


def non_answer_variable_costs(plan: dict, a: Assumptions) -> dict[str, float]:
    limits = plan["entitlements"]
    minutes = limits["processingLimitMinutes"]
    jobs = minutes / a.video_minutes_per_upload * 2
    seconds = minutes * a.lambda_seconds_per_video_minute
    whisper = minutes * a.transcription_usd_per_minute * a.usd_jpy
    # Existing Lambda: 5120 MiB memory + /tmp, ARM64. First 512 MiB /tmp is free.
    worker = (seconds * (5 * PRICES["lambda_arm_tokyo_usd_per_gb_second"]
                         + 4.5 * PRICES["lambda_ephemeral_tokyo_usd_per_gb_second"])
              + jobs * PRICES["lambda_usd_per_request"]) * a.usd_jpy
    embeddings = minutes * a.transcript_tokens_per_minute * a.embedding_passes / 1e6 * PRICES["embedding_usd_per_million"] * a.usd_jpy
    outbound = minutes * a.lambda_outbound_bytes_per_video_minute / 1e9 * PRICES["aws_tokyo_egress_usd_per_gb"] * a.usd_jpy
    return {
        "whisper": whisper,
        "r2_storage": limits["storageLimitGb"] * (1024**3 / 1e9) * PRICES["r2_usd_per_gb_month"] * a.usd_jpy,
        "transcription_and_indexing_lambda": worker,
        "ingestion_embeddings": embeddings,
        "lambda_outbound_transfer": outbound,
        "ingestion_retry_reserve": (whisper + worker + embeddings + outbound) * a.ingestion_retry_fraction,
        "database_video_growth": minutes * a.database_bytes_per_video_minute * a.database_horizon_months / 1e9 * PRICES["neon_storage_usd_per_gb_month"] * a.usd_jpy,
        "sqs_job_operations": jobs * 3 / 1e6 * PRICES["sqs_usd_per_million_requests"] * a.usd_jpy,
    }


def calculate(catalog: dict, a: Assumptions) -> dict:
    a.validate()
    scenarios = answer_scenarios(a)
    answer_cost = a.planning_answer_cost_yen
    db_per_answer = chat_storage_per_answer(a)
    fixed = fixed_costs(a)
    free_variable = non_answer_variable_costs(catalog["free"], a)
    free_full_cost = sum(free_variable.values()) + catalog["free"]["entitlements"]["aiAnswersLimit"] * (answer_cost + db_per_answer)
    shared = (sum(fixed.values()) + a.free_accounts * free_full_cost) / a.paid_contracts
    plans = []
    for code in ("basic", "pro"):
        plan = catalog[code]
        variable = non_answer_variable_costs(plan, a)
        count = plan["entitlements"]["aiAnswersLimit"]
        for interval, months in (("monthly", 1), ("yearly", 12)):
            gross = plan["displayAmountYen"][interval] / months
            fees = gross * (PRICES["stripe_payments_fraction"] + PRICES["stripe_billing_fraction"])
            net = gross / (1 + a.tax_reserve_fraction) - fees
            before_chat_storage = net - sum(variable.values()) - shared
            maximum = max(0, math.floor(before_chat_storage / (answer_cost + db_per_answer)))
            budget = before_chat_storage - count * db_per_answer
            rounded = maximum // 100 * 100
            plans.append({
                "plan": code, "interval": interval, "monthly_answers": count,
                "gross_monthly_yen": gross, "stripe_fees_yen": fees,
                "after_tax_reserve_and_stripe_yen": net, "variable_non_answer_yen": variable,
                "shared_fixed_cost_per_contract_yen": sum(fixed.values()) / a.paid_contracts,
                "free_account_subsidy_per_contract_yen": a.free_accounts * free_full_cost / a.paid_contracts,
                "database_chat_growth_yen": count * db_per_answer,
                "answer_budget_yen": budget, "planning_answer_cost_yen": answer_cost,
                "planning_max_answers": maximum, "recommended_answers_rounded_to_100": rounded,
                "recommended_answer_budget_yen": before_chat_storage - rounded * db_per_answer,
                "planning_balance_yen": budget - count * answer_cost,
                "max_average_answer_cost_yen": max(0, budget) / count,
                "scenario_balances_yen": {s["name"]: budget - count * s["answer_cost_yen"] for s in scenarios},
            })
    return {"assumptions": asdict(a), "fixed_monthly_yen": fixed, "fixed_monthly_total_yen": sum(fixed.values()),
            "free_account_full_variable_cost_yen": free_full_cost, "free_account_subsidy_monthly_yen": a.free_accounts * free_full_cost,
            "database_chat_cost_per_monthly_answer_yen": db_per_answer, "answer_scenarios": scenarios, "plans": plans}


def report(catalog: dict, a: Assumptions) -> dict:
    base = calculate(catalog, a)
    sensitivity = []
    cases = [(f"paid_{n}", replace(a, paid_contracts=n)) for n in (10, 30, 50, 100)]
    cases += [("neon_compute_reserve_unspent", replace(a, neon_cu=0)),
              ("neon_0_5cu_always_on", replace(a, neon_cu=0.5)),
              ("mailgun_basic", replace(a, mailgun_monthly_usd=15)),
              ("lambda_3x_slower", replace(a, lambda_seconds_per_video_minute=a.lambda_seconds_per_video_minute * 3)),
              ("free_accounts_50", replace(a, free_accounts=50)),
              ("free_accounts_100", replace(a, free_accounts=100)),
              ("database_24_months", replace(a, database_horizon_months=24)),
              ("usd_jpy_170", replace(a, usd_jpy=170)),
              ("human_operations_10000_yen", replace(a, human_operations_monthly_yen=10000))]
    for name, assumptions in cases:
        result = calculate(catalog, assumptions)
        sensitivity.append({"name": name, "fixed_cost_per_contract_yen": result["fixed_monthly_total_yen"] / assumptions.paid_contracts,
                            "annual_plans": [{k: p[k] for k in ("plan", "answer_budget_yen", "planning_max_answers", "planning_balance_yen")}
                                             for p in result["plans"] if p["interval"] == "yearly"]})
    return {"date": "2026-10-23", "sources": SOURCES, "prices": PRICES,
            "evidence": "docs/verification/operating-cost-evidence-2026-10-02.json", **base,
            "included_usage_conditions": {
                "r2": "Class A <= 1M/month and Class B <= 10M/month for the entire account; operations then $0. Storage modeled at full rate without the shared 10GB credit. Overage rounds up to million-operation units: $4.50/$0.36, allocated once per account.",
                "workers": "Entire account <= 10M requests and 30M CPU-ms/month. Static asset requests and network waiting are not CPU time. Paid-plan included logs/DO usage must also remain within limits.",
                "durable_objects": "Entire account <= 1M requests, 400k GB-s, 5GB SQLite storage, 25B row reads and 50M row writes/month.",
                "mailgun": "Free <= 100 emails/day and 1 sending domain. Not 3,000 emails usable at any time. Basic scenario reserves $15/month.",
                "neon": "Current plan Free: 100 CU-hours, 1GB storage and 5GB egress/project. Default budget reserves Launch at 0.25 CU continuously; no Free credits subtracted from paid Launch. Launch egress <= 500GB/project/month; restore-history/snapshots not included.",
            },
            "limitations": [
                "Subscription prices are unchanged. Annual subscriptions determine the common answer quota; no monthly-plan cross-subsidy is required.",
                "This is a conditional cash operating budget, not a measured invoice or guaranteed company profit. Owner labor is zero unless supplied; ads, payroll, refunds, chargebacks and tax treatment are not audited.",
                "50 paid contracts is the target allocation base, not the currently observed subscriber count. Free subsidy covers 13 existing plan-managed accounts at full quota; change this count as acquisition grows. Admin overrides/developer experiments are outside these plan budgets.",
                "Lambda minutes could not be joined to surviving videos, so 6 billed seconds/video-minute is a planning assumption, including transcription, indexing, cold starts and waiting. Three-percent ingestion retry reserve is also assumed.",
                "The planning answer cost is a provisional per-answer reserve, not a measured production average. Historical token scenarios use gpt-4o-mini rates and are illustrative only; actual model calls, retries, cache usage and invoice reconciliation must be measured separately.",
                "DB footprint is reserved at month 12 with no deletions; this does not add a retention policy. Actual growth, compute autoscaling and retained history require periodic recalculation.",
                "RAGAS and its evaluation Lambda jobs contribute zero after deployment. The observed production job sample still includes the old implementation.",
                "AWS free credits are not deducted; unrelated account-wide bills are not allocated to VideoQ. FX 160 is a budgeting rate, not a verified spot exchange rate.",
            ], "sensitivity": sensitivity}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    defaults = Assumptions()
    for name, default in asdict(defaults).items():
        numeric_type = int if Assumptions.__annotations__[name] == "int" else float
        parser.add_argument('--' + name.replace('_', '-'), type=numeric_type, default=default)
    args = parser.parse_args()
    try:
        assumptions = Assumptions(**vars(args))
        assumptions.validate()
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(report(read_catalog(), assumptions), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
