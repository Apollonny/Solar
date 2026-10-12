"""Parse bounded original JUnit reports using the standard library."""
import json, sys, xml.etree.ElementTree as ET
from pathlib import Path
root=Path(sys.argv[1]).resolve()
files=sorted(root.rglob('*.xml'))
result={'discovered':0,'executed':0,'failed':0,'skipped':0,'cases':[], 'reports':[], 'scopeMatched':False}
seen=set()
for file in files:
    data=file.read_bytes()
    if len(data)>4*1024*1024 or b'<!DOCTYPE' in data or file.is_symlink(): raise ValueError('Invalid JUnit report')
    tree=ET.fromstring(data)
    if tree.tag not in ('testsuites','testsuite'): continue
    cases=list(tree.iter('testcase'))
    # The source report must declare the same test count as its actual cases.
    suites=[tree] if tree.tag=='testsuite' else list(tree.findall('testsuite'))
    if sum(int(s.attrib.get('tests','-1')) for s in suites)!=len(cases): raise ValueError('JUnit count mismatch')
    if int(tree.attrib.get('tests','-1')) != len(cases): raise ValueError('JUnit root count mismatch')
    for suite in suites:
        path=(suite.attrib.get('package','').rstrip('/')+'/'+suite.attrib.get('name','')+'.gd').lstrip('/')
        for case in suite.findall('testcase'):
            name=case.attrib.get('name','')
            key=path+'::'+name
            if not name or key in seen: raise ValueError('Duplicate/unnamed JUnit test')
            seen.add(key)
            skipped=case.find('skipped') is not None
            failed=case.find('failure') is not None or case.find('error') is not None
            result['discovered']+=1
            result['executed']+=int(not skipped)
            result['failed']+=int(failed)
            result['skipped']+=int(skipped)
            result['cases'].append({'path':path,'name':name,'skipped':skipped,'failed':failed})
        # A suite setup/teardown error may not belong to any individual case.
        if int(suite.attrib.get('errors','0')) or int(suite.attrib.get('failures','0')):
            result['failed']=max(result['failed'],1)
    result['reports'].append({'path':file.relative_to(root).as_posix(),'raw':data.decode('utf-8')})
if len(sys.argv)>2:
    discovery=Path(sys.argv[2])
    if discovery.is_symlink() or discovery.stat().st_size>1024*1024: raise ValueError('Invalid discovery')
    expected=json.loads(discovery.read_text(encoding='utf-8'))
    selected=expected['selected']
    keys=[case['path']+'::'+case['name'] for case in expected['cases']]
    result['scopeMatched']=bool(keys) and len(set(keys))==len(keys) and set(keys)==seen and all(any(case['path']==path for case in expected['cases']) for path in selected)
    result['discovered']=len(keys)
print(json.dumps(result,ensure_ascii=False))
