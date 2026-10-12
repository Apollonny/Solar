import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { safeLibraryPath } from '../../shared/asset-library'

const execute = promisify(execFile)
const MAX_FILE = 256 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024
const CRC_TABLE = Uint32Array.from({length:256}, (_,value) => {
  let crc=value; for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0); return crc>>>0
})
export function crc32(data: Buffer): number { let crc=0xffffffff; for(const byte of data)crc=(crc>>>8)^CRC_TABLE[(crc^byte)&255]; return (crc^0xffffffff)>>>0 }
const keep = (path: string): boolean => !path.split('/').some(part => part.startsWith('.') || part==='__MACOSX') && !/\.(exe|dll|node|bat|cmd|ps1|sh|py|pyd|so|dylib|unitypackage)$/i.test(path)
/** Parse the central directory before creating any output; no ZIP path is trusted. */
export function zipContents(zip: Buffer): { path: string; data: Buffer }[] {
  let end=-1
  for(let cursor=zip.length-22;cursor>=Math.max(0,zip.length-65557);cursor--) {
    if(zip.readUInt32LE(cursor)===0x06054b50 && cursor+22+zip.readUInt16LE(cursor+20)===zip.length){end=cursor;break}
  }
  if(end<0 || zip.readUInt16LE(end+4)!==0 || zip.readUInt16LE(end+6)!==0)throw new Error('Unsupported or incomplete ZIP archive.')
  const count=zip.readUInt16LE(end+10), directorySize=zip.readUInt32LE(end+12), directoryOffset=zip.readUInt32LE(end+16)
  if(count>30000 || count===65535 || directoryOffset+directorySize>end)throw new Error('Archive bounds or ZIP64 are unsupported.')
  let cursor=directoryOffset,total=0;const files:{path:string;data:Buffer}[]=[], seen=new Set<string>()
  for(let entry=0;entry<count;entry++) {
    if(cursor+46>directoryOffset+directorySize || zip.readUInt32LE(cursor)!==0x02014b50)throw new Error('Malformed ZIP directory.')
    const flags=zip.readUInt16LE(cursor+8),method=zip.readUInt16LE(cursor+10),crc=zip.readUInt32LE(cursor+16)
    const compressed=zip.readUInt32LE(cursor+20),size=zip.readUInt32LE(cursor+24),nameLength=zip.readUInt16LE(cursor+28),extraLength=zip.readUInt16LE(cursor+30),commentLength=zip.readUInt16LE(cursor+32),offset=zip.readUInt32LE(cursor+42)
    const path=zip.subarray(cursor+46,cursor+46+nameLength).toString('utf8').replaceAll('\\','/'), mode=(zip.readUInt32LE(cursor+38)>>>16)&0xf000
    cursor+=46+nameLength+extraLength+commentLength
    const clean=path.endsWith('/')?path.slice(0,-1):path
    if(cursor>directoryOffset+directorySize || !safeLibraryPath(clean) || flags&1 || mode===0xa000 || mode&&![0x4000,0x8000].includes(mode))throw new Error('Archive contains an unsafe path, link or encrypted file.')
    if(path.endsWith('/'))continue
    if(seen.has(clean.toLowerCase()))throw new Error('Archive contains duplicate portable file paths.')
    seen.add(clean.toLowerCase());total+=size
    if(size>MAX_FILE || total>MAX_TOTAL || ![0,8].includes(method) || offset+30>directoryOffset || zip.readUInt32LE(offset)!==0x04034b50)throw new Error('Unsupported archive entry or expansion limit.')
    const start=offset+30+zip.readUInt16LE(offset+26)+zip.readUInt16LE(offset+28)
    if(start+compressed>directoryOffset)throw new Error('Truncated archive data.')
    if(!keep(clean))continue
    const data=method===0?zip.subarray(start,start+compressed):inflateRawSync(zip.subarray(start,start+compressed),{maxOutputLength:Math.max(1,size)})
    if(data.length!==size || crc32(data)!==crc)throw new Error('Archive file integrity check failed.')
    files.push({path:clean,data})
  }
  return files
}
export async function extractLibraryArchive(archive: string, destination: string): Promise<void> {
  const bytes=await readFile(archive)
  let files:{path:string;data:Buffer}[]
  if(bytes.subarray(0,2).toString()==='PK') files=zipContents(bytes)
  else if(bytes.subarray(0,4).toString()==='Rar!') {
    // Stream each regular member to stdout; tar never writes archive paths or links.
    const listing=await execute('tar',['-tvf',archive],{windowsHide:true,maxBuffer:4*1024*1024})
    if(listing.stdout.split(/\r?\n/).filter(Boolean).some(line=>!/^[-d]/.test(line)))throw new Error('RAR links/special members are unsupported.')
    const names=await execute('tar',['-tf',archive],{windowsHide:true,maxBuffer:4*1024*1024})
    const paths=names.stdout.split(/\r?\n/).filter(Boolean).map(path=>path.replaceAll('\\','/'))
    if(paths.length>30000 || paths.some(path=>!safeLibraryPath(path.replace(/\/$/,''))))throw new Error('Unsafe RAR file path.')
    const regular=paths.filter(path=>!path.endsWith('/'))
    if(new Set(regular.map(path=>path.toLowerCase())).size!==regular.length)throw new Error('Archive contains duplicate portable file paths.')
    files=[];let total=0
    for(const path of paths.filter(path=>!path.endsWith('/')&&keep(path))) {
      const output=await execute('tar',['-xOf',archive,path],{windowsHide:true,encoding:'buffer',maxBuffer:MAX_FILE})
      total+=output.stdout.length;if(total>MAX_TOTAL)throw new Error('RAR expansion limit exceeded.')
      files.push({path,data:output.stdout})
    }
  } else throw new Error('Only ZIP or RAR asset archives are supported.')
  if(!files.length)throw new Error('No usable files were found in the archive.')
  for(const file of files) { const target=join(destination,file.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,file.data,{flag:'wx'}) }
}
