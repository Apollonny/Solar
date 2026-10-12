import { session } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import type { AssetPack, InstalledPack } from '../../shared/asset-library'
import { extractLibraryArchive } from './asset-archive'

const MAX_DOWNLOAD=768*1024*1024
let nextRequest=0
const decode=(value:string):string=>value.replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
const digest=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex')
async function request(url:string,options: RequestInit={}):Promise<Response> {
  const target=new URL(url)
  if(target.protocol!=='https:' || target.username || target.password)throw new Error('Asset downloads require HTTPS.')
  const response=await session.fromPartition('solar-asset-acquisition').fetch(url,{...options,signal:AbortSignal.timeout(180_000)})
  if(!response.ok)throw new Error(`Publisher download returned HTTP ${response.status}.`)
  return response
}
async function html(url:string):Promise<string> {
  const response=await request(url);const text=await response.text()
  if(text.length>4*1024*1024 || /Just a moment|Performing security verification/i.test(text))throw new Error('The publisher requires browser verification. Use an authorized local archive.')
  return text
}
function uploads(body:string):{id:string;name:string}[] {
  return [...body.matchAll(/<a[^>]*data-upload_id="(\d+)"[^>]*>[\s\S]*?<strong[^>]*class="name"[^>]*>([^<]+)<\/strong>/g)].map(match=>({id:match[1],name:decode(match[2].trim())}))
}
async function post(url:string,token:string,referer:string,upload?:string):Promise<Record<string,unknown>> {
  const response=await request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest',Referer:referer},body:new URLSearchParams({csrf_token:token,...(upload?{upload_id:upload}:{})}).toString()})
  return await response.json() as Record<string,unknown>
}
async function download(url:string,directory:string,fallback:string):Promise<{path:string;name:string;bytes:number;sha256:string}> {
  const response=await request(url)
  const disposition=response.headers.get('content-disposition')??''
  const name=basename(decode(/filename="?([^";\r\n]+)/i.exec(disposition)?.[1]??fallback)).replace(/[<>:"|?*\x00-\x1f]/g,'_')
  if(!name || name==='.' || name==='..')throw new Error('Publisher supplied an invalid filename.')
  const expected=Number(response.headers.get('content-length')??0)
  if(expected>MAX_DOWNLOAD || !response.body)throw new Error('Asset download exceeds the package limit.')
  await mkdir(directory,{recursive:true});const path=join(directory,name),hash=createHash('sha256');let bytes=0
  const counter=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>MAX_DOWNLOAD)return callback(new Error('Asset download size limit exceeded.'));hash.update(chunk);callback(null,chunk)}})
  await pipeline(Readable.fromWeb(response.body as never),counter,createWriteStream(path,{flags:'wx'}))
  if(expected&&expected!==bytes)throw new Error('Asset download was incomplete.')
  return {path,name,bytes,sha256:hash.digest('hex')}
}
export async function acquirePack(pack:AssetPack,staging:string):Promise<Pick<InstalledPack,'archives'|'sourceRevision'>> {
  const archives:InstalledPack['archives']=[]
  if(pack.acquisition==='reference') {
    // Preserve only the scoped tutorial text, no comments, scripts or embedded media.
    const page=await html(pack.url)
    if(!page.includes('Weapon System'))throw new Error('The requested weapon tutorial is no longer available at its source.')
    const text=`# ${pack.title}\n\nSource: ${pack.url}\nAuthor: ${pack.author}\n\n${pack.notes}\n\nSolar integration: keep weapon state, input, ammunition and presentation separate. Adapt interfaces to the existing game instead of replacing the project architecture. Use the linked tutorial for task-specific implementation details. Validate firing, reload and empty-ammunition transitions with scene/regression tests and real input evidence.\n`
    await mkdir(join(staging,'files'),{recursive:true});await writeFile(join(staging,'files/reference.md'),text)
    return {archives,sourceRevision:digest(Buffer.from(page))}
  }
  if(pack.acquisition==='github') {
    if(!pack.repository || !/^[\w-]+\/[\w-]+$/.test(pack.repository))throw new Error('Invalid catalog repository.')
    const commit=await (await request(`https://api.github.com/repos/${pack.repository}/commits/HEAD`,{headers:{Accept:'application/vnd.github+json'}})).json() as {sha?:string}
    if(!commit.sha || !/^[a-f0-9]{40}$/.test(commit.sha))throw new Error('Could not pin the addon source revision.')
    const archive=await download(`https://codeload.github.com/${pack.repository}/zip/${commit.sha}`,join(staging,'archives'),'source.zip')
    await extractLibraryArchive(archive.path,join(staging,'files'));archives.push({name:archive.name,bytes:archive.bytes,sha256:archive.sha256})
    return {archives,sourceRevision:commit.sha}
  }
  const wait=nextRequest-Date.now();if(wait>0)await new Promise(done=>setTimeout(done,wait));nextRequest=Date.now()+20_000
  const page=await html(pack.url), csrf=/csrf_token" value="([^"]+)/.exec(page)?.[1]
  if(!csrf)throw new Error('Publisher download access is unavailable. Import your partner archive locally.')
  const downloadPage=await post(`${pack.url}/download_url`,csrf,pack.url)
  if(typeof downloadPage.url!=='string' || !/^https:\/\/[^/]+\.itch\.io\//.test(downloadPage.url))throw new Error('This edition requires publisher download access. Import the authorized local archive.')
  const body=await html(downloadPage.url), token=/csrf_token" value="([^"]+)/.exec(body)?.[1]??csrf
  const choices=uploads(body).filter(file=>!/(unitypackage|\.exe|\.apk|\.dmg)/i.test(file.name))
  if(!choices.length)throw new Error('The publisher did not expose downloadable asset files.')
  for(const choice of choices.slice(0,8)) {
    const link=await post(`${pack.url}/file/${choice.id}`,token,downloadPage.url)
    if(typeof link.url!=='string')continue // Protected editions need an actual partner link/archive.
    const archive=await download(link.url,join(staging,'archives'),choice.name)
    archives.push({name:archive.name,bytes:archive.bytes,sha256:archive.sha256})
    const bytes=await readFile(archive.path)
    if(bytes.subarray(0,2).toString()==='PK' || bytes.subarray(0,4).toString()==='Rar!') {
      const scope=`upload-${choice.id}`;await extractLibraryArchive(archive.path,join(staging,'files',scope))
    } else if(/\.(txt|md|pdf)$/i.test(archive.name)) {await mkdir(join(staging,'files'),{recursive:true});await writeFile(join(staging,'files',archive.name),bytes,{flag:'wx'})}
  }
  if(!archives.length)throw new Error('No accessible edition was returned. Import the authorized partner archive.')
  return {archives}
}
