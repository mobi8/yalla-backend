"""Exercise Friends through the DEV API using two isolated guest identities."""
from concurrent.futures import ThreadPoolExecutor
import json
import secrets
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

AWS = ['aws', '--profile', 'yalla-dev', '--region', 'ap-south-1']
API = 'https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com'


def call(path, token=None, data=None, expect=200):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = Request(API + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
    try:
        with urlopen(req, timeout=30) as response:
            status, result = response.status, json.load(response)
    except HTTPError as error:
        status, result = error.code, json.load(error)
    valid = (expect,) if isinstance(expect, int) else expect
    if status not in valid:
        raise RuntimeError(f'{path}: expected {valid}, received {status} {result.get("error", "")}')
    return status, result


def bootstrap(key, expect=201):
    return call('/auth/guest', data={'guestKey': key}, expect=expect)[1]


def send(token, code, operation=None, referral=False, expect=200):
    return call('/friends/requests', token, {
        'code': code, 'requestId': operation or str(uuid4()), 'referral': referral,
    }, expect)


def action(token, code, request_id, name):
    return call('/friends/actions', token, {'code': code, 'requestId': request_id, 'action': name})[1]


def entries(route, token):
    return call('/friends/' + route, token)[1]['entries']


def settle(token):
    session = call('/drop/sessions', token, {})[1]['session']['sessionId']
    path = f'/drop/sessions/{session}/rounds'
    round_ = call(path, token, {'requestId': str(uuid4()), 'prediction': 'RED', 'energyCost': 3})[1]['round']
    result = call(path + '/' + round_['roundId'] + '/result', token, {
        'requestId': str(uuid4()), 'actual': round_['expected'], 'physicsVersion': round_['physicsVersion'],
    })[1]
    return result['round']['reward']['distance'], result['round']['settledAt']


def main():
    account = subprocess.check_output(AWS + ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], text=True).strip()
    if account != '533266967583':
        raise RuntimeError('Unexpected DEV account')

    call('/friends/code', expect=(401, 403))
    first_key = secrets.token_hex(32)
    first, second = bootstrap(first_key), bootstrap(secrets.token_hex(32))
    a, b = [guest['tokens']['accessToken'] for guest in (first, second)]
    code_a, code_b = [call('/friends/code', token)[1]['code'] for token in (a, b)]
    assert code_a != code_b
    restored = bootstrap(first_key, 200)['tokens']['accessToken']
    assert call('/friends/code', restored)[1]['code'] == code_a
    search = call('/friends/search?' + urlencode({'code': ' ' + code_b.lower() + ' '}), a)[1]
    assert search['code'] == code_b and search['type'] == 'PLAYER' and not search['me']
    invite = call('/invites/' + code_b)[1]
    assert set(invite) == {'code', 'nickname'} and invite['nickname'] == search['nickname']
    send(a, code_a, expect=400)
    print('PASS friend-code issuance, reconnect, lookup, privacy and ownership', flush=True)

    with ThreadPoolExecutor(max_workers=2) as workers:
        one = workers.submit(send, a, code_b, expect=(200,409))
        two = workers.submit(send, b, code_a, expect=(200,409))
        first_result, second_result = one.result(), two.result()
    assert sorted([first_result[0], second_result[0]]) == [200,409]
    sender, recipient, sending_code, receiving_code, request_id = (
        (a,b,code_a,code_b,first_result[1]['requestId']) if first_result[0] == 200
        else (b,a,code_b,code_a,second_result[1]['requestId']))
    assert call('/friends/count', recipient)[1]['count'] == 1
    assert entries('requests/outgoing', sender)[0]['requestId'] == request_id
    action(recipient, sending_code, request_id, 'decline')
    assert call('/friends/count', recipient)[1]['count'] == 0
    request_id = send(sender, receiving_code)[1]['requestId']
    action(sender, receiving_code, request_id, 'cancel')
    operation = str(uuid4())
    request_id = send(a, code_b, operation, referral=True)[1]['requestId']
    assert send(a, code_b, operation, referral=True)[1]['requestId'] == request_id
    action(b, code_a, request_id, 'accept')
    action(b, code_a, request_id, 'accept')
    assert len(entries('rank', a)) == len(entries('rank', b)) == 2
    action(a, code_b, request_id, 'remove')
    assert len(entries('rank', a)) == len(entries('rank', b)) == 1
    print('PASS cross requests, decline, cancel, idempotent accept and removal, both rankings', flush=True)

    assert entries('help', a) == entries('help', b) == []
    send(a, 'bot-player_1001', expect=404)
    distance, _ = settle(a)
    for _ in range(8):
        me = next(entry for entry in entries('rank', a) if entry['me'])
        if me['distanceMeters'] == distance:
            break
        time.sleep(1)
    assert me['distanceMeters'] == distance and float(distance) > 0
    assert all(entry['type'] == 'PLAYER' for entry in entries('suggested', b))
    print('PASS real-player suggestions, empty HELP and weekly distance settlement', flush=True)


if __name__ == '__main__':
    main()
