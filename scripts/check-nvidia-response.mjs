// Explicit, bounded provider diagnosis. Never persist key or response reasoning.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const file = process.argv.find(arg => arg.startsWith('--key-file='))?.slice(11)
if (!file) throw new Error('Provide the authorized local NVIDIA key file.')
const raw = await readFile(resolve(file), 'utf8')
const keys = [...new Set(raw.match(/nvapi-[A-Za-z0-9_-]{16,}/g) ?? [])]
if (keys.length !== 1) throw new Error('Expected exactly one distinct NVIDIA key; contents are not logged.')
const model = 'nvidia/nemotron-3.5-lightning-30b-a3b'
const report = []
for (const budget of [0, 256]) {
  const started = Date.now()
  let status=null
  try {
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${keys[0]}`, 'content-type':'application/json' }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({model, messages:[{role:'user',content:'Return exactly {"ok":true}. No prose.'}], stream:true, max_tokens:768, temperature:0,
      chat_template_kwargs:{enable_thinking:budget>0}, ...(budget ? {reasoning_budget:budget} : {})})
  })
  status=response.status
  if (!response.ok || !response.body) {
    report.push({budget,status:response.status,completed:false}); console.log(JSON.stringify(report.at(-1))); break
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending='', text='', reasoningBytes=0, finish=null, done=false, usage=null, frames=0
  while (true) {
    const part = await reader.read(); if(part.done)break
    pending += decoder.decode(part.value,{stream:true})
    let newline
    while ((newline=pending.indexOf('\n'))>=0) {
      const line=pending.slice(0,newline).trim();pending=pending.slice(newline+1)
      if(!line.startsWith('data:'))continue
      const data=line.slice(5).trim();if(data==='[DONE]'){done=true;continue}
      const frame=JSON.parse(data);frames++;const choice=frame.choices?.[0], delta=choice?.delta??{}
      text+=delta.content??'';reasoningBytes+=Buffer.byteLength(delta.reasoning_content??delta.reasoning??'');finish=choice?.finish_reason??finish;usage=frame.usage??usage
    }
  }
  let jsonValid=false;try{jsonValid=JSON.parse(text).ok===true}catch{}
  report.push({budget,status:response.status,durationMs:Date.now()-started,frames,finish,done,textBytes:Buffer.byteLength(text),reasoningBytes,jsonValid,usage})
  console.log(JSON.stringify(report.at(-1)))
  } catch(error) {
    // Preserve a timeout as failed evidence, without response bodies or secrets.
    report.push({budget,status,durationMs:Date.now()-started,completed:false,error:error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'transport_error'})
    console.log(JSON.stringify(report.at(-1)))
  }
}
await mkdir('.test-dist/acceptance',{recursive:true})
await writeFile('.test-dist/acceptance/nvidia-response.json',JSON.stringify({model,report},null,2))
if(report.length!==2||report.some(result=>!result.jsonValid||result.finish!=='stop'||!result.done))process.exitCode=1
