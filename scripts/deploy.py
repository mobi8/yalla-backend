"""Deploy an explicit environment with the existing AWS CLI. No credentials in artifacts."""
import argparse
import base64
import uuid
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
parser.add_argument('--isolated-player', type=uuid.UUID, help='Limit DEV bot targeting to a test guest')
parser.add_argument('--notification-rollout', action='store_true', help='Review DEV change set before executing; preserve live bot config')
args = parser.parse_args()
if args.notification_rollout and (args.environment != 'dev' or args.isolated_player):
    parser.error('--notification-rollout requires DEV and cannot alter the bot allowlist')
if args.isolated_player and args.environment != 'dev':
    parser.error('--isolated-player is DEV-only')
if args.environment == 'dev' and args.profile != 'yalla-dev':
    parser.error('DEV deployments require the yalla-dev profile')
root = Path(__file__).resolve().parents[1]

def run(*cmd, capture=False):
    return subprocess.run(cmd, cwd=root, check=True, text=True, capture_output=capture).stdout

def aws(*cmd, capture=False):
    return run('aws', *cmd, '--profile', args.profile, '--region', args.region, capture=capture)

run('npm', 'run', 'typecheck')
run('npm', 'test')
run('python3', 'infra/generate.py')
identity = json.loads(aws('sts', 'get-caller-identity', capture=True))
print(f"Deploying {args.environment} in account {identity['Account']} / {args.region}", flush=True)
dev_policy = None
if args.environment == 'dev':
    if identity['Account'] != '533266967583' or args.region != 'ap-south-1':
        raise RuntimeError('Unexpected DEV account or region')
    dev_policy = json.loads((root / 'config/dev/bots.json').read_text())
    if args.isolated_player:
        dev_policy['incomingRaid']['allowedPlayerIds'] = [str(args.isolated_player)]
    template = json.loads((root / 'infra/bundle1.json').read_text())
    expected_rate = template['Resources']['IncomingRule']['Properties']['ScheduleExpression']['Fn::If'][1]
    minutes = dev_policy['offlinePolicy']['scheduleMinutes']
    unit = 'minute' if minutes == 1 else 'minutes'
    if expected_rate != f'rate({minutes} {unit})':
        raise RuntimeError('DEV Lambda policy and generated Rule rate differ')
    run('node', '--import', 'tsx', '--input-type=module', '-e',
        'import { botsSchema } from "./src/bots-config.ts"; botsSchema.parse(JSON.parse(process.argv[1]));',
        json.dumps(dev_policy))

