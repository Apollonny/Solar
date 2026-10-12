import test from 'node:test'
import { strict as assert } from 'node:assert'
import { crc32, zipContents } from '../src/main/services/asset-archive'
import { assetFilePurpose, safeLibraryPath, rankAssetPacks, ASSET_BYTE_PREFIX } from '../src/shared/asset-library'
import type { LibraryEntry } from '../src/shared/asset-library'
import { validateChangeSet } from '../src/shared/production-changes'

function zip(items:{path:string;data:Buffer}[]):Buffer {
  const parts:Buffer[]=[],directory:Buffer[]=[];let offset=0
  for(const item of items) {
    const name=Buffer.from(item.path),local=Buffer.alloc(30),central=Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc32(item.data),14);local.writeUInt32LE(item.data.length,18);local.writeUInt32LE(item.data.length,22);local.writeUInt16LE(name.length,26)
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt32LE(crc32(item.data),16);central.writeUInt32LE(item.data.length,20);central.writeUInt32LE(item.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42)
    parts.push(local,name,item.data);directory.push(central,name);offset+=local.length+name.length+item.data.length
  }
  const end=Buffer.alloc(22),entries=Buffer.concat(directory)
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(entries.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...parts,entries,end])
}
test('archives keep original binary bytes and reject traversal, duplicates and corruption',()=>{
  const payload=Buffer.from([0,255,128,1,2]),normal=zip([{path:'textures/a.png',data:payload},{path:'tool.exe',data:Buffer.from('blocked')}])
  assert.deepEqual(zipContents(normal),[{path:'textures/a.png',data:payload}])
  assert.throws(()=>zipContents(zip([{path:'../outside.png',data:payload}])),/unsafe/)
  assert.throws(()=>zipContents(zip([{path:'a.png',data:payload},{path:'A.png',data:payload}])),/duplicate/)
  const broken=Buffer.from(normal);broken[30+'textures/a.png'.length]^=1;assert.throws(()=>zipContents(broken),/integrity/)
  for(const name of ['C:/escape','a\\b','NUL.gd','a/../b','a/CON/asset.png'])assert.equal(safeLibraryPath(name),false)
})
test('selection filters dimension and style and translates task keywords',()=>{
  assert.equal(assetFilePurpose('upload/guides/frame-timing.png'),'reference')
  assert.equal(assetFilePurpose('upload/color ramps and v00.png'),'palette')
  assert.equal(assetFilePurpose('upload/char/char_0bas_humn.png'),'runtime')
  const base:Omit<LibraryEntry,'id'|'title'|'dimension'|'tags'>={author:'Author',url:'https://example.com',kind:'environment',style:'stylized',formats:['glb'],license:'Partner',notes:'',acquisition:'itch',status:'ready',fileCount:1,bytes:1}
  const entries:LibraryEntry[]=[{...base,id:'forest',title:'Nature',dimension:'3d',tags:['forest','tree']},{...base,id:'pixel',title:'Pixel Trees',dimension:'2d',style:'pixel',tags:['tree']},{...base,id:'real',title:'Realistic Trees',dimension:'3d',style:'realistic',tags:['tree']}]
  assert.equal(rankAssetPacks(entries,{query:'orman ağaç 3d',style:'stylized'})[0].pack.id,'forest')
  assert.deepEqual(rankAssetPacks(entries,{query:'tree',dimension:'2d',style:'pixel'}).map(match=>match.pack.id),['pixel'])
  assert.equal(rankAssetPacks(entries,{query:'unrelated'}).length,0)
})
test('models cannot forge host-only byte commands or guess asset hashes',()=>{
  const revision='a'.repeat(64),identity={runId:'a'.repeat(36),storyId:'b'.repeat(36),taskRevision:1,stageId:'0:developing',eventSeq:1}
  const candidate={schemaVersion:1,projectRevision:revision,summary:'Import',files:[{path:'assets/library/forest/a.png',expectedHash:null}],commands:[{tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://assets/library/forest/a.png',content:ASSET_BYTE_PREFIX+'{}'}}}]}
  assert.throws(()=>validateChangeSet(candidate,revision,identity),/reserved|byte|host/i)
  assert.throws(()=>validateChangeSet({...candidate,commands:[{tool:'filesystem_manage',args:{op:'scan',params:{}}}],assetImports:[{packId:'forest',files:[{path:'a.png',sha256:'guess'}]}]},revision,identity),/asset|hash/i)
})
