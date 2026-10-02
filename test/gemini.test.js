'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateJSON,toGeminiSchema}=require('../gemini');
const {APPROVAL_SCHEMA,MASTER_PROMPT,validateDecision}=require('../approval');
const {EVALUATION_SCHEMA,RESOLUTION_SCHEMA,validateEvaluation}=require('../mechanics');
function fake(text='{"narrativa":"Hecho."}',finishReason='STOP') {
  const calls=[];
  return {calls,getGenerativeModel(config) {
    calls.push(config);
    return {async generateContent(request,options) {
      calls.push(request,options);
      return {response:{candidates:[{finishReason}],text:()=>text}};
    }};
  }};
}
test('convierte todos los esquemas sin additionalProperties y preserva claves requeridas',()=> {
  for(const schema of [APPROVAL_SCHEMA,EVALUATION_SCHEMA,RESOLUTION_SCHEMA]) {
    const converted=toGeminiSchema(schema);
    assert.equal(converted.type,'OBJECT');
    assert.deepEqual(converted.required,schema.required);
    assert.equal(JSON.stringify(converted).includes('additionalProperties'),false);
  }
  assert.deepEqual(Object.keys(toGeminiSchema(EVALUATION_SCHEMA).properties),
    ['requiere_dado','narrativa_previa','dados_a_lanzar','cd_base','modificadores']);
});
test('preserva prompt, datos y presupuesto de tokens en cada llamada',async()=> {
  for(const [schema,tokens] of [[APPROVAL_SCHEMA,1800],[EVALUATION_SCHEMA,2600],[RESOLUTION_SCHEMA,2200]]) {
    const ai=fake();const data={rasgos_ocultos:[{kind:'ventaja',name:'Privado'}]};
    await generateJSON(ai,'gemini-1.5-flash',MASTER_PROMPT,data,new AbortController(),tokens,schema);
    assert.equal(ai.calls[0].systemInstruction,MASTER_PROMPT);
    assert.equal(ai.calls[0].model,'gemini-1.5-flash');
    assert.equal(ai.calls[0].generationConfig.maxOutputTokens,tokens);
    assert.equal(ai.calls[0].generationConfig.temperature,0.2);
    assert.equal(ai.calls[0].generationConfig.responseMimeType,'application/json');
    assert.deepEqual(JSON.parse(ai.calls[1].contents[0].parts[0].text),data);
    assert.deepEqual(ai.calls[2],{timeout:45000});
  }
});
test('rechaza truncado, bloqueo, markdown y JSON malformado',async()=> {
  for(const [body,reason] of [['{}','MAX_TOKENS'],['{}','SAFETY'],['```json\n{}\n```','STOP'],['{','STOP']]) {
    await assert.rejects(generateJSON(fake(body,reason),'gemini-1.5-flash','prompt',{},new AbortController(),1800,APPROVAL_SCHEMA));
  }
});
test('cancelación antes y durante llamada impide aceptar salida tardía',async()=> {
  const controller=new AbortController();controller.abort();
  await assert.rejects(generateJSON(fake(),'gemini-1.5-flash','prompt',{},controller,1800,APPROVAL_SCHEMA),/cancelada/);
  const pending=new AbortController();
  const ai={getGenerativeModel:()=>({generateContent:()=>new Promise(()=>{})})};
  const result=generateJSON(ai,'gemini-1.5-flash','prompt',{},pending,1800,APPROVAL_SCHEMA);
  pending.abort();await assert.rejects(result,/cancelada/);
});
test('validación local rechaza campos adicionales y rasgos inventados',()=> {
  assert.throws(()=>validateDecision({aprobado:true,mensaje_narrativo:'Sí',perks:[],defectos:[],extra:1}));
  assert.throws(()=>validateEvaluation({requiere_dado:true,narrativa_previa:'Preparas salto',dados_a_lanzar:['1d20'],cd_base:15,
    modificadores:[{nombre:'Inventado',tipo:'ventaja',valor:3}]},[]));
});
