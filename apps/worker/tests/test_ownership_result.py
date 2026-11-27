import xml.etree.ElementTree as ET
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest
from scripts.ownership_result import evaluate_run

WITNESS = {'test': 'tests.contract::test_invalid', 'error': 'AssertionError: assert True is False'}


def evidence(mode='bypass'):
    failed = mode not in ('baseline', 'recovery')
    root = ET.fromstring('<testsuites><testsuite><testcase classname="tests.contract" name="test_invalid"/></testsuite></testsuites>')
    if failed:
        ET.SubElement(root.find('.//testcase'), 'failure', message=WITNESS['error']).text = WITNESS['error']
    return dict(mode=mode, returncode=int(failed), report=root,
                transformed={'sites': 1, 'mode': 'baseline' if mode == 'recovery' else mode},
                completion={'exitCode': int(failed), 'collectionErrors': [], 'unhandledErrors': []}, witness=WITNESS)


BASELINE = evaluate_run(**evidence('baseline'))


def mutant():
    return {**evidence(), 'baseline': BASELINE}


def test_reviewed_failure_and_clean_recovery_are_required():
    assert evaluate_run(**mutant())['status'] == 'detected'
    assert evaluate_run(**evidence('recovery'), baseline=BASELINE)['status'] == 'passed'


@pytest.mark.parametrize('message', ['TimeoutError: timed out', 'ConnectionRefusedError: connection refused',
                                    'OSError: ECONNRESET', 'RuntimeError: unknown provider error'])
def test_unrelated_failure_is_not_detection(message):
    value = mutant()
    value['report'].find('.//failure').set('message', message)
    value['report'].find('.//failure').text = message
    assert evaluate_run(**value)['status'] == 'invalid-run'


@pytest.mark.parametrize('kind', ['signal', 'exit', 'completion', 'collection', 'transform', 'wrong-mode',
                                  'witness', 'baseline', 'skipped', 'setup', 'test-set', 'wrong-error', 'unhandled'])
def test_incomplete_or_unrelated_evidence_fails_closed(kind):
    value = mutant()
    if kind == 'signal': value['returncode'] = -9
    elif kind == 'exit': value['returncode'] = 3
    elif kind == 'completion': value['completion'] = None
    elif kind == 'collection': value['completion']['collectionErrors'] = ['collection failed']
    elif kind == 'unhandled': value['completion']['unhandledErrors'] = ['thread crashed']
    elif kind == 'transform': value['transformed'] = None
    elif kind == 'wrong-mode': value['transformed']['mode'] = 'baseline'
    elif kind == 'witness': value['witness'] = None
    elif kind == 'baseline': value['baseline'] = None
    elif kind == 'skipped': ET.SubElement(value['report'].find('.//testcase'), 'skipped')
    elif kind == 'setup': ET.SubElement(value['report'].find('.//testcase'), 'error', message='setup failed')
    elif kind == 'test-set': value['report'].find('.//testcase').set('name', 'unrelated')
    elif kind == 'wrong-error': value['witness'] = {**WITNESS, 'error': 'AssertionError: another reason'}
    assert evaluate_run(**value)['status'] == 'invalid-run'


def test_environment_error_cannot_hide_beside_expected_failure():
    value = mutant()
    value['report'].find('.//failure').text += '\nE   ConnectionRefusedError: connection refused'
    assert evaluate_run(**value)['reason'] == 'environment-failure'


def test_timeout_configuration_in_a_source_excerpt_is_not_an_environment_error():
    value = mutant()
    value['report'].find('.//failure').text += '\n    timeout = httpx.Timeout(30.0)\nE   AssertionError: assert True is False'
    assert evaluate_run(**value)['status'] == 'detected'


def test_failing_or_changed_recovery_is_invalid():
    value = {**mutant(), 'mode': 'recovery', 'transformed': {'sites': 1, 'mode': 'baseline'}}
    assert evaluate_run(**value)['status'] == 'invalid-run'
    clean = evidence('recovery')
    clean['report'].find('.//testcase').set('name', 'replacement')
    assert evaluate_run(**clean, baseline=BASELINE)['reason'] == 'baseline-test-set-changed'


def test_actual_pytest_failures_and_unhandled_thread_are_not_misclassified(tmp_path):
    worker = Path(__file__).resolve().parents[1]
    fixture = tmp_path / 'test_ownership_fixture.py'
    fixture.write_text('''import os, socket, threading
def test_contract():
    scenario = os.environ['OWNERSHIP_FAILURE_FIXTURE']
    if scenario == 'assertion': assert True is False
    elif scenario == 'timeout': raise TimeoutError('timed out waiting for database')
    elif scenario == 'connection':
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            address = server.getsockname()
        with socket.socket() as client: client.connect(address)
    elif scenario == 'unhandled':
        def crash(): raise RuntimeError('out-of-band rejection')
        thread = threading.Thread(target=crash)
        thread.start()
        thread.join()
''')
    baseline = None
    for scenario in ['baseline', 'assertion', 'timeout', 'connection', 'unhandled', 'recovery']:
        xml = tmp_path / (scenario + '.xml')
        receipt = tmp_path / (scenario + '.completion.json')
        env = {**os.environ, 'PYTHONPATH': str(worker / 'scripts'), 'OWNERSHIP_FAILURE_FIXTURE': scenario,
               'OWNERSHIP_COMPLETION_RECEIPT': str(receipt)}
        env.pop('OWNERSHIP_PY_CONTROL', None)
        run = subprocess.run([sys.executable, '-m', 'pytest', '-p', 'ownership_controls', str(fixture),
                              '-q', '--junitxml=' + str(xml)], cwd=worker, env=env,
                             capture_output=True, text=True, timeout=30)
        mode = scenario if scenario in ('baseline', 'recovery') else 'bypass'
        report = ET.parse(xml).getroot() if xml.exists() else None
        if scenario == 'baseline':
            case = report.find('.//testcase')
            test = case.get('classname') + '::' + case.get('name')
        result = evaluate_run(mode=mode, returncode=run.returncode, report=report,
                              transformed={'sites': 1, 'mode': 'baseline' if mode == 'recovery' else mode},
                              completion=json.loads(receipt.read_text()) if receipt.exists() else None,
                              baseline=baseline, witness={'test': test, 'error': 'assert True is False'})
        expected = 'passed' if scenario in ('baseline', 'recovery') else 'detected' if scenario == 'assertion' else 'invalid-run'
        assert result['status'] == expected, (scenario, result, run.stdout, run.stderr)
        if scenario == 'baseline': baseline = result
