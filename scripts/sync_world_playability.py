"""Validate dev world release against authored Unity assets and sync the local progression catalog."""
import argparse
import json
from pathlib import Path
import re

backend = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--unity", type=Path, default=backend.parent / "YallaJourney")
parser.add_argument("--check", action="store_true", help="Validate without writing the generated asset")
parser.add_argument("--register-remote", nargs="+", default=[], metavar="WORLD_ID",
                    help="Generate remote registrations from backend art keys after removing direct references")
args = parser.parse_args()
if args.check and args.register_remote:
    parser.error("--check is read-only")

world, buildings, rewards = [
    json.loads((backend / "config/dev" / f"{name}.json").read_text())["data"]
    for name in ("world", "world-buildings", "world-rewards")
]
assert world["releaseId"] == buildings["releaseId"] == rewards["releaseId"], "World bundle release mismatch"
assets = args.unity / "Assets"
drop = assets / "YallaDrop"
resources = drop / "Resources"
catalog = (resources / "WorldAssetCatalog.asset").read_text()
remote_manifest = resources / "MyShelterRemoteWorlds.json"
remote_worlds = {world["id"]: world for world in json.loads(remote_manifest.read_text())["worlds"]}
catalog_refs = dict(
    (key, (guid, int(file_id)))
    for key, file_id, guid in re.findall(r"^  - key: (\S+)\n    sprite: \{fileID: (-?\d+), guid: (\w+),", catalog, re.M)
)
asset_metas = {}
for path in assets.rglob("*.meta"):
    match = re.search(r"^guid: ([0-9a-f]{32})$", path.read_text(errors="replace"), re.M)
    if match and path.with_suffix("").is_file():
        guid = match[1]
        assert guid not in asset_metas, f"Duplicate asset GUID {guid}"
        asset_metas[guid] = path

def sprite(key, remote=False):
    if remote:
        assert key not in catalog_refs, f"Remote sprite is still embedded: {key}"
        _, guid, file_id = key.split("/")
        file_id = int(file_id)
    else:
        assert key in catalog_refs, f"Missing primary catalog sprite: {key}"
        guid, file_id = catalog_refs[key]
    assert key == f"sprite/{guid}/{file_id}" and guid in asset_metas, f"Broken sprite reference: {key}"
    settings = asset_metas[guid].read_text()
    if file_id == 21300000:
        assert re.search(r"^  spriteMode: 1$", settings, re.M), f"Expected single sprite: {key}"
    else:
        assert re.search(rf"^\s+internalID: {file_id}$", settings, re.M), f"Missing sprite subasset: {key}"
    return guid, file_id

scene = (drop / "Scenes/MyShelterScene.unity").read_text()
authored = dict(re.findall(r"^  - worldId: (\S+)\n(.*?)(?=^  - worldId:|^  progressFill:|\Z)", scene, re.M | re.S))
map_scene = (drop / "Scenes/WorldJourneyScene.unity").read_text()
raid_scene = (drop / "Scenes/RaidScene.unity").read_text()
map_refs = {
    key: (guid, int(file_id))
    for key, file_id, guid in re.findall(r"^  - worldId: (\S+)\n    thumbnail: \{fileID: (-?\d+), guid: (\w+),", map_scene, re.M)
}
map_previews = {
    int(position): (guid, int(file_id))
    for position, file_id, guid in re.findall(
        r"^  - position: (\d+)\n    displayName: [^\n]*\n    thumbnail: \{fileID: (-?\d+), guid: (\w+),", map_scene, re.M
    )
}
raid_refs = {
    key: (guid, int(file_id))
    for key, file_id, guid in re.findall(r"^  - worldId: (\S+)\n    sprite: \{fileID: (-?\d+), guid: (\w+),", raid_scene, re.M)
}
layout_script = (drop / "Features/Shelter/UI/MyShelterWorldLayout.cs.meta").read_text()
layout_guid = re.search(r"^guid: (\w+)$", layout_script, re.M)[1]
reward_by_world = {entry["worldId"]: entry for entry in rewards["worlds"]}
policy_source = (drop / "Core/Data/ProgressionChestRewards.cs").read_text()
local_amount = int(re.search(r"\bWorldYallaPoints = (\d+)", policy_source)[1])
local_policy = [{"type": "YALLA_POINT", "amount": local_amount}]
def artwork(entry):
    world_id = entry["id"]
    art = buildings["objectSets"][entry["overrides"].get("objectSetKey", entry["objectSetKey"])]
    background = entry["overrides"].get("backgroundAssetKey", entry["backgroundAssetKey"])
    overrides = buildings["worldOverrides"].get(world_id, {}).get("buildingOverrides", {})
    stages = []
    for default in buildings["defaults"]["buildings"]:
        index = int(default["id"].rsplit("-", 1)[1]) - 1
        keys = overrides.get(default["id"], {}).get("levelAssetKeys", [None] * 5)
        stages.extend(keys[level - 1] or art["buildings"][index][default["levels"][level - 1]["spriteSlot"]]
                      for level in range(2, 6))
    return background, stages

