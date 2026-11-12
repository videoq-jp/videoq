"""Release selection, transport boundaries and failed-update safety."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import repository
import update as u


class RepositoryTests(unittest.TestCase):
    def test_internal_forgejo_gitlab_and_github(self):
        for url in ['ssh://git@forgejo.lab:2222/lab/config.git', 'https://git.lab:3443/lab/config.git',
                    'git@forgejo.lab:lab/config.git', 'https://gitlab.lab/group/subgroup/config.git',
                    'https://github.com/videoq-jp/videoq-lab-config.git']:
            self.assertEqual(repository.validate_repository(url), url)

    def test_credentials_options_and_unsafe_transports_are_rejected(self):
        for url in ['http://git.lab/lab/config.git', 'https://secret@git.lab/lab/config.git',
                    'ssh://root@git.lab/lab/config.git', 'ssh://git:secret@git.lab/lab/config.git',
                    'file:///tmp/a.git', 'ext::sh -c id', 'https://git.lab/lab/../a.git',
                    'https://git.lab/lab/a.git?token=secret', 'git@host:../a.git',
                    'https://git.lab/lab/a.git\n', 'https://git.lab/lab/a.git#x']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                repository.validate_repository(url)


class SelectionTests(unittest.TestCase):
    current = {'sourceSha': 'a'*40, 'runId': '20', 'runAttempt': 1}

    def test_only_newer_successful_formal_release_is_selected(self):
        candidate = {'source_sha': 'b'*40, 'run_id': '21', 'run_attempt': 1}
        with patch.object(u.promote.public_release, 'releases', return_value=[candidate]), patch.object(u.promote.public_release, 'check_run') as check:
            self.assertEqual(u.select_release(self.current), candidate)
            check.assert_called_once_with(candidate)

    def test_does_not_downgrade_when_latest_catalog_is_older(self):
        with patch.object(u.promote.public_release, 'releases', return_value=[{'run_id': '19', 'run_attempt': 9}]), patch.object(u.promote.public_release, 'check_run') as check:
            self.assertIsNone(u.select_release(self.current))
            check.assert_not_called()

    def test_verification_failure_is_not_silently_skipped(self):
        with patch.object(u.promote.public_release, 'releases', return_value=[{'run_id': '21', 'run_attempt': 1}]), patch.object(u.promote.public_release, 'check_run', side_effect=ValueError('tampered')):
            with self.assertRaises(ValueError):
                u.select_release(self.current)

    def test_sync_gate_rejects_automatic_reconciliation_and_busy_operations(self):
        for app in [{'spec': {'syncPolicy': {'automated': {}}}}, {'spec': {}, 'operation': {'sync': {}}}]:
            with self.assertRaises(ValueError): u.assert_manual(app)
        u.assert_manual({'spec': {}})


class ImageCacheTests(unittest.TestCase):
    def test_containerd_references_expand_familiar_names_without_changing_digests(self):
        digest = '@sha256:' + 'a' * 64
        cases = {
            'caddy:2-alpine': 'docker.io/library/caddy',
            'postgres:18.3': 'docker.io/library/postgres',
            'vllm/vllm-openai': 'docker.io/vllm/vllm-openai',
            'docker.io/caddy:2-alpine': 'docker.io/library/caddy',
            'index.docker.io/library/caddy:2': 'docker.io/library/caddy',
            'ghcr.io/videoq-jp/videoq-api': 'ghcr.io/videoq-jp/videoq-api',
            'localhost:5000/image:tag': 'localhost:5000/image',
            'registry.example.com:5000/team/image:tag': 'registry.example.com:5000/team/image',
        }
        for original, expected in cases.items():
            with self.subTest(original=original):
                self.assertEqual(u.ctr_reference(original + digest), expected + digest)

    def test_unpinned_cache_inputs_fail_before_calling_containerd(self):
        objects = [{'kind': 'Deployment', 'spec': {'template': {'spec': {
            'containers': [{'image': 'caddy:latest'}]}}}}]
        with patch.object(u, 'run') as command:
            with self.assertRaises(ValueError):
                u.Host.cache_images(object.__new__(u.Host), Path('/unused'), objects)
            command.assert_not_called()

    def test_cache_normalizes_init_and_cron_images_without_editing_signed_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            digest = '@sha256:' + 'a' * 64
            objects = [{'kind': 'Deployment', 'spec': {'template': {'spec': {'containers': [
                {'image': 'ghcr.io/videoq-jp/videoq-' + name + digest}]}}}}
                for name in ['api', 'web', 'worker', 'transcription-gateway']]
            objects[0]['spec']['template']['spec']['initContainers'] = [{'image': 'caddy:2-alpine' + digest}]
            objects.append({'kind': 'CronJob', 'spec': {'jobTemplate': {'spec': {'template': {'spec': {
                'containers': [{'image': 'vllm/vllm-openai' + digest}]}}}}}})
            original = json.dumps(objects)
            commands = []
            def command(*args, **kwargs):
                commands.append(args)
                if args[:4] == ('k3s', 'ctr', 'images', 'export'):
                    Path(args[6]).write_bytes(b'exported OCI archive')
            with patch.object(u, 'run', side_effect=command), patch.object(u, 'IMAGE_IMPORT_DIRECTORY', root/'imports'):
                u.Host.cache_images(object.__new__(u.Host), root, objects)
            pulls = [args[-1] for args in commands if args[3] == 'pull']
            self.assertEqual(len(pulls), 6)
            self.assertIn('docker.io/library/caddy' + digest, pulls)
            self.assertIn('docker.io/vllm/vllm-openai' + digest, pulls)
            self.assertEqual(json.dumps(objects), original)

    def test_four_own_images_are_archived_for_native_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);release=root/'release';release.mkdir()
            imports=root/'imports'
            objects=[{'kind':'Deployment','spec':{'template':{'spec':{'containers':[{'image':'ghcr.io/videoq-jp/videoq-'+name+'@sha256:'+'a'*64}]}}}} for name in ['api','web','worker','transcription-gateway']]
            commands=[]
            def command(*args,**kwargs):
                commands.append(args)
                if args[:4]==('k3s','ctr','images','export'):
                    Path(args[6]).write_bytes(b'exported OCI archive')
            host=object.__new__(u.Host)
            with patch.object(u,'run',side_effect=command),patch.object(u,'IMAGE_IMPORT_DIRECTORY',imports):
                host.cache_images(release,objects)
            self.assertEqual(len([x for x in commands if x[3]=='pull']),4)
            self.assertEqual((imports/'videoq-release.tar').read_bytes(),(release/'application-images.tar').read_bytes())
            self.assertEqual((imports/'videoq-release.tar').stat().st_mode & 0o777,0o600)
            self.assertFalse(list(imports.glob('*.partial')))

    def test_incomplete_export_is_never_imported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);imports=root/'imports'
            objects=[{'kind':'Deployment','spec':{'template':{'spec':{'containers':[{'image':'ghcr.io/videoq-jp/videoq-'+name+'@sha256:'+'a'*64}]}}}} for name in ['api','web','worker','transcription-gateway']]
            def command(*args,**kwargs):
                if args[:4]==('k3s','ctr','images','export'):raise ValueError('disk full')
            with patch.object(u,'run',side_effect=command),patch.object(u,'IMAGE_IMPORT_DIRECTORY',imports):
                with self.assertRaises(ValueError):u.Host.cache_images(object.__new__(u.Host),root,objects)
            self.assertFalse(imports.exists())


class FakeHost(u.Host):
    def __init__(self, root, failure=None):
        self.directory = root
        self.state_path = root/'state.json'
        self.repo = root/'repo';self.repo.mkdir()
        self.site = 'clusters/lab'
        self.state = {'sourceSha':'a'*40, 'runId':'20', 'runAttempt':1,'revision':'old', 'acceptedImages':'old.tar'}
        self.config = {'branch':'main','public_url':'https://192.168.1.50'}
        self.calls = []
        self.failure = failure
        self.target = {'sourceSha':'b'*40,'runId':'21','runAttempt':1}
        for prefix in [self.repo, root/'generated']:
            for name in ['videoq/resources.json','release-lock.json']:
                p=prefix/self.site/name;p.parent.mkdir(parents=True, exist_ok=True);p.write_text('{}')

    def check_cluster_identity(self):self.calls.append('identity')
    def healthy(self, revision, smoke=False):
        self.calls.append('health:'+revision)
        if revision=='new' and self.failure=='health':raise ValueError('smoke failed')
    def lock(self):return {k:self.state[k] for k in ['sourceSha','runId','runAttempt']}
    def prepare(self, selected):
        self.calls.append('prepare')
        if self.failure=='prepare':raise ValueError('signature failed')
        return self.directory, self.directory/'generated'/self.site, self.target
    def runtime_snapshot(self):return {'deployments':{},'cronjobs':{}}
    def quiesce(self, runtime, backends=True):self.calls.append('quiesce:'+str(backends))
    def cold_backup(self, pending):
        self.calls.append('backup')
        if self.failure=='backup':raise ValueError('disk full')
        pending['phase']='backed_up'
    def scale(self, names, replicas, runtime):self.calls.append('scale:'+','.join(names))
    def restore_cronjobs(self, runtime):self.calls.append('cron')
    def kube(self, *args, **kwargs):self.calls.append('sync')
    def app(self):return {'metadata':{'resourceVersion':'1'},'spec':{},'status':{'operationState':{'phase':'Succeeded','syncResult':{'revision':'new'}},'health':{'status':'Healthy'},'sync':{'status':'Synced','revision':'new'}}}

    def command(self, *args, **kwargs):
        if args[:3]==('git','rev-parse','FETCH_HEAD'):return 'old'
        if args[:3]==('git','rev-parse','HEAD'):return 'new'
        if args[:2]==('git','push'):
            self.calls.append('push')
            if self.failure=='push':raise ValueError('concurrent Git update')


class TransactionTests(unittest.TestCase):
    candidate={'source_sha':'b'*40,'run_id':'21','run_attempt':1,'tag':'onprem-test'}

    def exercise(self, failure=None):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        host=FakeHost(Path(temporary.name),failure)
        with patch.object(u,'select_release',return_value=self.candidate),patch.object(u,'run',side_effect=host.command):
            if failure:
                with self.assertRaises(ValueError):host.update_once('old')
            else:host.update_once('old')
        return host

    def test_preparation_failure_never_touches_live_workloads(self):
        host=self.exercise('prepare')
        self.assertFalse(any(x.startswith(('quiesce','scale','sync')) for x in host.calls))
        self.assertNotIn('pending_update',host.state)

    def test_backup_failure_restores_old_workloads_without_git_push(self):
        host=self.exercise('backup')
        self.assertIn('scale:'+','.join(u.WRITERS),host.calls)
        self.assertNotIn('push',host.calls)
        self.assertEqual(host.state['runId'],'20')

    def test_push_conflict_never_syncs_and_preserves_journal(self):
        host=self.exercise('push')
        self.assertNotIn('sync',host.calls)
        self.assertEqual(host.state['pending_update']['phase'],'publishing')
        self.assertIn('quiesce:False',host.calls)

    def test_failed_post_migration_health_does_not_roll_old_images_back(self):
        host=self.exercise('health')
        self.assertIn('sync',host.calls)
        self.assertIn('quiesce:False',host.calls)
        self.assertEqual(host.state['runId'],'20')
        self.assertIn('pending_update',host.state)

    def test_success_requires_backup_before_push_sync_and_health(self):
        host=self.exercise()
        positions=[host.calls.index(n) for n in ['prepare','quiesce:True','backup','push','sync','health:new']]
        self.assertEqual(positions,sorted(positions))
        self.assertNotIn('pending_update',host.state)
        self.assertEqual(host.state['runId'],'21')
        self.assertEqual(host.state['previousImages'],'old.tar')
        self.assertEqual(host.state['source_sha'],host.state['sourceSha'])
        self.assertEqual(host.state['run_id'],host.state['runId'])
        self.assertEqual(host.state['run_attempt'],host.state['runAttempt'])

    def test_termination_waits_for_controller_before_scaling(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        host=FakeHost(Path(temporary.name))
        host.state['pending_update']={'id':'test'}
        busy={'metadata':{'resourceVersion':'1'},'operation':{'sync':{},'info':[{'name':'videoq-update-id','value':'test'}]}}
        with patch.object(host,'app',side_effect=[busy,busy,{}]), patch.object(host,'kube') as kube, patch.object(u.time,'sleep'):
            host.stop_operation()
        args=kube.call_args.args
        self.assertNotIn('--subresource=status',args)
        self.assertEqual(json.loads(args[-1])[-1],{'op':'replace','path':'/status/operationState/phase','value':'Terminating'})

    def test_foreign_argo_operation_is_not_terminated(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        host=FakeHost(Path(temporary.name));host.state['pending_update']={'id':'ours'}
        with patch.object(host,'app',return_value={'operation':{'sync':{}}}),patch.object(host,'kube') as kube:
            with self.assertRaises(ValueError):host.stop_operation()
            kube.assert_not_called()

    def test_interrupted_mutation_blocks_timer(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        host=FakeHost(Path(temporary.name));host.state['pending_update']={'phase':'syncing'}
        with self.assertRaises(ValueError):host.update_once('old')
        self.assertEqual(host.calls,[])


if __name__=='__main__':unittest.main()