storage_stack = f'yalla-{args.environment}-artifacts'
aws('cloudformation', 'deploy', '--stack-name', storage_stack, '--template-file', 'infra/artifacts.json', '--no-fail-on-empty-changeset')
outputs = json.loads(aws('cloudformation', 'describe-stacks', '--stack-name', storage_stack, '--query', 'Stacks[0].Outputs', capture=True))
bucket = next(o['OutputValue'] for o in outputs if o['OutputKey'] == 'ArtifactBucket')
with tempfile.TemporaryDirectory(prefix='yalla-package-') as temp:
    stage = Path(temp) / 'package'
    stage.mkdir()
    run('npm', 'run', 'build', '--', '--outDir', str(stage / 'dist'))
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
    if dev_policy is not None and not args.notification_rollout:
        if args.isolated_player:
            rule = json.loads(aws('cloudformation', 'describe-stack-resource', '--stack-name',
                'yalla-dev-bundle1', '--logical-resource-id', 'IncomingRule',
                '--query', 'StackResourceDetail.PhysicalResourceId', capture=True))
            aws('events', 'disable-rule', '--name', rule)
        config_path = Path(temp) / 'bots.json'
        config_path.write_text(json.dumps(dev_policy, indent=2) + '\n')
        aws('s3api', 'put-object', '--bucket', 'yalla-result-pools-533266967583',
            '--key', 'game-config/dev/v1/bots.json', '--body', str(config_path),
            '--content-type', 'application/json', capture=True)
    if args.notification_rollout:
        stack = 'yalla-dev-bundle1'
        change_set = 'notification-' + uuid.uuid4().hex[:16]
        template_key = f'bundle1/{change_set}.json'
        aws('s3','cp','infra/bundle1.json',f's3://{bucket}/{template_key}','--only-show-errors')
        aws('cloudformation','create-change-set','--stack-name',stack,'--change-set-name',change_set,
            '--change-set-type','UPDATE','--capabilities','CAPABILITY_IAM',
            '--template-url',f'https://{bucket}.s3.{args.region}.amazonaws.com/{template_key}',
            '--parameters','ParameterKey=Environment,ParameterValue=dev',
            'ParameterKey=ArtifactBucket,UsePreviousValue=true','ParameterKey=ArtifactKey,UsePreviousValue=true',
            f'ParameterKey=NotificationArtifactKey,ParameterValue={key}','ParameterKey=RankingPeriodDays,UsePreviousValue=true',capture=True)
        aws('cloudformation','wait','change-set-create-complete','--stack-name',stack,'--change-set-name',change_set)
        review=json.loads(aws('cloudformation','describe-change-set','--stack-name',stack,'--change-set-name',change_set,capture=True))
        print('DEV change set: '+review['ChangeSetName'],flush=True)
        for item in review['Changes']:
            change=item['ResourceChange']
            print(change['Action'],change['LogicalResourceId'],change.get('Replacement','-'),flush=True)
            protected = {'IncomingPermission', 'IncomingRule', 'IncomingFunction', 'IncomingRole'}
            if change['LogicalResourceId'] in protected or change['Action'] == 'Remove' or change.get('Replacement') not in (None,'False'):
                raise RuntimeError('Change set would remove or replace an existing resource; stopped before execution')
        aws('cloudformation','execute-change-set','--stack-name',stack,'--change-set-name',change_set)
        aws('cloudformation','wait','stack-update-complete','--stack-name',stack)
    else:
        aws('cloudformation', 'deploy', '--stack-name', f'yalla-{args.environment}-bundle1', '--template-file', 'infra/bundle1.json',
            '--s3-bucket', bucket, '--s3-prefix', 'bundle1/templates',
            '--capabilities', 'CAPABILITY_IAM', '--parameter-overrides', f'Environment={args.environment}', f'ArtifactBucket={bucket}', f'ArtifactKey={key}',
            *( [f'NotificationArtifactKey={key}'] if dev_policy is not None else [] ),
            '--no-fail-on-empty-changeset')
    if dev_policy is not None:
        rule = json.loads(aws('cloudformation', 'describe-stack-resource', '--stack-name',
            'yalla-dev-bundle1', '--logical-resource-id', 'IncomingRule',
            '--query', 'StackResourceDetail.PhysicalResourceId', capture=True))
        live = json.loads(aws('events', 'describe-rule', '--name', rule, capture=True))
        target = f"arn:aws:lambda:{args.region}:{identity['Account']}:function:yalla-dev-incoming-raid"
        rules = json.loads(aws('events', 'list-rule-names-by-target', '--target-arn', target,
            '--query', 'RuleNames', capture=True))
        groups = json.loads(aws('scheduler', 'list-schedule-groups', '--query', 'ScheduleGroups[].Name', capture=True))
        schedules = [schedule for group in groups for schedule in json.loads(aws(
            'scheduler', 'list-schedules', '--group-name', group, '--query', 'Schedules',
            capture=True)) if schedule['Target']['Arn'] == target or schedule['Target']['Arn'].startswith(target + ':')]
        if live['ScheduleExpression'] != expected_rate or rules != [rule] or schedules:
            raise RuntimeError('DEV trigger differs from the generated policy or has duplicate targets')
        if live['State'] != 'ENABLED':
            if args.notification_rollout:
                raise RuntimeError('Existing bot rule is unexpectedly disabled')
            aws('events', 'enable-rule', '--name', rule)
            live = json.loads(aws('events', 'describe-rule', '--name', rule, capture=True))
            if live['State'] != 'ENABLED':
                raise RuntimeError('DEV Rule was not enabled after deployment')
        deployed = Path(temp) / 'deployed-bots.json'
        aws('s3api', 'get-object', '--bucket', 'yalla-result-pools-533266967583', '--key',
            'game-config/dev/v1/bots.json', str(deployed), capture=True)
        actual_sha = json.loads(aws('lambda', 'get-function-configuration', '--function-name',
            'yalla-dev-player' if args.notification_rollout else 'yalla-dev-incoming-raid', '--query', 'CodeSha256', capture=True))
        expected_sha = base64.b64encode(bytes.fromhex(digest)).decode()
        if (not args.notification_rollout and json.loads(deployed.read_text()) != dev_policy) or actual_sha != expected_sha:
            raise RuntimeError('DEV runtime config or Lambda package differs from deployment input')
        print(f"Verified {live['Arn']} at {expected_rate}", flush=True)
print(aws('cloudformation', 'describe-stacks', '--stack-name', f'yalla-{args.environment}-bundle1', '--query', 'Stacks[0].Outputs', capture=True))
