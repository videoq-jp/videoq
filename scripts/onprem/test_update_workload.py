import unittest
from unittest.mock import Mock
from update_workload import QUEUE_ATTRIBUTES, observe


class WorkloadObservationTests(unittest.TestCase):
    def setUp(self):
        self.connection = Mock()
        self.connection.execute.return_value.fetchone.return_value = [dict.fromkeys(
            ('videos', 'uploads', 'jobs', 'visual_runs', 'answers'), 0)]
        self.queue = Mock()
        self.queue.get_queue_attributes.return_value = {'Attributes': dict.fromkeys(QUEUE_ATTRIBUTES.values(), '0')}

    def test_visible_inflight_and_delayed_work_are_all_reported(self):
        self.queue.get_queue_attributes.return_value['Attributes']['ApproximateNumberOfMessagesDelayed'] = '3'
        result = observe(self.connection, self.queue, 'http://queue/videoq')
        self.assertEqual(result['queue_delayed'], 3)
        self.assertEqual(result['queue_inflight'], 0)
        self.assertEqual(result['videos'], 0)

    def test_missing_or_invalid_metrics_are_not_treated_as_idle(self):
        for value in (None, '-1', 'not available', 0, True):
            with self.subTest(value=value):
                self.queue.get_queue_attributes.return_value['Attributes']['ApproximateNumberOfMessages'] = value
                with self.assertRaises(ValueError):
                    observe(self.connection, self.queue, 'http://queue/videoq')
        self.queue.get_queue_attributes.return_value = {'Attributes': {}}
        with self.assertRaises(KeyError):
            observe(self.connection, self.queue, 'http://queue/videoq')

    def test_incomplete_database_snapshot_stops_the_observation(self):
        self.connection.execute.return_value.fetchone.return_value = [{}]
        with self.assertRaises(ValueError):
            observe(self.connection, self.queue, 'http://queue/videoq')
        self.queue.get_queue_attributes.assert_not_called()


if __name__ == '__main__':
    unittest.main()
