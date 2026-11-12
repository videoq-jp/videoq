from datetime import datetime
import unittest
from update_policy import WORK_COUNTERS, busy, in_window, release_order


class UpdatePolicyTests(unittest.TestCase):
    def test_daytime_catch_up_never_applies_an_overnight_timer(self):
        self.assertFalse(in_window(datetime.fromisoformat('2026-11-11T00:00:00+00:00')))
        self.assertTrue(in_window(datetime.fromisoformat('2026-11-10T18:00:00+00:00')))
        self.assertFalse(in_window(datetime.fromisoformat('2026-11-10T20:00:00+00:00')))
        self.assertTrue(in_window(datetime.fromisoformat('2026-11-11T01:00:00+09:00'), start=23, end=3))
        with self.assertRaises(ValueError):
            in_window(datetime(2026, 11, 11, 3))

    def test_every_active_work_source_defers_even_when_the_gpu_is_idle(self):
        idle = dict.fromkeys(WORK_COUNTERS, 0)
        self.assertFalse(busy(idle))
        for key in WORK_COUNTERS:
            with self.subTest(key=key):
                self.assertTrue(busy(dict(idle, **{key: 1})))
        for observation in ({}, None, dict(idle, jobs=-1), dict(idle, jobs=False), dict(idle, jobs='0')):
            with self.subTest(observation=observation), self.assertRaises(ValueError):
                busy(observation)

    def test_verified_but_older_releases_cannot_roll_the_installation_back(self):
        current = {'run_id': '100', 'run_attempt': 2, 'source_sha': 'a'*40}
        self.assertFalse(release_order(current, current))
        self.assertTrue(release_order(current, dict(current, run_id='101', run_attempt=1, source_sha='b'*40)))
        for candidate in (dict(current, run_id='99'), dict(current, run_attempt=1), dict(current, source_sha='b'*40)):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                release_order(current, candidate)


if __name__ == '__main__':
    unittest.main()
