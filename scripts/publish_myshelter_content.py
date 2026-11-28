"""Publish an existing Unity Addressables platform output to a content-only S3 path."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("build_dir", type=Path)
parser.add_argument("--bucket", required=True)
parser.add_argument("--prefix", required=True, help="myshelter/dev/<client-line>/<platform>")
parser.add_argument("--profile", required=True)
parser.add_argument("--region", default="ap-south-1")
parser.add_argument("--publish", action="store_true", help="Without this flag, validate and print the upload order")
args = parser.parse_args()
prefix = args.prefix.strip("/")
if not re.fullmatch(r"myshelter/dev/[A-Za-z0-9._-]+/[A-Za-z0-9_-]+", prefix):
    parser.error("Expected myshelter/dev/<client-line>/<platform>")
if args.bucket == "yalla-result-pools-533266967583":
    parser.error("Select an approved content-only bucket, separate from server config")
hashes = sorted(args.build_dir.glob("*.hash"))
bundles = sorted(args.build_dir.glob("*.bundle"))
if len(hashes) != 1 or not bundles:
    parser.error("Expected one catalog hash and at least one bundle in the platform output")
marker = hashes[0]
catalogs = [p for p in (marker.with_suffix(".json"), marker.with_suffix(".bin")) if p.is_file()]
if len(catalogs) != 1:
    parser.error("Catalog hash must have one corresponding .json or .bin catalog")
catalog = catalogs[0]
if any(not re.search(r"[0-9a-f]{32}\.bundle$", path.name, re.I) for path in bundles):
    parser.error("Bundle file names must end in their content hash (Append Hash)")

def aws(*command, **kwargs):
    return subprocess.run(["aws", "--profile", args.profile, "--region", args.region, "--no-cli-pager", *command],
                          check=True, text=True, capture_output=True, **kwargs).stdout

ordered = [*bundles, catalog, marker]
for path in ordered:
    print(f"{path.name} -> s3://{args.bucket}/{prefix}/{path.name}", flush=True)
if not args.publish:
    raise SystemExit(0)

def object_args(path):
    return ("--bucket", args.bucket, "--key", f"{prefix}/{path.name}")

def read(path, destination):
    return json.loads(aws("s3api", "get-object", *object_args(path), str(destination)))

def write(path, body, *condition, immutable=False):
    cache = "public,max-age=31536000,immutable" if immutable else "no-cache"
    mime = {".json": "application/json", ".hash": "text/plain"}.get(path.suffix, "application/octet-stream")
    return json.loads(aws("s3api", "put-object", *object_args(path), "--body", str(body),
                          "--content-type", mime, "--cache-control", cache, *condition))

with tempfile.TemporaryDirectory(prefix="myshelter-content-") as temp:
    folder = Path(temp)
    verify_path = folder / "readback"
    for bundle in bundles:
        try:
            write(bundle, bundle, "--if-none-match", "*", immutable=True)
        except subprocess.CalledProcessError as error:
            if "PreconditionFailed" not in error.stderr:
                raise
        read(bundle, verify_path)
        if bundle.read_bytes() != verify_path.read_bytes():
            raise RuntimeError(f"Bundle readback mismatch: {bundle.name}")

    # Snapshot both catalog objects first. Prevent an upload from overwriting a concurrent release.
    previous = {}
    for path in (catalog, marker):
        backup = folder / path.name
        try:
            previous[path] = (backup, read(path, backup)["ETag"])
        except subprocess.CalledProcessError as error:
            if not ("NoSuchKey" in error.stderr or "(404)" in error.stderr):
                raise
    published = {}
    try:
        for path in (catalog, marker):
            condition = ("--if-match", previous[path][1]) if path in previous else ("--if-none-match", "*")
            published[path] = write(path, path, *condition)["ETag"]
            read(path, verify_path)
            if path.read_bytes() != verify_path.read_bytes():
                raise RuntimeError(f"Catalog readback mismatch: {path.name}")
    except Exception:
        for path, etag in reversed(list(published.items())):
            if path in previous:
                write(path, previous[path][0], "--if-match", etag)
            else:
                aws("s3api", "delete-object", *object_args(path), "--if-match", etag)
        raise
print("Published and verified bundle objects, catalog, and hash.")
