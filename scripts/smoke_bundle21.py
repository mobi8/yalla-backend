"""Fast dev-only integration test. A NEW isolated Guest earns rights through Drop; existing Players untouched."""
import argparse,concurrent.futures,json,secrets,subprocess,urllib.request,urllib.error,uuid
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
key=secrets.token_hex(32);status,auth=call('POST','/auth/guest',{'guestKey':key});check(status==201,'isolated Guest created')
token=auth['tokens']['accessToken'];player=auth['save']['profile']['playerId'];opened=api('POST','/drop/sessions',{});sid=opened['session']['sessionId'];path='/drop/sessions/'+sid+'/rounds'
check(opened['save']['wallet']['energy']==50,'Bundle 1 starter Wallet retained')
def drop(symbol,ball):
 start={'requestId':str(uuid.uuid4()),'prediction':'RED','energyCost':3};issued=api('POST',path,start);r=issued['round']
 check(issued['save']['wallet']['energy']>=0 and r['seed']==12345 and len(r['order'])==25,'Bundle 2 S3 assignment '+symbol)
 check(r['collectionConfig']['version']=='collection-v1' and r['journeyConfig']['version']=='journey-v1','Round pins both Config versions '+symbol)
 result={'requestId':str(uuid.uuid4()),'actual':{'ball':ball,'color':'RED','symbol':symbol},'physicsVersion':r['physicsVersion']}
 settled=api('POST',path+'/'+r['roundId']+'/result',result);duplicate=api('POST',path+'/'+r['roundId']+'/result',result)
 check(duplicate['save']['wallet']==settled['save']['wallet'],'Drop settlement replay '+symbol)
 return settled
