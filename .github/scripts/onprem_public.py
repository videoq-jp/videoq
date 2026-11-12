"""Verify publicly distributed SLSA bundles without GitHub CLI, API tokens or login."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re

SPEC = importlib.util.spec_from_file_location('release_manifest', Path(__file__).with_name('onprem-release.py'))
manifest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manifest)


def identity_policy(source, run_id, attempt, repository=manifest.REPOSITORY):
    from sigstore.verify import policy
    if repository != manifest.REPOSITORY:
        raise ValueError('Public releases must come from the current VideoQ repository')
    manifest.sha(source)
    if not re.fullmatch(r'[1-9][0-9]*', str(run_id)) or not re.fullmatch(r'[1-9][0-9]*', str(attempt)):
        raise ValueError('Invalid release run/attempt')
    repo = 'https://github.com/' + repository
    workflow = repo + '/.github/workflows/onprem-release.yml@refs/heads/main'
    return policy.AllOf([
        policy.Identity(identity=workflow, issuer='https://token.actions.githubusercontent.com'),
        policy.OIDCSourceRepositoryURI(repo),
        policy.OIDCSourceRepositoryOwnerURI('https://github.com/videoq-jp'),
        policy.OIDCSourceRepositoryRef('refs/heads/main'),
        policy.OIDCSourceRepositoryDigest(source),
        policy.OIDCBuildSignerURI(workflow),
        policy.OIDCRunnerEnvironment('github-hosted'),
        policy.OIDCRunInvocationURI(f'{repo}/actions/runs/{run_id}/attempts/{attempt}'),
    ])


def check_statement(payload_type, payload, name, digest, source, run_id, attempt):
    if payload_type != 'application/vnd.in-toto+json':
        raise ValueError('Unsupported signed payload type')
    data = json.loads(payload)
    repo = 'https://github.com/' + manifest.REPOSITORY
    workflow = {'repository': repo, 'path': '.github/workflows/onprem-release.yml', 'ref': 'refs/heads/main'}
    predicate = data.get('predicate', {})
    definition = predicate.get('buildDefinition', {})
    run = predicate.get('runDetails', {})
    if (data.get('_type') != 'https://in-toto.io/Statement/v1'
            or data.get('predicateType') != 'https://slsa.dev/provenance/v1'
            or definition.get('buildType') != 'https://actions.github.io/buildtypes/workflow/v1'
            or definition.get('externalParameters', {}).get('workflow') != workflow
            or definition.get('internalParameters', {}).get('github', {}).get('runner_environment') != 'github-hosted'
            or run.get('builder', {}).get('id') != repo + '/.github/workflows/onprem-release.yml@refs/heads/main'
            or run.get('metadata', {}).get('invocationId') != f'{repo}/actions/runs/{run_id}/attempts/{attempt}'):
        raise ValueError('Signed SLSA workflow/run policy mismatch')
    dependencies = definition.get('resolvedDependencies', [])
    if not any(item.get('uri') == 'git+' + repo + '@refs/heads/main' and item.get('digest', {}).get('gitCommit') == source for item in dependencies):
        raise ValueError('Signed source revision mismatch')
    if not any(item.get('name') == name and item.get('digest', {}).get('sha256') == digest for item in data.get('subject', [])):
        raise ValueError('Signed subject name/digest mismatch: ' + name)


def required_files(data):
    return ['release.json', *[item['name'] for item in data['charts'].values()],
            'release.sigstore.json', *[name + '.sigstore.json' for name in data['images']]]


def verify(directory, source, run_id, attempt):
    from sigstore.models import Bundle
    from sigstore.verify import Verifier
    directory = Path(directory)
    release_file = directory / 'release.json'
    data = manifest.validate(json.loads(release_file.read_text()), source)
    policy = identity_policy(source, run_id, attempt, data['repository'])
    # Trust roots come from Sigstore's independently bootstrapped production TUF
    # configuration, NEVER from the downloaded release or its certificate chain.
    verifier = Verifier.production()
    verified = {}
    def attest(bundle_name, subject, expected):
        if bundle_name not in verified:
            bundle = Bundle.from_json((directory / bundle_name).read_bytes())
            verified[bundle_name] = verifier.verify_dsse(bundle, policy)
        check_statement(*verified[bundle_name], subject, expected, source, run_id, attempt)
    attest('release.sigstore.json', 'release.json', hashlib.sha256(release_file.read_bytes()).hexdigest())
    for entry in data['charts'].values():
        chart = directory / entry['name']
        actual = hashlib.sha256(chart.read_bytes()).hexdigest()
        if 'sha256:' + actual != entry['digest']:
            raise ValueError('Chart bytes do not match the signed release')
        attest('release.sigstore.json', entry['name'], actual)
    for component, entry in data['images'].items():
        attest(component + '.sigstore.json', entry['repository'], entry['digest'].removeprefix('sha256:'))
    return manifest.helm_values(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('run_id')
    parser.add_argument('attempt')
    parser.add_argument('directory', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('inference_output', type=Path)
    args = parser.parse_args()
    outputs = [args.output.resolve(), args.inference_output.resolve()]
    # Do not allow output files to replace any signed artifact or bundle.
    data = manifest.validate(json.loads((args.directory / 'release.json').read_text()), args.source)
    protected = {(args.directory / name).resolve() for name in required_files(data)}
    if len(set(outputs)) != 2 or any(path in protected for path in outputs):
        raise ValueError('Outputs must be distinct and cannot overwrite signed inputs')
    application, inference = verify(args.directory, args.source, args.run_id, args.attempt)
    manifest.write_atomic(args.output, application)
    manifest.write_atomic(args.inference_output, inference)
    print('Verified public release: signatures, transparency log, workflow, main ref, source SHA, hosted runner, run and artifact digests')


if __name__ == '__main__':
    main()
