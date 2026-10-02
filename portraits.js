'use strict';
const BASE='https://image.pollinations.ai/prompt/';
function portraitPrompt(room,description) {
  const tone={epic:'epic fantasy',dark:'dark fantasy',comic:'whimsical fantasy'}[room.adventure_tone];
  const magic={high:'high magic world',low:'low magic world',none:'non-magical world'}[room.magic_level];
  const mortality={story:'story-driven atmosphere',relentless:'grim atmosphere'}[room.mortality];
  if(!tone||!magic||!mortality||typeof description!=='string'||description.length>1000) throw new Error('Retrato inválido.');
  // Estructura pedida: prefijo fijo, tono/reglas del mundo, descripción estética en inglés.
  return `detailed pixel art character portrait, 2d game art, no weapons, ${tone} ${magic} ${mortality}, ${description.trim()||'fantasy traveler in simple clothing'}`;
}
async function createPortrait(room,description,{fetcher=fetch,signal,enabled=process.env.POLLINATIONS_ENABLED!=='false'}={}) {
  if(!enabled)return {url:null,status:'disabled'};
  const url=BASE+encodeURIComponent(portraitPrompt(room,description));
  const timeout=AbortSignal.timeout(12000);
  try {
    const response=await fetcher(url,{signal:signal?AbortSignal.any([signal,timeout]):timeout,
      redirect:'error',headers:{Accept:'image/*'}});
    if(!response.ok||!/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers.get('content-type')||'')) throw new Error('Imagen no disponible.');
    if(Number(response.headers.get('content-length')||0)>8*1024*1024) throw new Error('Imagen demasiado grande.');
    let size=0;const reader=response.body.getReader();
    try {for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>8*1024*1024)throw new Error('Imagen demasiado grande.');}}
    finally {await reader.cancel().catch(()=>{});}
    if(!size) throw new Error('Imagen vacía.');
    return {url,status:'ready'};
  } catch {return {url:null,status:signal?.aborted?'cancelled':'unavailable'};}
}
module.exports={BASE,portraitPrompt,createPortrait};

