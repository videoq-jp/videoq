import copy
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('measured', Path(__file__).with_name('build-onprem-measured.py'))
measured = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measured)


class ResourceProtocolTest(unittest.TestCase):
    def fixture(self):
        builder = {'Name': 'owned', 'Driver': 'docker-container', 'Nodes': [{'Name': 'owned0', 'Status': 'running', 'Version': 'v0.35.1', 'Endpoint': 'unix:///var/run/docker.sock'}]}
        context = {'Name': 'default', 'Endpoints': {'docker': {'Host': 'unix:///var/run/docker.sock'}}}
        container = {'Id': 'a' * 64, 'Name': '/buildx_buildkit_owned0', 'Config': {'Image': measured.CONTROLLED_BUILDKIT_IMAGE}, 'State': {'Running': True}, 'HostConfig': {'CpuPeriod': 100000, 'CpuQuota': 400000, 'Memory': 8 * 1024**3, 'MemorySwap': 8 * 1024**3, 'CpusetCpus': ''}}
        return builder, context, container

    def check(self, fixture):
        b,c,i=fixture
        with patch.dict(measured.os.environ, {}, clear=True), patch.object(measured, 'host_cpu_envelope', return_value=({0,1,2,3},None)), patch.object(measured.subprocess, 'check_output', side_effect=[json.dumps(b),json.dumps([c]),json.dumps([i]), 'Cpus_allowed_list: 0-3\n', '400000 100000\n8589934592\n0\n']) as execute:
            result = measured.inspect_builder_limits('owned', 4, 8 * 1024**3)
            self.assertEqual(execute.call_args_list[2].args[0], ['docker','container','inspect','buildx_buildkit_owned0'])
            return result

    def test_effective_limits_bound_to_selected_local_single_node(self):
        self.assertEqual(self.check(self.fixture())['node'], 'owned0')
        for control in ['wrong-builder','wrong-driver','multi-node','remote-endpoint','wrong-container','wrong-image','stopped','cpu-period','cpu-quota','memory','swap','cpuset-one','cpuset-range']:
            b,c,i=copy.deepcopy(self.fixture())
            if control=='wrong-builder': b['Name']='unbounded'
            if control=='wrong-driver': b['Driver']='docker'
            if control=='multi-node': b['Nodes'].append(copy.deepcopy(b['Nodes'][0]))
            if control=='remote-endpoint': b['Nodes'][0]['Endpoint']='tcp://other:2375'
            if control=='wrong-container': i['Name']='/unrelated-limited-container'
            if control=='wrong-image': i['Config']['Image']='moby/buildkit:latest'
            if control=='stopped': i['State']['Running']=False
            if control=='cpu-period': i['HostConfig']['CpuPeriod']=0
            if control=='cpu-quota': i['HostConfig']['CpuQuota']=200000
            if control=='memory': i['HostConfig']['Memory']=16*1024**3
            if control=='swap': i['HostConfig']['MemorySwap']=-1
            if control=='cpuset-one': i['HostConfig']['CpusetCpus']='0'
            if control=='cpuset-range': i['HostConfig']['CpusetCpus']='0-2'
            with self.subTest(control=control), self.assertRaises(ValueError): self.check((b,c,i))

    def test_inherited_host_quota_and_actual_container_affinity(self):
        b,c,i=self.fixture()
        for host,affinity,cgroup in [(({0,1,2,3},2),'0-3','400000 100000\n8589934592\n0\n'), (({0,1},None),'0-3','400000 100000\n8589934592\n0\n'), (({0,1,2,3},None),'0','400000 100000\n8589934592\n0\n'), (({0,1,2,3},None),'0-3','200000 100000\n8589934592\n0\n')]:
            with patch.dict(measured.os.environ, {}, clear=True), patch.object(measured,'host_cpu_envelope',return_value=host), patch.object(measured.subprocess,'check_output',side_effect=[json.dumps(b),json.dumps([c]),json.dumps([i]),'Cpus_allowed_list: '+affinity+'\n',cgroup]), self.assertRaises(ValueError):
                measured.inspect_builder_limits('owned',4,8*1024**3)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'cpu.max').write_text('max 100000')
            (root/'parent/child').mkdir(parents=True)
            (root/'parent/cpu.max').write_text('200000 100000')
            (root/'parent/child/cpu.max').write_text('max 100000')
            member=root/'membership'; member.write_text('0::/parent/child\n')
            with patch.object(measured.os,'sched_getaffinity',return_value={0,1,2,3},create=True):
                self.assertEqual(measured.host_cpu_envelope(root,member),({0,1,2,3},2.0))
