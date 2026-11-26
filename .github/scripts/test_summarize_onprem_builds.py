import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).with_name('summarize-onprem-builds.py'))
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class BuildComparisonTest(unittest.TestCase):
    def reports(self):
        return [{'source': 'a' * 40, 'parallelism': parallelism, 'failedBuilds': 0, 'platform': 'linux/amd64',
            'runs': [{'seconds': 100 / parallelism}, {'seconds': 10 / parallelism}],
            'seconds': 110 / parallelism, 'before': {'diskFreeBytes': 1000, 'cpus': 4, 'memoryTotal': '16GiB'},
            'after': {'diskFreeBytes': 500}, 'resourceSamples': [{'diskFreeBytes': 100}],
            'cacheControl': {'sameInputReused': True, 'changedInputInvalidated': True}}
            for parallelism in [1, 1, 2, 2]]

    def test_comparison_keeps_repetitions_and_runner_cost(self):
        result = comparison.summarize(self.reports())
        self.assertEqual(result['coldMeanRatio'], 0.5)
        self.assertEqual(result['strategies']['2']['coldSeconds'], [50, 50])
        self.assertEqual(result['strategies']['2']['measuredBuildRunnerSeconds'], 110)
        self.assertEqual(result['strategies']['2']['minDiskFreeBytes'], 100)

    def test_incomparable_or_failed_reports_cannot_support_adoption(self):
        reports = self.reports()
        mutations = [lambda x: x.pop(), lambda x: x[0].update(source='b' * 40),
            lambda x: x[0].update(failedBuilds=1), lambda x: x[0]['runs'].pop(),
            lambda x: x[0]['cacheControl'].update(changedInputInvalidated=False),
            lambda x: x[0]['before'].update(cpus=2),
            lambda x: x[0]['runs'][0].update(seconds=0),
            lambda x: x[0].update(parallelism=2)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                changed = copy.deepcopy(reports)
                mutate(changed)
                with self.assertRaises(ValueError):
                    comparison.summarize(changed)
