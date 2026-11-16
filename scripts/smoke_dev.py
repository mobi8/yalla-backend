"""Real dev smoke tests. Guest secrets and tokens stay in memory, never in output."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--profile', default='yalla-dev')
parser.add_argument('--region', default='ap-south-1')
parser.add_argument('--environment', choices=['dev'], default='dev')
args = parser.parse_args()

def aws(*cmd):
    result = subprocess.run(['aws', *cmd, '--profile', args.profile, '--region', args.region], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout or '{}')

outputs = aws('cloudformation', 'describe-stacks', '--stack-name', 'yalla-dev-bundle1')['Stacks'][0]['Outputs']
config = {o['OutputKey']: o['OutputValue'] for o in outputs}
endpoint = config['ApiEndpoint']

def request(method, path, payload=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(endpoint + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read() or '{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or '{}')

passed = []
def check(name, condition):
    if not condition:
        raise AssertionError(name)
    passed.append(name)
    print('PASS ' + name, flush=True)

guest_key = secrets.token_hex(32)
status, created = request('POST', '/auth/guest', {'guestKey': guest_key})
if status != 201:
    raise AssertionError(f'Guest bootstrap status {status}: {created.get("error", "unknown")}')
player_id = created['save']['profile']['playerId']
token = created['tokens']['accessToken']
wallet = created['save']['wallet']
check('guest create and documented initial balances', wallet['energy'] == 50 and wallet['diamond'] == 0 and wallet['yallaPoint'] == 0)
status, restored = request('POST', '/auth/guest', {'guestKey': guest_key})
check('same credential reconnect restores exact player and wallet', status == 200 and restored['save'] == created['save'])
for path in ['/players/me', '/players/me/progress', '/players/me/wallet', '/players/me/save']:
    status, result = request('GET', path, token=token)
    check('authenticated read ' + path, status == 200)
    if path.endswith('/save'):
        check('transactional save restoration', result == created['save'])
for label, invalid in [('missing token', None), ('invalid token', 'invalid.jwt.token'), ('ID token', created['tokens']['idToken'])]:
    status, _ = request('GET', '/players/me/save', token=invalid)
    check('deny ' + label, status in [401, 403])
status, _ = request('POST', '/players/guest', {'energy': 999999, 'playerId': 'victim'}, token)
check('deny client balance and ownership injection', status == 400)
status, _ = request('PUT', '/players/me/wallet', {'energy': 999999}, token)
check('no client wallet mutation route', status == 404)
with ThreadPoolExecutor(max_workers=4) as executor:
    duplicates = list(executor.map(lambda _: request('POST', '/players/guest', {}, token), range(4)))
check('concurrent provisioning retries do not grant twice', all(s == 200 and r['wallet'] == wallet and r['profile']['playerId'] == player_id for s, r in duplicates))
status, refreshed = request('POST', '/auth/refresh', {'refreshToken': created['tokens']['refreshToken']})
check('refresh issues a rotated credential', status == 200 and refreshed['tokens']['refreshToken'] != created['tokens']['refreshToken'])
status, snapshot = request('GET', '/players/me/save', token=refreshed['tokens']['accessToken'])
check('refreshed token preserves identity and data', status == 200 and snapshot == created['save'])
status, _ = request('POST', '/auth/refresh', {'refreshToken': 'invalid'})
check('deny invalid refresh token', status == 401)

# Recover an interrupted Cognito-only account; no game state is written by this setup.
second_key = secrets.token_hex(32)
username = 'guest_' + hashlib.sha256(second_key.encode()).hexdigest()
with tempfile.NamedTemporaryFile(mode='w', prefix='yalla-cognito-', suffix='.json') as f:
    os.chmod(f.name, 0o600)
    json.dump({'UserPoolId': config['UserPoolId'], 'Username': username, 'MessageAction': 'SUPPRESS', 'TemporaryPassword': 'Aa1!' + secrets.token_hex(32)}, f)
    f.flush()
    aws('cognito-idp', 'admin-create-user', '--cli-input-json', 'file://' + f.name)
with ThreadPoolExecutor(max_workers=2) as executor:
    recovered_requests = list(executor.map(lambda _: request('POST', '/auth/guest', {'guestKey': second_key}), range(2)))
check('concurrent interrupted registration recovery grants once', sorted(s for s, _ in recovered_requests) == [200, 201])
status, second = next((s, r) for s, r in recovered_requests if s == 201)
check('recover interrupted Cognito registration', second['save']['profile']['playerId'] != player_id)
status, other_save = request('GET', '/players/me/save', token=second['tokens']['accessToken'])
check('different guest token sees only its own player', status == 200 and other_save['profile']['playerId'] == second['save']['profile']['playerId'])
status, _ = request('GET', '/players/' + player_id, token=second['tokens']['accessToken'])
check('no arbitrary player ID read route', status == 404)

items = aws('dynamodb', 'query', '--table-name', config['PlayerTable'], '--consistent-read',
            '--key-condition-expression', 'PK = :pk', '--expression-attribute-values', json.dumps({':pk': {'S': 'PLAYER#' + player_id}}))['Items']
check('one immutable starter receipt and cause, wallet version remains one',
      len(items) == 5 and len([i for i in items if i['SK']['S'].startswith('ECONOMY#OP#')]) == 1 and
      next(i for i in items if i['SK']['S'] == 'WALLET')['version']['N'] == '1')
# Force a conflict on the existing auth link and prove another write rolls back with it.
import base64
claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
candidate = str(uuid.uuid4())
auth_pk = 'AUTH#guest#' + config['UserPoolId'] + ':' + claims['sub']
link = aws('dynamodb', 'get-item', '--table-name', config['PlayerTable'], '--consistent-read',
           '--key', json.dumps({'PK': {'S': auth_pk}, 'SK': {'S': 'PLAYER'}}))['Item']
check('auth mapping owns the same player with versioned metadata', link['playerId']['S'] == player_id and link['schemaVersion']['N'] == '1' and link['version']['N'] == '1')
writes = [{'Put': {'TableName': config['PlayerTable'], 'Item': {'PK': {'S': auth_pk}, 'SK': {'S': 'PLAYER'}}, 'ConditionExpression': 'attribute_not_exists(PK)'}},
          {'Put': {'TableName': config['PlayerTable'], 'Item': {'PK': {'S': 'PLAYER#' + candidate}, 'SK': {'S': 'PROFILE'}}, 'ConditionExpression': 'attribute_not_exists(PK)'}}]
with tempfile.NamedTemporaryFile(mode='w', prefix='yalla-atomic-', suffix='.json') as f:
    json.dump(writes, f); f.flush()
    result = subprocess.run(['aws', 'dynamodb', 'transact-write-items', '--transact-items', 'file://' + f.name,
                             '--profile', args.profile, '--region', args.region], capture_output=True, text=True)
check('DynamoDB rejects conflicting atomic creation', result.returncode != 0 and 'TransactionCanceledException' in result.stderr)
orphan = aws('dynamodb', 'get-item', '--table-name', config['PlayerTable'], '--consistent-read',
             '--key', json.dumps({'PK': {'S': 'PLAYER#' + candidate}, 'SK': {'S': 'PROFILE'}}))
check('failed transaction leaves no partial Player', 'Item' not in orphan)
status, _ = request('POST', '/auth/logout', {'refreshToken': refreshed['tokens']['refreshToken']})
check('refresh credential revocation', status == 200)
deadline = time.monotonic() + 12
while True:
    status, _ = request('POST', '/auth/refresh', {'refreshToken': refreshed['tokens']['refreshToken']})
    if status == 401 or time.monotonic() >= deadline:
        break
    time.sleep(1)
check('revoked refresh token is denied', status == 401)
status, recovered = request('POST', '/auth/guest', {'guestKey': guest_key})
check('guest credential reauthentication retains wallet after revocation', status == 200 and recovered['save'] == created['save'])
print(json.dumps({'passed': len(passed), 'endpoint': endpoint, 'playerIds': [player_id, second['save']['profile']['playerId']]}, indent=2))
