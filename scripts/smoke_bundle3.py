"""New dev Guest only: earn money via real Drop, buy all 20 upgrades, COMPLETE and travel. No DB seeding."""
import argparse,json,secrets,uuid,urllib.request,urllib.error,subprocess,concurrent.futures
p=argparse.ArgumentParser();p.add_argument('--profile',default='yalla-dev');p.add_argument('--region',default='ap-south-1');a=p.parse_args()
base='https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com';checks=0
def check(ok,label):
 global checks
 if not ok:raise RuntimeError(label)
 checks+=1;print('PASS '+label,flush=True)
def call(method,path,body=None,token=None):
 req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token}if token else{})})
 try:
  with urllib.request.urlopen(req,timeout=25)as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def api(method,path,body=None):
 status,value=call(method,path,body,token)
 if status!=200:raise RuntimeError(path+' HTTP '+str(status)+' '+str(value.get('error')))
 return value
def aws(*args):return json.loads(subprocess.check_output(['aws',*args,'--profile',a.profile,'--region',a.region],text=True))
key=secrets.token_hex(32);status,auth=call('POST','/auth/guest',{'guestKey':key});check(status==201,'new isolated Guest')
token=auth['tokens']['accessToken'];player=auth['save']['profile']['playerId'];opened=api('POST','/drop/sessions',{});sid=opened['session']['sessionId'];dropPath='/drop/sessions/'+sid+'/rounds'
s=api('GET','/worlds/state');revision=s['catalog']['revision']
def command(world='dunes'):return {'requestId':str(uuid.uuid4()),'worldId':world,'configRevision':revision}
check(len(s['catalog']['worlds'])==100 and s['worldState']['levels']==[1]*5 and s['save']['progress']['worldId']=='dunes','100 World catalog and first World initial levels')
check(len(s['currentWorld']['buildings'])==5 and all(len(b['levels'])==5 for b in s['currentWorld']['buildings']),'five buildings and five levels')
check(sum(w['playable']for w in s['catalog']['worlds'])==7,'only confirmed first seven Worlds playable')
check(s['catalog']['worlds'][30]['thumbnailAssetKey']==s['catalog']['worlds'][30]['fallbackAssetKey'],'World 31 missing thumbnail uses declared fallback')
check(call('POST','/worlds/upgrade',{**command(),'buildingId':'building-1','expectedLevel':1},token)[1].get('error')=='INSUFFICIENT_YALLA_POINT','insufficient funds rejected before mutation')
check(call('POST','/worlds/complete',command(),token)[1].get('error')=='WORLD_NOT_MAX','early COMPLETE rejected')
check(call('POST','/worlds/upgrade',{**command(),'buildingId':'building-6','expectedLevel':1},token)[0]==400,'invalid building ID rejected')
for i in range(4):
 issued=api('POST',dropPath,{'requestId':str(uuid.uuid4()),'prediction':'RED','energyCost':3});r=issued['round']
 settled=api('POST',dropPath+'/'+r['roundId']+'/result',{'requestId':str(uuid.uuid4()),'actual':{'ball':'Ball001','color':'RED','symbol':'Star'},'physicsVersion':r['physicsVersion']})
check(settled['save']['wallet']['yallaPoint']==240,'funded by existing Drop policy without Wallet grants')
first={**command(),'buildingId':'building-1','expectedLevel':1}
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:results=list(ex.map(lambda _:api('POST','/worlds/upgrade',first),range(2)))
check(all(v['save']['wallet']['yallaPoint']==230 for v in results),'concurrent duplicate purchase charges exactly 10')
check(results[0]['save']['progress']['facilityLevels']==[2,1,1,1,1],'building grows 1 to 2 once')
check(call('POST','/worlds/upgrade',{**command(),'buildingId':'building-1','expectedLevel':1},token)[1].get('error')=='STALE_BUILDING_LEVEL','stale level request rejected')
for building in range(1,6):
 for level in range(2 if building==1 else 1,5):
  grown=api('POST','/worlds/upgrade',{**command(),'buildingId':'building-'+str(building),'expectedLevel':level})
 check(grown['save']['progress']['facilityLevels'][building-1]==5,'building '+str(building)+' reaches MAX')
