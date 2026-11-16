"""Deploy an explicit environment with the existing AWS CLI. No credentials in artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--environment', required=True, choices=['dev', 'staging', 'prod'])
parser.add_argument('--profile', required=True)
parser.add_argument('--region', default='ap-south-1')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]

def run(*cmd, capture=False):
    return subprocess.run(cmd, cwd=root, check=True, text=True, capture_output=capture).stdout

def aws(*cmd, capture=False):
    return run('aws', *cmd, '--profile', args.profile, '--region', args.region, capture=capture)

run('npm', 'run', 'typecheck')
run('npm', 'test')
run('npm', 'run', 'build')
run('python3', 'infra/generate.py')
identity = json.loads(aws('sts', 'get-caller-identity', capture=True))
print(f"Deploying {args.environment} in account {identity['Account']} / {args.region}", flush=True)
storage_stack = f'yalla-{args.environment}-artifacts'
aws('cloudformation', 'deploy', '--stack-name', storage_stack, '--template-file', 'infra/artifacts.json', '--no-fail-on-empty-changeset')
outputs = json.loads(aws('cloudformation', 'describe-stacks', '--stack-name', storage_stack, '--query', 'Stacks[0].Outputs', capture=True))
bucket = next(o['OutputValue'] for o in outputs if o['OutputKey'] == 'ArtifactBucket')
with tempfile.TemporaryDirectory(prefix='yalla-package-') as temp:
    stage = Path(temp) / 'package'
    shutil.copytree(root / 'dist', stage / 'dist')
    shutil.copy2(root / 'package.json', stage / 'package.json')
    lock = json.loads((root / 'package-lock.json').read_text())
    for path, metadata in lock['packages'].items():
        if not path or metadata.get('dev') or not (root / path).is_dir():
            continue
        target = stage / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(root / path, target, dirs_exist_ok=True)
    archive = Path(temp) / 'bundle1.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(stage).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                bundle.writestr(info, path.read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    key = f'bundle1/{digest}.zip'
    aws('s3', 'cp', str(archive), f's3://{bucket}/{key}', '--only-show-errors')
    aws('cloudformation', 'deploy', '--stack-name', f'yalla-{args.environment}-bundle1', '--template-file', 'infra/bundle1.json',
        '--capabilities', 'CAPABILITY_IAM', '--parameter-overrides', f'Environment={args.environment}', f'ArtifactBucket={bucket}', f'ArtifactKey={key}',
        '--no-fail-on-empty-changeset')
print(aws('cloudformation', 'describe-stacks', '--stack-name', f'yalla-{args.environment}-bundle1', '--query', 'Stacks[0].Outputs', capture=True))
