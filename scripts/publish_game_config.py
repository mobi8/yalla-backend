"""Validate and publish one dev Game Config. Initial creation cannot overwrite an existing key."""
import argparse,json,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--name',required=True,choices=['collection','journey','jackpot','raid']);p.add_argument('--profile',required=True);p.add_argument('--region',default='ap-south-1');p.add_argument('--replace-etag',help='Explicit optimistic replacement; increment JSON version first')
a=p.parse_args();root=Path(__file__).resolve().parents[1];source=root/'config/dev'/(a.name+'.json')
code="import {parseConfig} from './dist/game-config.js';import{readFileSync}from'node:fs';const c=parseConfig(process.argv[1],readFileSync(process.argv[2],'utf8'),'dev');console.log(JSON.stringify({version:c.version,hash:c.contentHash}));"
info=json.loads(subprocess.check_output(['node','--input-type=module','-e',code,a.name,str(source)],cwd=root,text=True))
args=['aws','s3api','put-object','--bucket','yalla-result-pools-533266967583','--key','game-config/dev/v1/'+a.name+'.json','--body',str(source),'--content-type','application/json','--server-side-encryption','AES256','--metadata','config-version='+info['version'],'--profile',a.profile,'--region',a.region]
if a.replace_etag:
 prior=json.loads(subprocess.check_output(['aws','s3api','head-object','--bucket','yalla-result-pools-533266967583','--key','game-config/dev/v1/'+a.name+'.json','--if-match',a.replace_etag,'--profile',a.profile,'--region',a.region],text=True))
 if prior.get('Metadata',{}).get('config-version')==info['version']:
  raise SystemExit('Increment the JSON config version before replacing an existing config.')
args += ['--if-match',a.replace_etag] if a.replace_etag else ['--if-none-match','*']
result=json.loads(subprocess.check_output(args,cwd=root,text=True))
print(json.dumps({'name':a.name,**info,'etag':result['ETag'],'versionId':result.get('VersionId')}))
