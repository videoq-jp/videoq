"""Host/allocation gate regressions. Fixtures are not hardware acceptance."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("rtx4090-preflight.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def test_refuses_other_hardware_and_multiple_devices(self):
        os_release = {"ID": "ubuntu", "VERSION_ID": "24.04"}
        gpu = "NVIDIA GeForce RTX 4090, GPU-1234-5678, 24564"
        self.assertEqual(preflight.validate_host("Linux", "x86_64", os_release, gpu)["uuid"], "GPU-1234-5678")
        for system, arch, release, inventory in [
            ("Darwin", "arm64", os_release, gpu),
            ("Linux", "aarch64", os_release, gpu),
            ("Linux", "x86_64", {"ID": "ubuntu", "VERSION_ID": "22.04"}, gpu),
            ("Linux", "x86_64", os_release, gpu + "\n" + gpu),
            ("Linux", "x86_64", os_release, gpu.replace("4090", "3090")),
            ("Linux", "x86_64", os_release, gpu.replace("24564", "16000")),
            ("Linux", "x86_64", os_release, ""),
        ]:
            with self.subTest(inventory=inventory), self.assertRaises(ValueError):
                preflight.validate_host(system, arch, release, inventory)

    def test_refuses_unshared_capacity_or_wrong_node(self):
        node = {"metadata": {"labels": {"kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux", "videoq.io/inference-target": "rtx4090"}},
                "status": {"allocatable": {"nvidia.com/gpu.shared": "3"}, "conditions": [{"type": "Ready", "status": "True"}]}}
        preflight.validate_node(node)
        for resources in [{"nvidia.com/gpu": "1"}, {"nvidia.com/gpu.shared": "6"}, {"nvidia.com/gpu.shared": "3", "nvidia.com/gpu": "1"}]:
            invalid = copy.deepcopy(node)
            invalid["status"]["allocatable"] = resources
            with self.assertRaises(ValueError):
                preflight.validate_node(invalid)
        invalid = copy.deepcopy(node)
        del invalid["metadata"]["labels"]["videoq.io/inference-target"]
        with self.assertRaises(ValueError):
            preflight.validate_node(invalid)

    def test_requires_three_ready_independent_pinned_allocations_on_one_node(self):
        pods = []
        for role, name in preflight.ROLES.items():
            pods.append({"metadata": {"name": role + "-fixture", "labels": {"app.kubernetes.io/component": role}},
                         "spec": {"nodeName": "workstation", "runtimeClassName": "nvidia", "containers": [
                             {"name": name, "image": "ghcr.io/videoq-jp/videoq-vllm@sha256:" + "a" * 64,
                              "resources": {"requests": {"nvidia.com/gpu.shared": "1"}, "limits": {"nvidia.com/gpu.shared": "1"}}}]},
                         "status": {"containerStatuses": [{"name": name, "ready": True}]}})
        self.assertEqual(set(preflight.validate_pods(pods, "workstation")), set(preflight.ROLES))
        with self.assertRaises(ValueError):
            preflight.validate_pods(pods[:2], "workstation")
        invalid = copy.deepcopy(pods)
        invalid[2]["spec"]["containers"].append({"name": "whisper", "resources": {"limits": {"nvidia.com/gpu.shared": "1"}}})
        invalid[2]["status"]["containerStatuses"].append({"name": "whisper", "ready": True})
        with self.assertRaises(ValueError):
            preflight.validate_pods(invalid, "workstation")
        for mutation in [
            lambda p: p[0]["spec"].update(nodeName="other"),
            lambda p: p[0]["spec"]["containers"][0].update(image="vllm:latest"),
            lambda p: p[0]["status"]["containerStatuses"][0].update(ready=False),
            lambda p: p[0]["spec"]["containers"][0]["resources"]["limits"].update({"nvidia.com/gpu": "1"}),
            lambda p: p.append(copy.deepcopy(p[0])),
        ]:
            invalid = copy.deepcopy(pods)
            mutation(invalid)
            with self.assertRaises(ValueError):
                preflight.validate_pods(invalid, "workstation")


if __name__ == "__main__":
    unittest.main()