check(grown['save']['wallet']['yallaPoint']==40 and grown['save']['progress']['constructionStars']=='20','20 upgrades debit exactly 200 and earn 20 stars')
check(call('POST','/worlds/upgrade',{**command(),'buildingId':'building-1','expectedLevel':5},token)[1].get('error')=='BUILDING_MAX','MAX re-purchase rejected')
complete=command()
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:completions=list(ex.map(lambda _:api('POST','/worlds/complete',complete),range(2)))
done=completions[0];check(done['save']['wallet']['yallaPoint']==140 and done['save']['progress']['worldRunComplete'],'COMPLETE grants existing YallaPoint 100 once')
check('canyon'in done['unlockedWorldIds'] and done['worldState']['rewardClaimed'],'next World unlock and reward flag committed')
check(api('POST','/worlds/complete',command())['save']['wallet']['yallaPoint']==140,'new COMPLETE request ID cannot repeat reward')
move=command('canyon');moved=api('POST','/worlds/select',move);api('POST','/worlds/select',move)
check(moved['save']['progress']['worldId']=='canyon' and moved['save']['progress']['facilityLevels']==[1]*5 and moved['save']['progress']['village']==1,'World 1 to 2 enters five Level 1 buildings without Village stages')
check(call('POST','/worlds/select',command('dunes'),token)[0]==409,'completed World revisit forbidden')
check(call('POST','/worlds/select',command('world-008'),token)[0]==409,'unready World 8 cannot be entered')
last=api('POST','/worlds/upgrade',{**command('canyon'),'buildingId':'building-1','expectedLevel':1})
_,refresh=call('POST','/auth/refresh',{'refreshToken':auth['tokens']['refreshToken']});token=refresh['tokens']['accessToken']
restored=api('GET','/worlds/state');check(restored['save']['progress']['worldId']=='canyon' and restored['worldState']['levels']==[2,1,1,1,1],'reconnect restores current World and levels')
check(restored['save']['wallet']['yallaPoint']==130 and restored['save']['progress']['worldCompletionCounts']['dunes']==1,'reconnect restores Wallet and completion history')
check(call('GET','/worlds/state')[0]==401,'World endpoints require authentication')
outputs=aws('cloudformation','describe-stacks','--stack-name','yalla-dev-bundle1')['Stacks'][0]['Outputs'];table=next(v['OutputValue']for v in outputs if v['OutputKey']=='PlayerTable')
def item(sk):return aws('dynamodb','get-item','--table-name',table,'--consistent-read','--key',json.dumps({'PK':{'S':'PLAYER#'+player},'SK':{'S':sk}})).get('Item')
w=item('WALLET');progress=item('PROGRESS');archive=item('WORLD#dunes');current=item('WORLD#canyon');receipt=item('ECONOMY#OP#world:'+complete['requestId'])
check(int(w['yallaPoint']['N'])==130 and progress['worldId']['S']=='canyon','DynamoDB Wallet and Progress agree')
check(archive['status']['S']=='COMPLETE' and all(v['N']=='5'for v in archive['levels']['L']) and archive['rewardClaimed']['BOOL'],'DynamoDB completed World buildings retained')
check([int(v['N'])for v in current['levels']['L']]==[2,1,1,1,1],'DynamoDB current World has independent building state')
check(receipt['configVersions']['M']['rewards']['S']=='world-rewards-v1' and receipt['result']['M']['completionRewards']['L'][0]['M']['amount']['N']=='100','DynamoDB actual completion Config and reward receipt')
check(item('ECONOMY#CAUSE#world-complete:dunes')['operationId']['S']=='world:'+complete['requestId'],'DynamoDB one World-scoped completion cause')
print(json.dumps({'checks':checks,'playerId':player,'sessionId':sid,'completionRequestId':complete['requestId'],'wallet':restored['save']['wallet'],'progress':restored['save']['progress'],'worldsStored':2,'note':'real APIs/DB; Drop actual simulated; no Unity/iPhone run'}),flush=True)
