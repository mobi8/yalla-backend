"""Extract current scene references without running Unity; emits config and a local Sprite resolver catalog."""
from pathlib import Path
import re,json,subprocess,uuid
backend=Path(__file__).resolve().parents[1];unity=backend.parent/'YallaJourney'
def scene(path):
 raw=path.read_text();plain=re.sub(r'^%.*\n','',raw,flags=re.M);plain=re.sub(r'^--- !u!\d+ &-?\d+(?: stripped)?','---',plain,flags=re.M)
 headers=list(re.finditer(r'^--- !u!(\d+) &(-?\d+)(?: stripped)?\s*$',raw,re.M))
 docs=json.loads(subprocess.check_output(['/usr/bin/ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_stream(STDIN.read))"],input=plain,text=True))
 return {int(h[2]):(int(h[1]),next(iter(d.values())))for h,d in zip(headers,docs)}
s=scene(unity/'Assets/YallaDrop/Scenes/MyShelterScene.unity');growth=next(d for t,d in s.values()if 'worldArtwork'in d)
m=scene(unity/'Assets/YallaDrop/Scenes/WorldJourneyScene.unity');mapview=next(d for t,d in m.values()if 'mapPreviews'in d)
ids=['dunes','canyon','oasis','bazaar','palace','nightcity','goldentemple']+[f'world-{n:03}'for n in range(8,101)]
names=['Dunes','Canyon','Oasis','Bazaar','Palace','Night City','Golden Temple'];refs={}
def key(ref):
 if not ref or not ref.get('guid'):return None
 value='sprite/'+ref['guid']+'/'+str(ref['fileID']);refs[value]=ref;return value
arts={'dunes':{'background':s[growth['backgroundImage']['fileID']][1]['m_Sprite'],'objects':growth['objects']}}
arts.update({a['worldId']:a for a in growth['worldArtwork']})
thumbs={a['worldId']:a['thumbnail']for a in mapview['artwork']};previews={a['position']:a for a in mapview['mapPreviews']}
hidden=key(mapview['hiddenMapSprite'])
sets={}
for world,art in arts.items():
 sets[world]={'backgroundAssetKey':key(art['background']),'buildings':[[None]+[key(x)for x in obj['levelSprites']]for obj in art['objects']]}
worlds=[];rewards=[]
for n,id in enumerate(ids,1):
 thumbnail=key(thumbs[id])if n<=7 else key(previews[n]['thumbnail'])if n<=30 else hidden
 worlds.append({'id':id,'order':n,'displayName':names[n-1]if n<=7 else previews[n]['displayName']if n<=30 else f'World {n}',
 'enabled':n<=7,'contentState':'READY'if n<=7 else 'PLANNED','objectSetKey':id if id in sets else None,'backgroundAssetKey':sets.get(id,sets['dunes'])['backgroundAssetKey'],
 'thumbnailAssetKey':thumbnail,'fallbackAssetKey':hidden,'fallbackObjectSetKey':'dunes','unlockAfterWorldId':ids[n-2]if n>1 else None,
 'nextWorldId':ids[n]if n<100 else None,'completionCondition':'ALL_BUILDINGS_MAX','rewardKey':id,'overrides':{}})
 rewards.append({'worldId':id,'confirmed':n<=7,'completionRewards':[{'type':'YALLA_POINT','amount':100}]if n<=7 else []})
raid_view=(unity/'Assets/YallaDrop/Features/Raid/UI/RaidSceneView.cs').read_text();labels=re.findall(r'"([^"]+)"',re.search(r'Names = \{([^}]+)\}',raid_view)[1])
buildings={'releaseId':'world-bundle-v1','defaults':{'initialLevel':1,'maxLevel':5,'upgradePrices':[10,10,10,10],
 'buildings':[{'id':f'building-{i+1}','displayName':label,'order':i+1,'purchaseCondition':'PREVIOUS_LEVEL','levels':[{'level':l,'spriteSlot':l-1,'prefabAssetKey':None}for l in range(1,6)],'layout':None}for i,label in enumerate(labels)]},'objectSets':sets,'worldOverrides':{}}
for name,data in [('world',{'releaseId':'world-bundle-v1','worlds':worlds}),('world-buildings',buildings),('world-rewards',{'releaseId':'world-bundle-v1','worlds':rewards})]:
 (backend/'config/dev'/f'{name}.json').write_text(json.dumps({'schemaVersion':1,'environment':'dev','version':name+'-v1','data':data},indent=2)+'\n')
# Resolve only GUIDs that already exist. No generated images or scene edits.
paths={}
for f in (unity/'Assets').rglob('*.meta'):
 match=re.search(r'^guid: ([a-f0-9]{32})$',f.read_text(errors='ignore'),re.M)
 if match:paths[match[1]]=str(f.relative_to(unity))[:-5]
for ref in refs.values():assert ref['guid']in paths,'Missing source asset '+ref['guid']
script=unity/'Assets/YallaDrop/Core/Data/WorldAssetCatalog.cs';script_guid=uuid.uuid5(uuid.NAMESPACE_URL,'yalla-bundle3-WorldAssetCatalog.cs').hex
Path(str(script)+'.meta').write_text('fileFormatVersion: 2\nguid: '+script_guid+'\n')
catalog=unity/'Assets/YallaDrop/Resources/WorldAssetCatalog.asset'
text='%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_GameObject: {fileID: 0}\n  m_Enabled: 1\n  m_EditorHideFlags: 0\n  m_Script: {fileID: 11500000, guid: '+script_guid+', type: 3}\n  m_Name: WorldAssetCatalog\n  m_EditorClassIdentifier: Assembly-CSharp::YallaJourney.Data.WorldAssetCatalog\n  entries:\n'
for k,ref in sorted(refs.items()):text+='  - key: '+k+'\n    sprite: {fileID: '+str(ref['fileID'])+', guid: '+ref['guid']+', type: 3}\n    prefab: {fileID: 0}\n'
catalog.write_text(text);Path(str(catalog)+'.meta').write_text('fileFormatVersion: 2\nguid: '+uuid.uuid5(uuid.NAMESPACE_URL,'yalla-bundle3-WorldAssetCatalog.asset').hex+'\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 11400000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n')
report={'sourceCommits':{'backend':'7e0dde0','unity':'e1d721d'},'buildingNames':labels,'objectSets':len(sets),'buildingSpriteReferences':sum(len(x)-1 for v in sets.values()for x in v['buildings']),
 'publishedThumbnailsThrough':30,'existingExtraThumbnails':[v for n,v in previews.items()if n>30],'assets':{k:paths[v['guid']]for k,v in refs.items()},'legacyVillage':'compatibility only; no new Village progression'}
(backend/'docs/11-world-source-inventory.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k]for k in ['buildingNames','objectSets','buildingSpriteReferences','publishedThumbnailsThrough']}))
