import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('cpu', Path(__file__).with_name('onprem-cpu-acceptance.py'))
cpu = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cpu)


class AcceptanceSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'release'
        self.bundle.mkdir()
        self.manifest = self.bundle / 'release.json'
        self.manifest.write_text('{}')
        self.argv = patch('sys.argv', ['script', 'a'*40, str(self.bundle), str(self.root/'evidence')])
        self.argv.start()
        self.addCleanup(self.argv.stop)

    def test_invalid_signature_prevents_every_docker_or_cluster_action(self):
        with patch.object(cpu.release, 'verify', side_effect=ValueError('bad signature')), patch.object(cpu.subprocess, 'check_output') as read, patch.object(cpu.subprocess, 'run') as mutate:
            with self.assertRaisesRegex(ValueError, 'bad signature'): cpu.main()
        read.assert_not_called()
        mutate.assert_not_called()

    def test_recognition_quality_and_timestamps_must_both_pass(self):
        case = {'duration':10.44,'reference':'現地企業の住所です。'}
        actual = '1\n00:00:00,000 --> 00:00:10,000\n現地企業の住所です。\n'
        self.assertEqual(cpu.assess_transcript(actual,case)['cer'],0)
        for bad in ['', actual.replace('00:00:10,000','00:00:20,000'), actual.replace('現地企業の住所です。','全く別の内容で回答しています。')]:
            with self.subTest(transcript=bad), self.assertRaises(ValueError): cpu.assess_transcript(bad,case)

    def test_existing_cluster_is_never_replaced_or_deleted(self):
        metadata = {'charts': {'application': {'name': 'app.tgz'}, 'inference': {'name': 'inference.tgz'}}}
        inference = {'whisper': {'image': {'repository':'ghcr.io/test/whisper','digest':'sha256:'+'b'*64}}}
        with patch.object(cpu.release, 'verify', return_value=({}, inference)), patch.object(cpu.release, 'validate', return_value=metadata), patch.object(cpu.subprocess, 'check_output', return_value='videoq-onprem-lab\n') as read, patch.object(cpu.subprocess, 'run') as mutate:
            with self.assertRaisesRegex(RuntimeError, 'already exists'): cpu.main()
        self.assertEqual(read.call_args.args[0], ['kind', 'get', 'clusters'])
        mutate.assert_not_called()

    def test_insufficient_memory_aborts_before_model_download_or_cluster_creation(self):
        with patch.object(cpu.subprocess, 'check_output', side_effect=['', str(4 * 1024**3)]) as read, patch.object(cpu.subprocess, 'run') as mutate:
            with self.assertRaisesRegex(RuntimeError, '10 GiB'):
                cpu.rehearse('a' * 40, Path('charts/videoq'), Path('charts/videoq-inference'), self.root / 'capacity', {}, local_builds=True)
        self.assertEqual([call.args[0] for call in read.call_args_list],
                         [['kind', 'get', 'clusters'], ['docker', 'info', '--format', '{{.MemTotal}}']])
        mutate.assert_not_called()

    def test_memory_floor_accepts_capable_hosts_and_rejects_unknown_capacity(self):
        for memory in [cpu.MINIMUM_DOCKER_MEMORY, 16 * 1024**3]:
            self.assertEqual(cpu.require_docker_memory(memory), memory)
        for invalid in [None, True, 0, -1]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                cpu.require_docker_memory(invalid)
        with self.assertRaises(RuntimeError):
            cpu.require_docker_memory(cpu.MINIMUM_DOCKER_MEMORY - 1)

    def test_combined_moodle_floor_does_not_relax_the_default_or_provision_on_small_hosts(self):
        self.assertEqual(cpu.require_docker_memory(10 * 1024**3), 10 * 1024**3)
        self.assertEqual(cpu.require_docker_memory(12 * 1024**3, moodle=True), 12 * 1024**3)
        with patch.object(cpu.subprocess, 'check_output', side_effect=['', str(11 * 1024**3)]) as read, \
                patch.object(cpu.subprocess, 'run') as mutate, patch.object(cpu.importlib.util, 'spec_from_file_location') as load:
            with self.assertRaisesRegex(RuntimeError, '12 GiB'):
                cpu.rehearse('a' * 40, Path('charts/videoq'), Path('charts/videoq-inference'),
                             self.root / 'small-moodle', {}, local_builds=True, moodle_image='videoq-moodle:test')
        self.assertEqual(len(read.call_args_list), 2)
        mutate.assert_not_called()
        load.assert_not_called()

    def test_test_only_moodle_cannot_enter_the_verified_release_runner(self):
        with patch.object(cpu.subprocess, 'check_output') as read, patch.object(cpu.subprocess, 'run') as mutate:
            with self.assertRaisesRegex(ValueError, 'source-build'):
                cpu.rehearse('a' * 40, Path('app.tgz'), Path('inference.tgz'), self.root / 'signed', {},
                             moodle_image='videoq-moodle:test')
        read.assert_not_called()
        mutate.assert_not_called()

    def test_public_egress_firewall_covers_node_and_pod_ipv4_and_ipv6(self):
        info = {'IPAM':{'Config':[{'Subnet':'172.29.0.0/16','Gateway':'172.29.0.1'}]}}
        with patch.object(cpu.subprocess,'run') as mutate, patch.object(cpu.subprocess,'check_output',return_value='installed rules'):
            policy = cpu.isolate_node(info)
        commands = [call.args[0] for call in mutate.call_args_list]
        for binary in ['iptables','ip6tables']:
            rules = [c for c in commands if c[3] == binary]
            for hook in ['OUTPUT','FORWARD']:
                self.assertTrue(any(c[-4:] == ['-C',hook,'-j','VIDEOQ-CPU-EGRESS'] for c in rules))
            self.assertTrue(any(c[-4:] == ['-A','VIDEOQ-CPU-EGRESS','-j','REJECT'] for c in rules))
            for c in rules:
                if c[-1] == 'RETURN': self.assertIn('-d',c)
        gateway = [c for c in commands if c[3] == 'iptables' and '-d' in c and c[c.index('-d')+1] == '172.29.0.1']
        self.assertIn('ESTABLISHED,RELATED',gateway[0])
        self.assertEqual(gateway[1][-1],'REJECT')
        self.assertEqual(policy['blockedHostGateway'],'172.29.0.1')

    def test_unexpected_networks_fail_before_installing_firewall_rules(self):
        for subnet, gateway in [('8.8.8.0/24','8.8.8.1'),('172.29.0.0/16','172.30.0.1'),('10.244.0.0/16','10.244.0.1')]:
            with self.subTest(subnet=subnet), patch.object(cpu.subprocess,'run') as mutate:
                with self.assertRaises(ValueError): cpu.isolate_node({'IPAM':{'Config':[{'Subnet':subnet,'Gateway':gateway}]}})
                mutate.assert_not_called()

    def test_offline_backing_services_use_importable_aliases_without_losing_original_digests(self):
        fixture = json.loads((cpu.ROOT/'.github/onprem-lab/dependencies.json').read_text())
        original = json.dumps(fixture,sort_keys=True)
        offline, images = cpu.lab.prepare_fixtures(fixture,'onprem-ci')
        self.assertEqual(set(images),{'postgres','garage','queue'})
        self.assertEqual(json.dumps(fixture,sort_keys=True),original)
        for item in offline['items']:
            if item['kind'] != 'Deployment': continue
            name = item['metadata']['name']
            container = item['spec']['template']['spec']['containers'][0]
            self.assertEqual(container['image'],images[name]['alias'])
            self.assertEqual(container['imagePullPolicy'],'Never')
            self.assertIn('@sha256:',images[name]['reference'])
            self.assertNotIn('@',container['image'])
        online,_ = cpu.lab.prepare_fixtures(fixture)
        self.assertEqual(online,fixture)

    def test_mutable_backing_images_and_invalid_alias_tags_are_rejected(self):
        fixture = json.loads((cpu.ROOT/'.github/onprem-lab/dependencies.json').read_text())
        with self.assertRaises(ValueError):cpu.lab.prepare_fixtures(fixture,'../../unexpected')
        deployment = next(item for item in fixture['items'] if item['kind']=='Deployment')
        deployment['spec']['template']['spec']['containers'][0]['image']='postgres:latest'
        with self.assertRaises(ValueError):cpu.lab.prepare_fixtures(fixture,'onprem-ci')

    def test_diagnostics_retain_status_without_pod_specs_or_secret_values(self):
        item={'metadata':{'name':'test-pod'},'spec':{'env':[{'value':'must-not-retain'}]},'status':{'phase':'Pending'}}
        success=SimpleNamespace(returncode=0,stdout=json.dumps({'items':[item]}))
        failure=SimpleNamespace(returncode=1,stdout='')
        with patch.object(cpu.subprocess,'run',side_effect=[success,success,success]+[failure]*4),patch('builtins.print'):
            cpu.capture_diagnostics(self.root/'kubeconfig',self.root)
        data=(self.root/'diagnostics.json').read_text()
        self.assertNotIn('must-not-retain',data)
        self.assertEqual(json.loads(data)['pods'][0],{'name':'test-pod','status':{'phase':'Pending'}})

    def test_containerd_store_exports_only_the_native_platform_and_checks_the_cri_cache(self):
        info={'OSType':'linux','Architecture':'aarch64','DriverStatus':[['driver-type','io.containerd.snapshotter.v1']]}
        def save(command,**kwargs):
            if command[:3]==['docker','image','save']:Path(command[command.index('--output')+1]).write_bytes(b'native image fixture')
        with patch.object(cpu.lab.subprocess,'check_output',side_effect=[json.dumps(info),'1.55',json.dumps({'status':{'id':'sha256:'+'b'*64}})]) as read, patch.object(cpu.lab.subprocess,'run',side_effect=save) as mutate:
            result=cpu.lab.load_native_images(['videoq-lab-postgres:test'],{},self.root)
        export=mutate.call_args_list[0].args[0]
        self.assertEqual(export[export.index('--platform')+1],'linux/arm64')
        self.assertIn('image-archive',mutate.call_args_list[1].args[0])
        self.assertIn('inspecti',read.call_args_list[-1].args[0])
        self.assertEqual(result[0]['platform'],'linux/arm64')
        self.assertEqual(list(self.root.glob('native-images-*')),[])

    def test_classic_store_exports_a_checked_native_image_without_containerd_filtering(self):
        info={'OSType':'linux','Architecture':'x86_64','DriverStatus':[]}
        def save(command,**kwargs):
            if command[:3]==['docker','image','save']:Path(command[command.index('--output')+1]).write_bytes(b'native image fixture')
        with patch.object(cpu.lab.subprocess,'check_output',side_effect=[json.dumps(info),'linux/amd64',json.dumps({'status':{'id':'sha256:'+'b'*64}})]), patch.object(cpu.lab.subprocess,'run',side_effect=save) as mutate:
            result=cpu.lab.load_native_images(['videoq-api:test'],{},self.root)
        self.assertNotIn('--platform',mutate.call_args_list[0].args[0])
        self.assertEqual(result[0]['platform'],'linux/amd64')

    def test_foreign_classic_images_and_unsupported_export_apis_fail_before_import(self):
        cases=[({'OSType':'linux','Architecture':'aarch64','DriverStatus':[]},'linux/amd64'),
               ({'OSType':'linux','Architecture':'aarch64','DriverStatus':[['driver-type','io.containerd.snapshotter.v1']]},'1.47')]
        for info,second in cases:
            with self.subTest(info=info),patch.object(cpu.lab.subprocess,'check_output',side_effect=[json.dumps(info),second]),patch.object(cpu.lab.subprocess,'run') as mutate:
                with self.assertRaises(ValueError):cpu.lab.load_native_images(['videoq-api:test'],{},self.root)
                mutate.assert_not_called()

    def test_a_missing_cri_cache_entry_aborts_and_cleans_the_temporary_archive(self):
        info={'OSType':'linux','Architecture':'x86_64','DriverStatus':[]}
        def save(command,**kwargs):
            if command[:3]==['docker','image','save']:Path(command[command.index('--output')+1]).write_bytes(b'native image fixture')
        with patch.object(cpu.lab.subprocess,'check_output',side_effect=[json.dumps(info),'linux/amd64']+[cpu.subprocess.CalledProcessError(1,'crictl')]*30),patch.object(cpu.lab.subprocess,'run',side_effect=save),patch.object(cpu.lab.time,'sleep'):
            with self.assertRaises(cpu.subprocess.CalledProcessError):cpu.lab.load_native_images(['videoq-api:test'],{},self.root)
        self.assertEqual(list(self.root.glob('native-images-*')),[])

    def test_native_import_waits_for_the_cri_cache_without_skipping_verification(self):
        info={'OSType':'linux','Architecture':'x86_64','DriverStatus':[]}
        responses=[json.dumps(info),'linux/amd64',cpu.subprocess.CalledProcessError(1,'crictl'),json.dumps({'status':{'id':'sha256:'+'b'*64}})]
        def save(command,**kwargs):
            if command[:3]==['docker','image','save']:Path(command[command.index('--output')+1]).write_bytes(b'native image fixture')
        with patch.object(cpu.lab.subprocess,'check_output',side_effect=responses),patch.object(cpu.lab.subprocess,'run',side_effect=save),patch.object(cpu.lab.time,'sleep') as sleep:
            result=cpu.lab.load_native_images(['videoq-api:test'],{},self.root)
        self.assertEqual(result[0]['criImageId'],'sha256:'+'b'*64)
        sleep.assert_called_once_with(1)


if __name__ == '__main__':
    unittest.main()
