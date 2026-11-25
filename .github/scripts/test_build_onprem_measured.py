import copy
import importlib.util
import json
from pathlib import Path
import unittest
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
        with patch.dict(measured.os.environ, {}, clear=True), patch.object(measured.subprocess, 'check_output', side_effect=[json.dumps(b),json.dumps([c]),json.dumps([i])]) as execute:
            result = measured.inspect_builder_limits('owned', 4, 8 * 1024**3)
            self.assertEqual(execute.call_args_list[-1].args[0], ['docker','container','inspect','buildx_buildkit_owned0'])
            return result

    def test_effective_limits_bound_to_selected_local_single_node(self):
        self.assertEqual(self.check(self.fixture())['node'], 'owned0')
        for control in ['wrong-builder','wrong-driver','multi-node','remote-endpoint','wrong-container','wrong-image','stopped','cpu-period','cpu-quota','memory','swap']:
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
            with self.subTest(control=control), self.assertRaises(ValueError): self.check((b,c,i))
