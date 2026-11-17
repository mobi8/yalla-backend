"""One isolated dev Guest; no existing Player reads/writes. Never prints credentials."""
import concurrent.futures
import json
import secrets
import subprocess
import urllib.request
import urllib.error
import uuid
import argparse
p=argparse.ArgumentParser();p.add_argument('--profile',default='yalla-dev');p.add_argument('--region',default='ap-south-1');a=p.parse_args()
base='https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com'
checks=0
def check(ok,label):
 global checks
 if not ok: raise RuntimeError(label)
 checks+=1; print('PASS '+label,flush=True)
def call(method,path,body=None,token=None):
 req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})
 try:
  with urllib.request.urlopen(req,timeout=25) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def aws(*args):
 return json.loads(subprocess.check_output(['aws',*args,'--profile',a.profile,'--region',a.region],text=True))
key=secrets.token_hex(32)
status,auth=call('POST','/auth/guest',{'guestKey':key});check(status==201,'new isolated Guest')
token=auth['tokens']['accessToken'];player=auth['save']['profile']['playerId']
status,opened=call('POST','/drop/sessions',{},token);check(status==200,'Session created')
sid=opened['session']['sessionId'];path='/drop/sessions/'+sid+'/rounds'
check(opened['save']['wallet']['energy']==50,'initial Energy 50')
body={'requestId':str(uuid.uuid4()),'prediction':'RED','energyCost':3}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex: starts=list(ex.map(lambda _:call('POST',path,body,token),range(2)))
check(all(s==200 for s,r in starts),'concurrent start retry accepted')
r=starts[0][1]['round'];rid=r['roundId'];check(all(v['round']['roundId']==rid for _,v in starts),'same assigned Round')
check(starts[0][1]['save']['wallet']['energy']==47,'Energy charged exactly 3')
check(r['poolFileId'].endswith('result_pool_100_1.json') and sorted(r['order'])==list(range(25)) and r['seed']==12345,'S3 assignment and 25-ball input')
check(call('GET','/drop/sessions/active',token=token)[1]['round']['roundId']==rid,'issued Round resumes')
check(call('POST',path,{**body,'requestId':str(uuid.uuid4())},token)[0]==409,'second pending Round blocked')
check(call('POST',path+'/'+rid+'/cancel',{'requestId':str(uuid.uuid4()),'reason':'PHYSICS_TIMEOUT'},token)[0]==409,'early refund blocked')
# Simulated physics DTO, explicitly a mismatch, not proof of Unity physical execution.
actual={'ball':'Ball008','color':'RED','symbol':'Crown'}
if actual==r['expected']:actual={'ball':'Ball010','color':'BLUE','symbol':'A'}
result={'requestId':str(uuid.uuid4()),'actual':actual,'physicsVersion':r['physicsVersion']}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex: results=list(ex.map(lambda _:call('POST',path+'/'+rid+'/result',result,token),range(2)))
check(all(s==200 for s,v in results),'concurrent result retry accepted')
settled=results[0][1];reward=settled['round']['reward'];check(settled['round']['matchStatus']=='MISMATCH','mismatch audit persisted')
expected=10*(2 if actual['color']=='RED' else 1)*3
check(settled['save']['wallet']['yallaPoint']==expected,'PERMISSIVE actual reward once')
check(settled['save']['progress']['distance']==('120' if actual['color']=='RED' else '15'),'Journey reward once')
check(call('POST',path+'/'+rid+'/result',{**result,'requestId':str(uuid.uuid4())},token)[1]['save']['wallet']['yallaPoint']==expected,'new request ID cannot duplicate settlement')
check(call('POST',path+'/'+rid+'/result',{**result,'actual':r['expected']},token)[0]==409,'changed result replay blocked')
check(call('POST',path+'/'+rid+'/cancel',{'requestId':str(uuid.uuid4()),'reason':'PHYSICS_TIMEOUT'},token)[0]==409,'settled refund blocked')
check(call('GET','/drop/sessions/active')[0]==401,'missing auth blocked')
_,refresh=call('POST','/auth/refresh',{'refreshToken':auth['tokens']['refreshToken']});token=refresh['tokens']['accessToken']
resumed=call('GET','/drop/sessions/active',token=token)[1]
check(resumed['session']['sessionId']==sid and resumed['save']['wallet']['yallaPoint']==expected,'refresh/reconnect retains Session and Wallet')
stack=aws('cloudformation','describe-stacks','--stack-name','yalla-dev-bundle1')['Stacks'][0]
table=next(o['OutputValue'] for o in stack['Outputs'] if o['OutputKey']=='PlayerTable')
def get(sk):return aws('dynamodb','get-item','--table-name',table,'--consistent-read','--key',json.dumps({'PK':{'S':'PLAYER#'+player},'SK':{'S':sk}})).get('Item')
w=get('WALLET');round_item=get('ROUND#'+rid)
check(int(w['energy']['N'])==47 and int(w['yallaPoint']['N'])==expected,'DynamoDB Wallet verified')
check(round_item['status']['S']=='SETTLED' and round_item['actual']['M']['ball']['S']==actual['ball'],'DynamoDB actual Round verified')
check(bool(get('ECONOMY#CAUSE#settle:'+rid)) and bool(get('ECONOMY#OP#settle:'+rid)),'DynamoDB immutable receipt and cause verified')
# Exercise the real chained chest/Collection transaction without time waits or existing Players.
for index in range(3):
    _, issued = call('POST', path, {**body, 'requestId':str(uuid.uuid4())}, token)
    current = issued['round']; chain_result={'requestId':str(uuid.uuid4()), 'actual':{'ball':'Ball008','color':'RED','symbol':'Crown'}, 'physicsVersion':current['physicsVersion']}
    code, chain = call('POST',path+'/'+current['roundId']+'/result',chain_result,token)
    check(code==200,'chained Crown settlement '+str(index+1))
    duplicate = call('POST',path+'/'+current['roundId']+'/result',chain_result,token)[1]
    check(duplicate['save']['wallet']==chain['save']['wallet'],'chained reward replay does not change Wallet '+str(index+1))
check(chain['save']['wallet']['energy']==58,'300m chest Energy 20 granted once; above-cap Energy retained')
check(chain['save']['wallet']['yallaPoint']==expected+180,'chained YallaPoint total')
check(chain['save']['progress']['lastDistanceMilestone']=='1','distance chest milestone checkpoint')
check(chain['collection']['jackpotTickets']>=3,'Collection bonus rights accumulated')
final_wallet=get('WALLET');check(int(final_wallet['energy']['N'])==58 and int(final_wallet['yallaPoint']['N'])==expected+180,'DynamoDB chained Wallet verified')
restarted=call('GET','/drop/sessions/active',token=token)[1]
check(restarted['save']['wallet']['energy']==58 and len(restarted['session'].get('recentConfirmedResults',[]))==4,'server recharge cap and four-round history restored')
print(json.dumps({'checks':checks,'playerId':player,'sessionId':sid,'roundId':rid,'wallet':chain['save']['wallet'],'note':'API simulated actual; Unity/iPhone physics not executed'}),flush=True)
