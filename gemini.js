'use strict';
// Gemini admite un subconjunto OpenAPI; additionalProperties se comprueba localmente.
function toGeminiSchema(schema) {
  if(!schema || typeof schema!=='object') throw new Error('Falta esquema de salida IA.');
  const out={};
  if(schema.type) out.type=schema.type.toUpperCase();
  for(const key of ['description','enum','required','nullable']) {
    if(Object.hasOwn(schema,key)) out[key]=schema[key];
  }
  if(schema.properties) out.properties=Object.fromEntries(
    Object.entries(schema.properties).map(([k,v])=>[k,toGeminiSchema(v)]));
  if(schema.items) out.items=toGeminiSchema(schema.items);
  return out;
}
async function generateJSON(ai,modelName,prompt,data,controller,maxTokens,schema) {
  const signal=controller.signal;
  if(signal.aborted) throw new Error('Evaluación cancelada.');
  const model=ai.getGenerativeModel({
    model:modelName,systemInstruction:prompt,
    generationConfig:{temperature:0.2,maxOutputTokens:maxTokens,
      responseMimeType:'application/json',responseSchema:toGeminiSchema(schema)}
  });
  let timer,abort;
  // Timeout HTTP del SDK + cancelación lógica: jamás aplicar una respuesta tardía.
  // No se promete que cancelar un trabajo anule la facturación en el proveedor.
  const interrupted=new Promise((_,reject)=> {
    abort=()=>reject(new Error('Evaluación cancelada.'));
    signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>reject(new Error('Tiempo de IA agotado.')),45000);
  });
  try {
    const result=await Promise.race([
      model.generateContent({contents:[{role:'user',parts:[{text:JSON.stringify(data)}]}]},
        {timeout:45000}),interrupted
    ]);
    if(signal.aborted) throw new Error('Evaluación cancelada.');
    const response=result?.response;
    const candidates=response?.candidates;
    if(response?.promptFeedback?.blockReason || !Array.isArray(candidates) ||
      candidates.length!==1 || candidates[0].finishReason!=='STOP') throw new Error('Salida IA inválida.');
    const content=response.text();
    if(typeof content!=='string' || !content.trim() || content.length>16000) throw new Error('Salida IA inválida.');
    // No extraer markdown ni reparar respuestas truncadas: fallar y permitir retry durable.
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);signal.removeEventListener('abort',abort);
  }
}
module.exports={toGeminiSchema,generateJSON};