for world_id in args.register_remote:
    entry = next((entry for entry in world["worlds"] if entry["id"] == world_id), None)
    assert entry and world_id != "dunes", f"Unknown or local-only world: {world_id}"
    background, stages = artwork(entry)
    remote_worlds[world_id] = {"id": world_id, "background": background, "stages": stages}

rows = []

for entry in sorted(world["worlds"], key=lambda value: value["order"]):
    world_id = entry["id"]
    reward = reward_by_world[world_id]
    playable = entry["enabled"] and entry["contentState"] == "READY"
    if entry["enabled"]:
        assert playable, f"{world_id}: enabled worlds must be READY"
    if playable:
        assert reward["confirmed"] and reward["completionRewards"] == local_policy, (
            f"{world_id}: confirm the existing {local_amount} YP policy or align server/local reward handling first"
        )
    remote = remote_worlds.get(world_id)
    if playable or remote:
        background_key, stage_keys = artwork(entry)
        background = sprite(background_key, remote is not None)
        assert entry["thumbnailAssetKey"] != entry["fallbackAssetKey"], f"{world_id}: placeholder thumbnail"
        thumbnail = sprite(entry["thumbnailAssetKey"])
        assert map_refs.get(world_id, map_previews.get(entry["order"])) == thumbnail, f"{world_id}: missing local map thumbnail"
        if not remote:
            assert raid_refs.get(world_id) == background, f"{world_id}: missing Attack/Raid background"
        stages = [sprite(key, remote is not None) for key in stage_keys]
        assert len(stages) == 20, f"{world_id}: missing building stage artwork"
        if remote:
            assert remote["background"] == background_key and remote["stages"] == stage_keys, f"{world_id}: stale remote addresses"
            assert world_id not in authored and world_id not in raid_refs, f"{world_id}: remote Scene dependency"
        elif world_id != "dunes":
            block = authored[world_id]
            refs = [(guid, int(file_id)) for file_id, guid in re.findall(r"\{fileID: (-?\d+), guid: (\w+), type: 3\}", block)]
            assert refs[:21] == [background, *stages], f"{world_id}: runtime and Editor artwork differ"
        layout_dir = drop / "Features/Shelter/Layouts" if remote else resources
        layout = layout_dir / f"MyShelterLayout_{world_id}.asset"
        if remote:
            assert not (resources / layout.name).exists(), f"{world_id}: remote Layout still in Resources"
        layout_data = layout.read_text()
        assert f"m_Script: {{fileID: 11500000, guid: {layout_guid}," in layout_data, f"{world_id}: wrong Layout script"
        assert layout.with_suffix(".asset.meta") in asset_metas.values(), f"{world_id}: missing Layout .meta"
        assert len(re.findall(r"^  - contact:", layout_data, re.M)) == 5, f"{world_id}: expected five Layout slots"
        assert len(re.findall(r"^    - offset:", layout_data, re.M)) == 20, f"{world_id}: expected four stages per slot"
    rows.append({
        "id": world_id, "displayName": entry["displayName"], "nextWorldId": entry["nextWorldId"], "playable": playable
    })

by_id = {entry["id"]: entry for entry in world["worlds"]}
assert len(by_id) == len(rows) == len(reward_by_world), "World and reward IDs must match"
reachable = set()
previous, current = None, rows[0]["id"]
while current is not None:
    assert current in by_id and current not in reachable, f"Unknown or repeated next world: {current}"
    assert by_id[current]["unlockAfterWorldId"] == previous, f"{current}: invalid prerequisite"
    reachable.add(current)
    previous, current = current, by_id[current]["nextWorldId"]
assert len(reachable) == len(rows), "Disconnected worlds"
target = resources / "MyShelterWorldAvailability.json"
output = json.dumps({"releaseId": world["releaseId"], "worlds": rows}, ensure_ascii=False, indent=2) + "\n"
if args.check:
    assert target.read_text() == output, f"{target} is stale. Run {Path(__file__).name}."
else:
    if args.register_remote:
        remote_manifest.write_text(json.dumps({"worlds": list(remote_worlds.values())}, indent=2) + "\n")
    target.write_text(output)
print(f"{world['releaseId']}: {sum(row['playable'] for row in rows)}/{len(rows)} worlds playable")
