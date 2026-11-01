import importlib.util
import io
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


if __name__ == "__main__":
    unittest.main()
