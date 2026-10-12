"""Maintainer-only, pinned execution bundle. No upstream installers/config hooks."""
import hashlib, json, os, re, shutil, subprocess, sys, urllib.request, zipfile, io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'vendor' / 'execution' / 'win-x64'
LOCK = ROOT / 'resources' / 'production-lock'
AI_COMMIT = 'f58314d9473d11efef94dd68b523e1b52643d736'
UNIT_COMMIT = '08ffc7c65b61b1b2edd545616061a99973c13ce1'
def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'Solar-production-builder'}), timeout=60) as response:
        data = response.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024: raise ValueError('Download too large')
        return data
def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
def extract(data, target, prefix=''):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            if item.is_dir() or not item.filename.startswith(prefix): continue
            name = item.filename[len(prefix):]
            parts = name.split('/')
            if not name or any(p in ('', '.', '..') or ':' in p or '\\' in p for p in parts): raise ValueError('Unsafe zip path')
            if (item.external_attr >> 16) & 0o170000 == 0o120000: raise ValueError('Zip symlink')
            if item.file_size > 16 * 1024 * 1024: raise ValueError('Zip entry too large')
            put(target.joinpath(*parts), archive.read(item))

OUT.mkdir(parents=True, exist_ok=True)
LOCK.mkdir(parents=True, exist_ok=True)
release = 'https://github.com/hi-godot/godot-ai/releases/download/v4.2.3/'
manifest = fetch(release + 'godot-ai-v4-plugin.manifest.json')
signature = fetch(release + 'godot-ai-v4-plugin.manifest.sig')
verifier = fetch(f'https://raw.githubusercontent.com/hi-godot/godot-ai/{AI_COMMIT}/src/godot_ai/release_verify.py').decode()
pem = re.search(r'PUBLIC_KEY_PEM = """(.*?)"""', verifier, re.S).group(1)
put(LOCK / 'godot-ai-public.pem', pem.encode())
put(LOCK / 'godot-ai.manifest.json', manifest)
put(LOCK / 'godot-ai.manifest.sig', signature)
# Node's built-in crypto verifies the upstream RSA signature; no dependency installer.
subprocess.run(['node','-e', "const fs=require('fs'),c=require('crypto');if(!c.verify('sha256',fs.readFileSync(process.argv[1]),fs.readFileSync(process.argv[2]),fs.readFileSync(process.argv[3])))process.exit(1)", str(LOCK/'godot-ai.manifest.json'),str(LOCK/'godot-ai-public.pem'),str(LOCK/'godot-ai.manifest.sig')],check=True)
signed = json.loads(manifest)
if signed['source_commit'] != AI_COMMIT or signed['version'] != '4.2.3': raise ValueError('Release identity mismatch')
plugin_zip = fetch(release + signed['asset']['name'])
if len(plugin_zip) != signed['asset']['size'] or hashlib.sha256(plugin_zip).hexdigest() != signed['asset']['sha256']: raise ValueError('Release archive mismatch')
with zipfile.ZipFile(io.BytesIO(plugin_zip)) as z:
    if [i.filename for i in z.infolist()] != [i['path'] for i in signed['inventory']]: raise ValueError('Inventory mismatch')
    for row in signed['inventory']:
        data = z.read(row['path'])
        if len(data) != row['size'] or hashlib.sha256(data).hexdigest() != row['sha256']: raise ValueError('Plugin file mismatch')
extract(plugin_zip, OUT / 'plugin')
unit_zip = fetch(f'https://codeload.github.com/godot-gdunit-labs/gdUnit4/zip/{UNIT_COMMIT}')
extract(unit_zip, OUT / 'gdunit4', f'gdUnit4-{UNIT_COMMIT}/addons/gdUnit4/')
put(OUT / 'gdunit4' / 'UPSTREAM-LICENSE', fetch(f'https://raw.githubusercontent.com/godot-gdunit-labs/gdUnit4/{UNIT_COMMIT}/LICENSE'))
put(LOCK / 'execution-requirements.in', b'godot-ai==4.2.3\n')
req = LOCK / 'execution-requirements.txt'
if not req.exists():
    subprocess.run(['uv','pip','compile',str(LOCK/'execution-requirements.in'),'--python',sys.executable,'--generate-hashes','--only-binary',':all:','-o',str(req)],check=True)
python_dir = OUT / 'python'
shutil.copytree(Path(sys.executable).parent, python_dir, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
subprocess.run(['uv','pip','install','--python',sys.executable,'--target',str(python_dir/'Lib'/'site-packages'),'--require-hashes','--only-binary',':all:','-r',str(req)],check=True)
# Verify wheel implementation against the pinned Git source, not only the version label.
source = fetch(f'https://codeload.github.com/hi-godot/godot-ai/zip/{AI_COMMIT}')
with zipfile.ZipFile(io.BytesIO(source)) as z:
    prefix = f'godot-ai-{AI_COMMIT}/src/godot_ai/'
    for item in z.infolist():
        if item.filename.startswith(prefix) and item.filename.endswith('.py'):
            path = python_dir/'Lib'/'site-packages'/'godot_ai'/item.filename[len(prefix):]
            if path.read_bytes().replace(b'\r\n',b'\n') != z.read(item).replace(b'\r\n',b'\n'): raise ValueError('Backend source mismatch: '+str(path))
inventory=[]
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name != 'manifest.json' and '__pycache__' not in path.parts:
        data=path.read_bytes(); inventory.append({'path':path.relative_to(OUT).as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
put(OUT/'manifest.json',json.dumps({'schemaVersion':1,'platform':'win-x64','godotAI':{'version':'4.2.3','commit':AI_COMMIT,'license':'MIT'},'gdunit4':{'version':'6.2.1','commit':UNIT_COMMIT,'license':'MIT','archiveSha256':hashlib.sha256(unit_zip).hexdigest()},'python':sys.version,'requirementsSha256':hashlib.sha256(req.read_bytes()).hexdigest(),'files':inventory},indent=2).encode())
print('Verified offline execution bundle:',len(inventory),'files')
