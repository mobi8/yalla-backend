"""Extract current scene references without running Unity; emits config and a local Sprite resolver catalog."""
from pathlib import Path
import argparse
import re,json,subprocess
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check',action='store_true',help='Check scene-derived assets without writing')
args=parser.parse_args()
backend=Path(__file__).resolve().parents[1];unity=backend.parent/'YallaJourney'
def scene(path):
 raw=path.read_text();plain=re.sub(r'^%.*\n','',raw,flags=re.M);plain=re.sub(r'^--- !u!\d+ &-?\d+(?: stripped)?','---',plain,flags=re.M)
 headers=list(re.finditer(r'^--- !u!(\d+) &(-?\d+)(?: stripped)?\s*$',raw,re.M))
 docs=json.loads(subprocess.check_output(['/usr/bin/ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_stream(STDIN.read))"],input=plain,text=True))
 return {int(h[2]):(int(h[1]),next(iter(d.values())))for h,d in zip(headers,docs)}
s=scene(unity/'Assets/YallaDrop/Scenes/MyShelterScene.unity');growth=next(d for t,d in s.values()if 'worldArtwork'in d)
m=scene(unity/'Assets/YallaDrop/Scenes/WorldJourneyScene.unity');mapview=next(d for t,d in m.values()if 'mapPreviews'in d)
config_dir=backend/'config/dev'
world_config=json.loads((config_dir/'world.json').read_text())
building_config=json.loads((config_dir/'world-buildings.json').read_text())
refs={}
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
for world in world_config['data']['worlds']:
 id=world['id'];preview=previews.get(world['order'])
 thumbnail=thumbs.get(id) or (preview and preview['thumbnail'])
 if thumbnail and (id in sets or world['enabled']):
  world['thumbnailAssetKey']=key(thumbnail)
 if id in sets:
  if world['objectSetKey'] is None:world['objectSetKey']=id
  if world['objectSetKey']==id:world['backgroundAssetKey']=sets[id]['backgroundAssetKey']
building_config['data']['objectSets'].update(sets)
# Resolve only GUIDs that already exist. No generated images or scene edits.
paths={}
for f in (unity/'Assets').rglob('*.meta'):
 match=re.search(r'^guid: ([a-f0-9]{32})$',f.read_text(errors='ignore'),re.M)
 if match:paths[match[1]]=str(f.relative_to(unity))[:-5]
for ref in refs.values():assert ref['guid']in paths,'Missing source asset '+ref['guid']
script_meta=unity/'Assets/YallaDrop/Core/Data/WorldAssetCatalog.cs.meta'
script_guid=re.search(r'^guid: ([a-f0-9]{32})$',script_meta.read_text(),re.M)[1]
catalog=unity/'Assets/YallaDrop/Resources/WorldAssetCatalog.asset'
existing=catalog.read_text()
assert not re.search(r'^    prefab: (?!\{fileID: 0\}$)',existing,re.M),'Non-sprite catalog entries require manual merge'
existing_refs={}
for k,file_id,guid in re.findall(r'^  - key: (sprite/\S+)\n    sprite: \{fileID: (-?\d+), guid: ([a-f0-9]{32}), type: 3\}',existing,re.M):
 existing_refs[k]={'guid':guid,'fileID':int(file_id)}
assert len(existing_refs)==len(re.findall(r'^  - key:',existing,re.M)),'Unexpected catalog entry format'
assert f'm_Script: {{fileID: 11500000, guid: {script_guid},' in existing,'Catalog script GUID mismatch'
existing_refs.update(refs)
text=existing.split('  entries:\n',1)[0]+'  entries:\n'
for k,ref in existing_refs.items():text+='  - key: '+k+'\n    sprite: {fileID: '+str(ref['fileID'])+', guid: '+ref['guid']+', type: 3}\n    prefab: {fileID: 0}\n'
outputs={catalog:text}
for name,config in [('world',world_config),('world-buildings',building_config)]:
 outputs[config_dir/f'{name}.json']=json.dumps(config,indent=2)+'\n'
for path,content in outputs.items():
 if args.check:
  assert path.read_text()==content,f'{path} is stale; rerun without --check'
 else:
  path.write_text(content)
print(json.dumps({'objectSets':len(sets),'buildingSpriteReferences':sum(len(x)-1 for v in sets.values()for x in v['buildings'])}))
