import copy
import json
from pathlib import Path
import subprocess
import tempfile
import os
import unittest
from local_ai import embedding_runtime_identity, validate_embedding_overrides, LocalAI

class RenderedIdentity(unittest.TestCase):
    def test_actual_native_charts_bind_weights_alias_profile_and_deploy_override(self):
        root=Path(__file__).resolve().parents[2]
        helm=os.environ.get('HELM_BIN','/opt/homebrew/bin/helm')
        if not Path(helm).exists() and not __import__('shutil').which(helm):self.skipTest('Helm not installed')
        # Parse actual Helm JSON using the existing Node YAML dependency, no cluster.
        for overlay,profile in [('llamacpp-cpu.yaml','openai'),('vllm-nvidia.yaml','openai'),('rtx4090-gpt-oss-embeddinggemma.yaml','embeddinggemma2')]:
            raw=subprocess.check_output([helm,'template','inference',str(root/'charts/videoq-inference'),'-f',str(root/'charts/videoq-inference/examples'/overlay)],text=True)
            script="import {parseAllDocuments} from 'yaml';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(parseAllDocuments(s).filter(d=>d.contents).map(d=>d.toJSON())))"
            objects=json.loads(subprocess.check_output(['node','--input-type=module','-e',script],input=raw,text=True,cwd=root))
            identity=embedding_runtime_identity(objects,profile)
            self.assertNotEqual(identity['embeddingRevision'],'provider-managed')
            self.assertTrue(identity['embeddingModel'])
            for key in identity:
                with self.assertRaises(ValueError):validate_embedding_overrides({'ai':{key:'contradictory'}},identity)
            with self.assertRaises(ValueError):embedding_runtime_identity(objects,'incorrect-profile')
            embedding=next(row for row in objects if row['kind']=='Deployment' and row['metadata']['name'].endswith('-embedding'))
            for mutation in ['missing','ambiguous','revision','checksum','alias','dimensions','duplicateMetadata']:
                changed=copy.deepcopy(objects)
                target=next(row for row in changed if row['kind']=='Deployment' and row['metadata']['name'].endswith('-embedding'))
                pod=target['spec']['template']['spec'];env=next(c for c in pod['initContainers'] if c['name']=='provision-model')['env']
                if mutation=='missing':pod['initContainers']=[]
                if mutation=='ambiguous':changed.append(copy.deepcopy(target))
                if mutation=='revision':next(e for e in env if e['name']=='MODEL_REVISION')['value']='main'
                if mutation=='checksum':
                    if overlay!='llamacpp-cpu.yaml':continue
                    next(e for e in env if e['name']=='MODEL_SHA256')['value']=''
                if mutation=='duplicateMetadata':env.append(copy.deepcopy(env[0]))
                if mutation=='alias':pod['containers'][0]['args']+=['--alias','other']
                if mutation=='dimensions':
                    if overlay!='vllm-nvidia.yaml':continue
                    args=pod['containers'][0]['args'];args[args.index('--hf-overrides')+1]='{"matryoshka_dimensions":[768]}'
                with self.assertRaises(ValueError,msg=mutation):embedding_runtime_identity(changed,profile)
            instance=LocalAI();instance.ai='local-cpu';instance.ai_app_overlay=Path('application.yaml');instance.ai_identity_overlay=Path('identity.json')
            self.assertEqual(instance.ai_application_values(),['-f','application.yaml','-f','identity.json'])

    def test_actual_prepare_and_deploy_values_share_derived_identity_before_mutation(self):
        root=Path(__file__).resolve().parents[2]
        helm=os.environ.get('HELM_BIN','/opt/homebrew/bin/helm')
        if not Path(helm).exists() and not __import__('shutil').which(helm):self.skipTest('Helm not installed')
        parse="import {parseAllDocuments} from 'yaml';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({kind:'List',items:parseAllDocuments(s).filter(d=>d.contents).map(d=>d.toJSON())}))"
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            for chart in ['videoq','videoq-inference']:
                subprocess.run([helm,'package',str(root/'charts'/chart),'--destination',str(directory),'--version','0.1.0'],check=True,capture_output=True)
            instance=LocalAI();instance.ai='local-cpu';instance.inference_chart=directory/'videoq-inference-0.1.0.tgz';instance.chart=directory/'videoq-0.1.0.tgz'
            instance.images=directory/'images.json';instance.inference_images=directory/'inference.json'
            for path in [instance.images,instance.inference_images]:path.write_text('{}')
            instance.state={};instance.args=type('Args',(),{'command':'install'})()
            instance.desired_application_values=lambda:{'publicUrl':'https://v.example','storage':{'endpoint':'https://s.example'},'queue':{'url':'http://q/jobs','searchUrl':'http://q/search','accountUrl':'http://q/account'}}
            instance.check_ai_capacity=lambda:None
            def run(*command,**kwargs):
                self.assertEqual(command[:2],('helm','template'))
                return subprocess.check_output([helm,*command[1:]],text=True)
            def kube(*command,**kwargs):
                if command[:2]==('get','nodes'):return json.dumps({'items':[{'metadata':{'labels':{'kubernetes.io/arch':'amd64'}}}]})
                self.assertEqual(command[:3],('create','--dry-run=client','--validate=false'))
                return subprocess.check_output(['node','--input-type=module','-e',parse],input=kwargs.get('data') or Path(command[command.index('-f')+1]).read_text(),text=True,cwd=root)
            instance.run=run;instance.kube=kube
            instance.prepare_inference()
            identity=json.loads(instance.ai_identity_overlay.read_text())['ai']
            config=next(o['data'] for o in instance.ai_app_plan if o['kind']=='ConfigMap')
            self.assertEqual(config['EMBEDDING_REVISION'],identity['embeddingRevision'])
            self.assertEqual(instance.ai_application_values()[-2:],['-f',str(instance.ai_identity_overlay)])
            instance.desired_application_values=lambda:{'ai':{'embeddingRevision':'contradictory'}}
            with self.assertRaises(ValueError):instance.prepare_inference()
