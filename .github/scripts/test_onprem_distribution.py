import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('distribution',Path(__file__).with_name('onprem_distribution.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
D=lambda n:'sha256:'+f'{n:064x}'

class RetentionTests(unittest.TestCase):
    def test_public_deployment_pins_protect_both_site_generations_from_a_real_git_ref(self):
        images = {name: {'repository': 'ghcr.io/videoq-jp/videoq-' + name, 'digest': D(i)}
                  for i, name in enumerate(('api', 'web', 'worker', 'transcription-gateway'), 1)}
        pin = {'schemaVersion': 1, 'generations': [
            {'sourceSha': 'a'*40, 'runId': '123', 'runAttempt': 1, 'images': images},
            {'sourceSha': 'b'*40, 'runId': '122', 'runAttempt': 1, 'images': {
                name: {**image, 'digest': D(i+10)} for i, (name, image) in enumerate(images.items(), 1)}}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.github/deployment-pins/test-site.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(pin))
            subprocess.run(['git', 'init', '-q', directory], check=True)
            subprocess.run(['git', '-C', directory, 'add', '.'], check=True)
            subprocess.run(['git', '-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                            'commit', '-qm', 'active site pins'], check=True)
            real_run = subprocess.run
            with patch.object(m.subprocess, 'run', side_effect=lambda *a, **k: real_run(*a, cwd=directory, **k)):
                roots = m.source_roots(['HEAD'])
        self.assertEqual(roots['videoq-api'], {D(1), D(11)})
        self.assertEqual(roots['videoq-vllm'], set())
        changed = copy.deepcopy(pin)
        changed['generations'][0]['images']['api']['repository'] = 'ghcr.io/attacker/videoq-api'
        with self.assertRaises(ValueError):
            m.deployment_roots(changed)

    def fixture(self):
        now=datetime.now(timezone.utc)
        def version(n,tags=(),young=False):
            return {'id':n,'name':D(n),'created_at':(now-timedelta(days=1 if young else 30)).isoformat(),
                    'metadata':{'container':{'tags':list(tags)}}}
        data={'repository':m.REPO,'capturedAt':now.isoformat(),'releases':[],
              'packages':{p:[] for p in m.PACKAGES},
              'presentPackages':sorted(set(m.PACKAGES)-m.RETIRED_PACKAGES)}
        data['packages']['videoq-api']=[version(1),version(2),version(3),version(4,['sha256-'+D(1)[7:]]),
            version(5),version(6,young=True),version(7),version(8),version(9)]
        graph={D(1):{'manifests':[{'digest':D(2)}]},D(2):{},D(3):{'subject':{'digest':D(1)}},
               D(4):{'manifests':[{'digest':D(5)}]},D(5):{},D(6):{'manifests':[{'digest':D(7)}]},
               D(7):{},D(8):{},D(9):{'subject':{'digest':D(8)}}}
        roots={p:set() for p in m.PACKAGES};roots['videoq-api'].add(D(1))
        def fetch(p,d):return graph[d]
        return data,roots,fetch,now

    def test_protects_index_children_signatures_untagged_referrers_and_recent_build_graphs(self):
        data,roots,fetch,now=self.fixture()
        result=m.plan(data,roots,[],[],fetch,now)
        self.assertEqual({v['id'] for v in result['deleteVersions']},{8,9})
        self.assertEqual(set(result['protectedDigests']['videoq-api']),{D(n) for n in range(1,8)})
        self.assertEqual(result['protectedDigests']['videoq-web'],[])

    def test_missing_or_changed_registry_graph_fails_before_a_plan_exists(self):
        data,roots,fetch,now=self.fixture()
        def broken(p,d):
            if d==D(2):raise ValueError('missing platform manifest')
            return fetch(p,d)
        with self.assertRaises(ValueError):m.plan(data,roots,[],[],broken,now)
        data['packages']['videoq-api'][0]['name']='latest'
        with self.assertRaises(ValueError):m.plan(data,roots,[],[],fetch,now)

    def test_protected_source_reference_retains_an_old_image_and_its_referrer(self):
        data,roots,fetch,now=self.fixture();roots['videoq-api'].add(D(8))
        self.assertEqual(m.plan(data,roots,[],[],fetch,now)['deleteVersions'],[])

    def test_daily_cleanup_can_expire_unadopted_builds_without_expiring_release_graphs(self):
        data,roots,fetch,now=self.fixture()
        result=m.plan(data,roots,[],[],fetch,now+timedelta(days=8))
        self.assertEqual({v['id'] for v in result['deleteVersions']},{6,7,8,9})
        self.assertEqual(set(result['protectedDigests']['videoq-api']),{D(n) for n in range(1,6)})

    def test_latest_two_generations_are_retained_and_other_release_types_are_preserved(self):
        releases=[]
        for n in range(1,5):
            releases.append({'id':n,'tag_name':f'onprem-{"a"*40}-{n}-1','published_at':f'2026-11-0{n}T00:00:00Z',
                             'draft':False,'prerelease':False,'verifiedMainRun':True,'assets':[{'name':'release.json','browser_download_url':str(n)}]})
        releases.append({'id':5,'tag_name':'manual-migration','draft':True,'prerelease':False,'assets':[]})
        roots,kept,removed=m.release_roots(releases,2,lambda u:{'repository':m.REPO,'images':{
            'api':{'repository':'ghcr.io/videoq-jp/videoq-api','digest':D(int(u))}}})
        self.assertEqual({r['id'] for r in kept},{3,4,5});self.assertEqual({r['id'] for r in removed},{1,2})
        self.assertEqual(roots['videoq-api'],{D(3),D(4)})
        with self.assertRaises(ValueError):m.release_roots(releases[:1],2,lambda u:{})
        releases[3]['assets']=[]
        with self.assertRaises(ValueError):m.release_roots(releases,2,lambda u:{})

    def test_apply_revalidates_the_complete_batch_before_any_deletion(self):
        data,roots,fetch,now=self.fixture();plan=m.plan(data,roots,[],[],fetch,now)
        for key,value in [('deleteVersions',[]),('protectedDigests',{}),('deleteReleases',[{'id':1,'tag':'wrong'}])]:
            changed=copy.deepcopy(plan);changed[key]=value
            with patch.object(m,'gh') as gh,self.assertRaises(ValueError):m.apply(changed,data,plan)
            gh.assert_not_called()
        plan['generatedAt']=(now-timedelta(days=2)).isoformat()
        with patch.object(m,'gh') as gh,self.assertRaises(ValueError):m.apply(plan,data,plan)
        gh.assert_not_called()

    def test_apply_deletes_only_exact_reviewed_version_ids(self):
        data,roots,fetch,now=self.fixture();plan=m.plan(data,roots,[],[],fetch,now)
        with patch.object(m,'gh') as gh:result=m.apply(plan,data,plan)
        self.assertEqual(result,{'deletedReleases':0,'deletedVersions':2,'deletedPackages':0})
        self.assertEqual([c.args[0] for c in gh.call_args_list],[
            'orgs/videoq-jp/packages/container/videoq-api/versions/8',
            'orgs/videoq-jp/packages/container/videoq-api/versions/9'])
        self.assertTrue(all(c.kwargs['method']=='DELETE' for c in gh.call_args_list))

    def test_retired_engine_is_kept_while_any_release_or_source_root_remains(self):
        data,roots,fetch,now=self.fixture()
        data['presentPackages'].append('videoq-vllm')
        data['packages']['videoq-vllm']=[copy.deepcopy(data['packages']['videoq-api'][5])]
        roots['videoq-vllm'].add(D(6))
        result=m.plan(data,roots,[],[],fetch,now)
        self.assertEqual(result['deletePackages'],[])
        self.assertIn(D(7),result['protectedDigests']['videoq-vllm'])

    def test_unreferenced_retired_engine_removes_the_whole_package_including_last_tag(self):
        data,roots,fetch,now=self.fixture()
        data['presentPackages'].append('videoq-vllm')
        data['packages']['videoq-vllm']=[copy.deepcopy(data['packages']['videoq-api'][5])]
        result=m.plan(data,roots,[],[],fetch,now)
        self.assertEqual(result['deletePackages'],[{'package':'videoq-vllm',
            'versionsSha256':m.checksum(data['packages']['videoq-vllm'])}])
        self.assertFalse(any(v['package']=='videoq-vllm' for v in result['deleteVersions']))
        with patch.object(m,'gh') as gh:
            applied=m.apply(result,data,result)
        self.assertEqual(applied['deletedPackages'],1)
        self.assertEqual(gh.call_args_list[-1].args[0],'orgs/videoq-jp/packages/container/videoq-vllm')
        changed=copy.deepcopy(data)
        changed['packages']['videoq-vllm'].append(copy.deepcopy(data['packages']['videoq-api'][0]))
        fresh=m.plan(changed,roots,[],[],fetch,now)
        with patch.object(m,'gh') as gh,self.assertRaises(ValueError):
            m.apply(result,changed,fresh)
        gh.assert_not_called()

    def test_active_or_referenced_package_cannot_be_retired_even_by_a_forged_plan(self):
        data,roots,fetch,now=self.fixture()
        result=m.plan(data,roots,[],[],fetch,now)
        result['deletePackages']=[{'package':'videoq-api','versionsSha256':m.checksum(data['packages']['videoq-api'])}]
        with patch.object(m,'gh') as gh,self.assertRaises(ValueError):
            m.apply(result,data,result)
        gh.assert_not_called()
        data['presentPackages'].append('videoq-vllm')
        data['packages']['videoq-vllm']=[copy.deepcopy(data['packages']['videoq-api'][5])]
        roots['videoq-vllm'].add(D(6))
        result=m.plan(data,roots,[],[],fetch,now)
        result['deletePackages']=[{'package':'videoq-vllm','versionsSha256':m.checksum(data['packages']['videoq-vllm'])}]
        with patch.object(m,'gh') as gh,self.assertRaises(ValueError):
            m.apply(result,data,result)
        gh.assert_not_called()

    def test_absent_retired_package_is_allowed_but_a_missing_reference_fails_closed(self):
        data,roots,fetch,now=self.fixture()
        self.assertEqual(m.plan(data,roots,[],[],fetch,now)['deletePackages'],[])
        roots['videoq-vllm'].add(D(8))
        with self.assertRaisesRegex(ValueError,'missing'):
            m.plan(data,roots,[],[],fetch,now)

    def test_snapshot_needs_only_repository_scoped_package_metadata(self):
        def metadata(endpoint,**kwargs):
            if endpoint.endswith('/videoq-vllm'):
                self.assertTrue(kwargs['allow_missing'])
                return None
            self.assertFalse(kwargs['allow_missing'])
            return {'repository':{'full_name':m.REPO},'visibility':'public'}
        with patch.object(m,'listing',return_value=[]) as listing,patch.object(m,'gh',side_effect=metadata):
            data=m.snapshot()
        self.assertFalse(any('/packages?' in call.args[0] for call in listing.call_args_list))
        self.assertNotIn('videoq-vllm',data['presentPackages'])
        self.assertEqual(data['packages']['videoq-vllm'],[])
        with patch.object(m,'listing',side_effect=RuntimeError('API unavailable')),self.assertRaises(RuntimeError):
            m.snapshot()

    def test_only_an_explicit_retired_metadata_404_is_optional(self):
        from types import SimpleNamespace
        endpoint='orgs/videoq-jp/packages/container/videoq-vllm'
        for status in (401,403,500):
            response=SimpleNamespace(returncode=1,stdout=f'HTTP/2.0 {status} Error\nContent-Type: application/json\n\n{{}}')
            with patch.object(m.subprocess,'run',return_value=response),self.assertRaises(RuntimeError):
                m.gh(endpoint,allow_missing=True)
        response=SimpleNamespace(returncode=1,stdout='HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{}')
        with patch.object(m.subprocess,'run',return_value=response):
            self.assertIsNone(m.gh(endpoint,allow_missing=True))
        with patch.object(m.subprocess,'run') as run,self.assertRaises(ValueError):
            m.gh(endpoint.replace('videoq-vllm','videoq-api'),allow_missing=True)
        run.assert_not_called()
        response=SimpleNamespace(returncode=0,stdout='HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"name":"videoq-vllm"}')
        with patch.object(m.subprocess,'run',return_value=response):
            self.assertEqual(m.gh(endpoint,allow_missing=True)['name'],'videoq-vllm')
        for body in ('', 'null', '[]'):
            response=SimpleNamespace(returncode=0,stdout='HTTP/2.0 200 OK\nContent-Type: application/json\n\n'+body)
            with patch.object(m.subprocess,'run',return_value=response),self.assertRaises(RuntimeError):
                m.gh(endpoint,allow_missing=True)
        response=SimpleNamespace(returncode=1,stdout='not an HTTP response')
        with patch.object(m.subprocess,'run',return_value=response),self.assertRaises(RuntimeError):
            m.gh(endpoint,allow_missing=True)

    def test_deleted_retired_package_does_not_require_an_anonymous_registry_token(self):
        present=sorted(set(m.PACKAGES)-m.RETIRED_PACKAGES)
        with patch.object(m,'fetch_json',return_value={'token':'test'}) as fetch:
            registry=m.Registry(packages=present)
        self.assertEqual(set(registry.tokens),set(present))
        self.assertTrue(all('videoq-vllm' not in call.args[0] for call in fetch.call_args_list))

if __name__=='__main__':unittest.main()
