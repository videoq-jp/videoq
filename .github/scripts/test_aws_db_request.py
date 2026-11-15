import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("aws_db", Path(__file__).with_name("run-aws-db.py"))
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)
RUN = "a" * 32


class RequestTest(unittest.TestCase):
    def test_busy_and_transient_failures_keep_the_same_request_and_execution(self):
        calls, waits = [], []
        responses = iter([{"status": "BUSY"}, {"status": "RUNNING", "run_id": RUN},
                          RuntimeError("network unavailable"), {"status": "SUCCEEDED", "run_id": RUN}])

        def invoke(function, request):
            calls.append((function, request))
            response = next(responses)
            if isinstance(response, Exception):
                raise response
            return response

        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(db.run("rotate", {"force": False}, invoke, waits.append, lambda: 0), RUN)
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertEqual(calls[2][1], {"action": "status", "run_id": RUN})
        self.assertEqual(calls[2], calls[3])
        self.assertEqual(waits, [15, 15, 15])
        self.assertTrue(calls[0][0].endswith(":function:videoq-db-start-maintenance-prod:live"))

    def test_terminal_failures_never_restart_the_operation(self):
        calls = []

        def invoke(function, request):
            calls.append(request)
            return {"status": "FAILED", "run_id": RUN}

        with patch("sys.stdout", new_callable=io.StringIO), self.assertRaisesRegex(RuntimeError, "AWS_DATABASE_OPERATION_FAILED"):
            db.run("migration", {"source_sha": "b" * 40}, invoke, lambda _: None, lambda: 0)
        self.assertEqual(len(calls), 1)

    def test_arbitrary_error_bodies_and_invalid_run_ids_are_not_forwarded(self):
        for response, expected in [({"status": "REJECTED", "reason": "password=private"}, "AWS_REQUEST_REJECTED"),
                                   ({"status": "RUNNING", "run_id": "private-url"}, "INVALID_AWS_RUN_ID"),
                                   ({"status": "SUCCEEDED"}, "MISSING_AWS_RUN_ID")]:
            with self.subTest(response=response), patch("sys.stdout", new_callable=io.StringIO), self.assertRaisesRegex(RuntimeError, expected):
                db.run("backup", {}, lambda *a: response, lambda _: None, lambda: 0)

    def test_repeated_observation_errors_stop_without_creating_new_start_tokens(self):
        requests = []

        def invoke(function, request):
            requests.append(request)
            raise RuntimeError("private AWS diagnostic")

        with self.assertRaisesRegex(RuntimeError, "AWS_EXECUTION_OBSERVATION_FAILED"):
            db.run("audit", {}, invoke, lambda _: None, lambda: 0)
        self.assertEqual(len(requests), 5)
        self.assertTrue(all(value == requests[0] for value in requests))

    def test_explicit_login_fence_audit_only_adds_fixed_metadata_to_the_request(self):
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "videoq-jp/videoq", "GITHUB_REF": "refs/heads/main"}), patch.object(db, "run", return_value=RUN) as run:
            with patch("sys.argv", ["request", "audit", "--inspection", "postgres-login-fence"]):
                db.main()
            run.assert_called_once_with("audit", {"inspection": "postgres-login-fence"})
            run.reset_mock()
            with patch("sys.argv", ["request", "audit"]):
                db.main()
            run.assert_called_once_with("audit", {})
            run.reset_mock()
            with patch("sys.argv", ["request", "rotate", "--inspection", "postgres-login-fence"]), self.assertRaisesRegex(RuntimeError, "INVALID_AUDIT_INSPECTION"):
                db.main()
            run.assert_not_called()

    def test_cutover_acquire_returns_the_owned_running_handle_without_waiting_or_restarting(self):
        calls, waits = [], []
        def invoke(function, request):
            calls.append((function, request))
            return {"status": "RUNNING", "run_id": RUN}
        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(db.run("cutover-hold", {"source_sha": "b" * 40}, invoke, waits.append, lambda: 0), RUN)
        self.assertEqual(len(calls), 1)
        self.assertEqual(waits, [])
        self.assertTrue(calls[0][0].endswith(":videoq-db-start-maintenance-prod:live"))
        for state in ["SUCCEEDED", "RECOVERED"]:
            with patch("sys.stdout", new_callable=io.StringIO), self.assertRaisesRegex(RuntimeError, "ALREADY_RELEASED"):
                db.run("cutover-hold", {"source_sha": "b" * 40}, lambda *args: {"status": state, "run_id": RUN}, waits.append, lambda: 0)

    def test_cutover_release_observes_the_same_execution_and_never_turns_failure_into_recovery(self):
        calls, waits = [], []
        replies = iter([{"status": "RUNNING", "run_id": RUN}, RuntimeError("observation lost"), {"status": "SUCCEEDED", "run_id": RUN}])
        def invoke(function, payload):
            calls.append(payload)
            result = next(replies)
            if isinstance(result, Exception):
                raise result
            return result
        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(db.control_cutover("release-cutover-hold", RUN, invoke, waits.append, lambda: 0), RUN)
        self.assertEqual(calls, [{"action": "release-cutover-hold", "run_id": RUN}, {"action": "status", "run_id": RUN}, {"action": "status", "run_id": RUN}])
        self.assertEqual(waits, [15, 15])
        calls.clear()
        def failed(function, payload):
            calls.append(payload)
            return {"status": "FAILED", "run_id": RUN}
        with patch("sys.stdout", new_callable=io.StringIO), self.assertRaisesRegex(RuntimeError, "CUTOVER_RECOVERY_REQUIRED"):
            db.control_cutover("release-cutover-hold", RUN, failed, waits.append, lambda: 0)
        self.assertEqual(len(calls), 1)
        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(db.control_cutover("recover-cutover-hold", RUN, lambda *args: {"status": "RECOVERED", "run_id": RUN}, waits.append, lambda: 0), RUN)
        with self.assertRaisesRegex(RuntimeError, "AWS_EXECUTION_CHANGED"):
            db.control_cutover("recover-cutover-hold", RUN, lambda *args: {"status": "RECOVERED"}, waits.append, lambda: 0)

    def test_consumer_preparation_waits_for_ready_on_the_same_hold(self):
        replies = iter([{"status": "RUNNING", "run_id": RUN}, {"status": "RUNNING", "run_id": RUN, "consumer_prepared": True}])
        calls = []
        def invoke(function, payload):
            calls.append(payload)
            return next(replies)
        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(db.control_cutover("prepare-cutover-consumers", RUN, invoke, lambda _: None, lambda: 0), RUN)
        self.assertEqual(calls, [{"action": "prepare-cutover-consumers", "run_id": RUN}, {"action": "status", "run_id": RUN}])
        for state in ["SUCCEEDED", "RECOVERED"]:
            with patch("sys.stdout", new_callable=io.StringIO), self.assertRaises(RuntimeError):
                db.control_cutover("prepare-cutover-consumers", RUN, lambda *args: {"status": state, "run_id": RUN}, lambda _: None, lambda: 0)

    def test_consumer_controls_wait_for_their_own_receipts_and_never_infer_recovery(self):
        for action, flag in [("pause-cutover-consumers", "consumers_paused"), ("resume-cutover-consumers", "consumers_restored")]:
            calls = []
            replies = iter([{"status": "RUNNING", "run_id": RUN}, {"status": "RUNNING", "run_id": RUN, flag: True}])
            def invoke(function, payload):
                calls.append(payload)
                return next(replies)
            with patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(db.control_cutover(action, RUN, invoke, lambda _: None, lambda: 0), RUN)
            self.assertEqual(calls, [{"action": action, "run_id": RUN}, {"action": "status", "run_id": RUN}])
            with patch("sys.stdout", new_callable=io.StringIO), self.assertRaises(RuntimeError):
                db.control_cutover(action, RUN, lambda *args: {"status": "RECOVERED", "run_id": RUN}, lambda _: None, lambda: 0)
        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(db.control_cutover("retry-cutover-consumers", RUN, lambda *args: {"status": "RUNNING", "run_id": RUN, "consumer_retry_accepted": True}, lambda _: None, lambda: 0), RUN)


if __name__ == "__main__":
    unittest.main()
