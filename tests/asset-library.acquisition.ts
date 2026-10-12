import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assetCatalog, installAssetPack, listAssetLibrary } from '../src/main/services/asset-library'
app.setName('Solar');app.getAppPath=()=>process.env.SOLAR_ACCEPTANCE_ROOT!
app.on('window-all-closed',()=>{})
void app.whenReady().then(async()=>{
  const report:{id:string;status:string;files?:number;error?:string}[]=[]
  for(const pack of await assetCatalog()) {
    console.log('Acquiring:',pack.id)
    try {const result=await installAssetPack(pack.id);report.push({id:pack.id,status:result.status,files:result.fileCount});console.log('Cached:',pack.id,result.fileCount)}
    catch(error){report.push({id:pack.id,status:'unavailable',error:(error as Error).message});console.log('Access unavailable:',pack.id,(error as Error).message)}
    await mkdir('.test-dist/acceptance',{recursive:true});await writeFile('.test-dist/acceptance/asset-library-acquisition.json',JSON.stringify({report,library:await listAssetLibrary()},null,2))
  }
}).catch(error=>{console.error((error as Error).message);process.exitCode=1}).finally(()=>app.exit(Number(process.exitCode??0)))