first=drop('Crown','Ball008');check(first['collection']['jackpotTickets']==1,'Collection Crown creates Jackpot right')
state=api('GET','/bonuses');check(state['bonus']['queue'][0]['kind']=='Jackpot','Round entitlement imported in order')
check(all(state['settings'][name]['version']==name+'-v1' for name in ['collection','journey','jackpot','raid']),'four S3 Configs read and validated')
api('POST','/bonuses/ensure',{'kind':'Jackpot'})
check(call('POST',path,{'requestId':str(uuid.uuid4()),'prediction':'RED','energyCost':1},token)[0]==409,'active bonus fences new Drop')
spin={'requestId':str(uuid.uuid4())}
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:spins=list(ex.map(lambda _:api('POST','/bonuses/jackpot/spins',spin),range(2)))
receipt=spins[0]['result'];reward=receipt['goldReward'];jid=receipt['id']
check(all(r['result']['id']==jid for r in spins),'concurrent Jackpot same result')
check(reward==[100,250,500,1000,2500,5000][receipt['segment']],'Jackpot configured sector reward')
check(spins[0]['collection']['jackpotTickets']==0 and spins[0]['save']['wallet']['yallaPoint']==60+reward,'Jackpot ticket debit and Wallet payout')
check(api('POST','/bonuses/jackpot/spins',{'requestId':str(uuid.uuid4())})['result']['id']==jid,'new ID cannot reroll unacknowledged Jackpot')
check(receipt['config']['version']=='jackpot-v1' and len(receipt['config']['contentHash'])==64,'Jackpot settlement Config version/hash')
_,refresh=call('POST','/auth/refresh',{'refreshToken':auth['tokens']['refreshToken']});token=refresh['tokens']['accessToken']
check(api('GET','/bonuses')['bonus']['jackpot']['id']==jid,'reconnect restores paid Jackpot before acknowledgement')
api('POST','/bonuses/jackpot/'+jid+'/ack',{});api('POST','/bonuses/jackpot/'+jid+'/ack',{})
check(api('GET','/bonuses')['bonus']['run']['completed']==1,'duplicate Jackpot GET advances once')
api('POST','/bonuses/finish',{'kind':'Jackpot'});api('POST','/bonuses/finish',{'kind':'Jackpot'})
check(api('GET','/bonuses')['bonus']['run']is None,'Jackpot batch finishes idempotently')
drop('Y','Ball012');drop('A','Ball011');letters=drop('L','Ball006');check(letters['collection']['raidTickets']==1,'YALLA current 1Y2A2L creates Raid right')
api('GET','/bonuses');api('POST','/bonuses/ensure',{'kind':'Raid'});prepared=api('POST','/bonuses/raids',{'requestId':str(uuid.uuid4())});bots=prepared['bonus']['raid']['bots'];rid=prepared['result']['operation']['raidId']
check(len(bots)==6 and len({b['botId']for b in bots})==6,'six unique mirror bots without Cognito users')
check(all(b['worldId']=='dunes' and b['village']==1 and b['facilityLevels']==[1]*5 for b in bots),'existing World/Village and initial facility mirror policy')
check(prepared['collection']['raidTickets']==1,'Raid target preparation is free')
api('POST','/bonuses/raids/'+rid+'/cancel',{});check(api('GET','/bonuses')['collection']['raidTickets']==1,'target cancellation consumes no right')
begin={'requestId':str(uuid.uuid4()),'botId':bots[1]['botId']};prepared=api('POST','/bonuses/raids',begin);rid=prepared['result']['operation']['raidId']
check(api('POST','/bonuses/raids',begin)['result']['operation']['raidId']==rid,'Raid begin request is idempotent')
check(api('GET','/bonuses')['bonus']['raid']['activeRaid']['raidId']==rid,'unconfirmed Raid resumes')
attack={'requestId':str(uuid.uuid4()),'facilityId':0}
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:attacks=list(ex.map(lambda _:api('POST','/bonuses/raids/'+rid+'/attack',attack),range(2)))
check(all(x['result']['result']['rewardAmount']==100 for x in attacks),'Raid reward matches existing upgrade cost 10 x multiplier 10')
check(attacks[0]['collection']['raidTickets']==0 and attacks[0]['save']['wallet']['yallaPoint']==240+reward+100,'Raid ticket debit and Wallet paid once')
check(api('POST','/bonuses/raids/'+rid+'/attack',{**attack,'requestId':str(uuid.uuid4())})['save']['wallet']['yallaPoint']==240+reward+100,'new attack request ID cannot duplicate payout')
check(call('POST','/bonuses/raids/'+rid+'/attack',{**attack,'facilityId':1},token)[0]==409,'changed facility replay rejected')
check(call('POST','/bonuses/raids/'+rid+'/cancel',{},token)[0]==409,'settled Raid cannot be cancelled')
check(api('GET','/bonuses')['bonus']['raid']['activities'][-1]['raidId']==rid,'settled Raid activity restores before GET')
api('POST','/bonuses/raids/'+rid+'/ack',{});api('POST','/bonuses/raids/'+rid+'/ack',{});api('POST','/bonuses/finish',{'kind':'Raid'})
final=drop('Crown','Ball008');check(final['save']['wallet']['energy']==55 and final['save']['wallet']['yallaPoint']==400+reward,'Drop, Jackpot, Raid and Journey share one correct Wallet')
check(final['save']['progress']['distance']=='330' and final['round']['journeyAward']['count']=='1','Journey 300m chest once at configured amount')
check(call('GET','/bonuses')[0]==401,'bonus APIs require access authentication')
outputs=aws('cloudformation','describe-stacks','--stack-name','yalla-dev-bundle1')['Stacks'][0]['Outputs'];table=next(v['OutputValue']for v in outputs if v['OutputKey']=='PlayerTable')
def item(sk):return aws('dynamodb','get-item','--table-name',table,'--consistent-read','--key',json.dumps({'PK':{'S':'PLAYER#'+player},'SK':{'S':sk}})).get('Item')
w=item('WALLET');check(int(w['energy']['N'])==55 and int(w['yallaPoint']['N'])==400+reward,'DynamoDB final Wallet verified')
check(item('ECONOMY#OP#jackpot:'+jid)['configVersion']['S']=='jackpot-v1' and item('ECONOMY#OP#raid:'+rid)['configVersion']['S']=='raid-v1','DynamoDB bonus receipts/config versions verified')
check(item('JOURNEY#CHESTS')['processedDistance']['S']=='330' and item('JOURNEY#CHESTS')['claimedChestCount']['S']=='1','DynamoDB absolute Journey watermark and claim count')
check(item('BONUS#STATE')['run']['NULL']is True,'DynamoDB finished bonus state')
print(json.dumps({'checks':checks,'playerId':player,'sessionId':sid,'jackpotId':jid,'raidId':rid,'jackpotReward':reward,'wallet':final['save']['wallet'],'distance':'330','note':'API simulated actual, Unity/iPhone not run'}),flush=True)
