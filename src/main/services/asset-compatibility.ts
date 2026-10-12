/** Preserve sampling semantics while avoiding Godot 4.7's builtin-sampler
 * forwarding error. Only the curated Nojoule canvas helper call is specialized;
 * custom sampler functions and the immutable publisher cache remain unchanged. */
export function adaptLibraryShader(packId:string,path:string,text:string):string {
  if(packId!=='nojoule-pixel-shaders'||!path.endsWith('.gdshaderinc'))return text
  return text.replace(/sample_5x5_grid\(\s*TEXTURE\s*,\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*;/g,(_all,center:string,offset:string,pixels:string)=>{
    const samples=Array.from({length:25},(_,i)=>`${pixels}[${i}] = texelFetch(TEXTURE, ivec2(${center} + vec2(${offset}.x * ${(i%5-2).toFixed(1)}, ${offset}.y * ${(Math.floor(i/5)-2).toFixed(1)})), 0);`)
    return '// Solar: sample builtin canvas TEXTURE directly; preserve the 5x5 pixel grid.\n'+samples.join('\n\t')
  })
}
