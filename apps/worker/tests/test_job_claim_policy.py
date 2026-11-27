import json
from pathlib import Path
import pytest
from worker_python.domain.jobs import job_claim_decision

CASES = json.loads((Path(__file__).parents[3] / 'packages/domain/test/fixtures/job-claim-policy.json').read_text())

@pytest.mark.parametrize('case', CASES)
def test_shared_job_claim_contract(case):
    assert job_claim_decision(case['sameIdentity'], case['status'], case['leaseActive']) == case['result']

from worker_python.domain.jobs import job_lease_mutation_allowed
LEASE_CASES = json.loads((Path(__file__).parents[3] / 'packages/domain/test/fixtures/job-lease-policy.json').read_text())

@pytest.mark.parametrize('case', LEASE_CASES)
def test_shared_job_lease_contract(case):
    assert job_lease_mutation_allowed(case['operation'], case['running'], case['tokenMatches'], case['leaseActive'], lambda *terms: all(terms)) == case['allowed']
