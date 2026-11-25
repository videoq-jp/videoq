import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('paired',Path(__file__).with_name('summarize-paired-builds.py'))
paired=importlib.util.module_from_spec(spec);spec.loader.exec_module(paired)


class PairedControls(unittest.TestCase):
    def test_mismatched_ancestry_missing_checks_or_reused_builder_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            controls=dict(buildkitImage='pinned',buildkitVersion='fixed',cpus=4,memoryBytes=8589934592,cpuPeriod=100000,cpuQuota=400000,memorySwapBytes=8589934592,cpusetCpus='',hostAllowedCpus=[0,1,2,3],containerAllowedCpus=[0,1,2,3],hostInheritedQuotaCpus=None,actualCgroupLimits=['400000 100000','8589934592','0'],effectiveCpus=4,builderHostCgroupEnvelope={'parentLimits':[],'cpuQuotaCpus':4,'memoryMaxBytes':8589934592})
            rows={}
            for variant,seconds in [('baseline',1800),('candidate',1000)]:
                limits={**copy.deepcopy(controls),'containerId':variant}
                row=dict(source='frozen',platform='linux/amd64',parallelism=1,runnerImage='same',cpuModelNames=['same'],failedBuilds=0,runs=[{'seconds':seconds},{'seconds':1}],buildkitLimits=limits,buildkitLimitsAfter=copy.deepcopy(limits),dockerfileVariant=variant,seconds=seconds+1,before={'memoryTotal':'raw'})
                rows[variant]=row
                (root/variant/'build').mkdir(parents=True);(root/variant/'checks').mkdir()
                (root/variant/'build/result.json').write_text(json.dumps(row))
                (root/variant/'checks/identity-verification.json').write_text(json.dumps({'source':'frozen','dockerfileVariant':variant,'images':[dict(smokeMatches=True,scanMatches=True,unchangedAfterChecks=True) for _ in range(3)]}))
            for variant in ['baseline','candidate']:
                for component in ['api','worker','web']:
                    (root/variant/'checks'/f'{component}-security.json.syft.json').write_text(json.dumps({'artifacts':[{'type':'apk','name':'openssl','version':'pinned'}]}))
            self.assertGreater(paired.summarize(root)['cold']['reductionPercent'],0)
            original=copy.deepcopy(rows['candidate'])
            for mutation in ['ancestor','container','source','incomplete','variant','identityVariant','packages']:
                row=copy.deepcopy(original)
                if mutation=='ancestor':
                    row['buildkitLimits']['builderHostCgroupEnvelope']['parentLimits']=[{'cpuMax':'200000 100000'}]
                    row['buildkitLimitsAfter']=copy.deepcopy(row['buildkitLimits'])
                if mutation=='container':row['buildkitLimits']['containerId']='baseline';row['buildkitLimitsAfter']=copy.deepcopy(row['buildkitLimits'])
                if mutation=='source':row['source']='different'
                if mutation=='incomplete':row['runs']=row['runs'][:1]
                if mutation=='variant':row['dockerfileVariant']='baseline'
                if mutation=='identityVariant':
                    identity=root/'candidate/checks/identity-verification.json'
                    data=json.loads(identity.read_text());data['dockerfileVariant']='baseline';identity.write_text(json.dumps(data))
                if mutation=='packages':(root/'candidate/checks/api-security.json.syft.json').write_text(json.dumps({'artifacts':[{'type':'apk','name':'openssl','version':'drift'}]}))
                (root/'candidate/build/result.json').write_text(json.dumps(row))
                with self.assertRaises(ValueError):paired.summarize(root)
                if mutation=='identityVariant':
                    data['dockerfileVariant']='candidate';identity.write_text(json.dumps(data))
