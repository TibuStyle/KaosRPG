// Solo usado por integration.test.js. No existe bypass de aprobación en producción.
'use strict';
const Module = require('node:module');
const original = Module._load;
let resolutionFailed=false;
Module._load = function(name,...args) {
  if(name==='@google/generative-ai') return {GoogleGenerativeAI:class MockGemini {
    getGenerativeModel(config) {
      if(config.generationConfig.responseMimeType!=='application/json' || !config.generationConfig.responseSchema) throw new Error('Falta contrato JSON');
      return {generateContent:async params=> {
        await new Promise(resolve=>setTimeout(resolve,40));
        const data=JSON.parse(params.contents[0].parts[0].text);
        if(data.tirada && !resolutionFailed) {resolutionFailed=true;throw new Error('Fallo de resolución mock');}
        const value=data.personaje
          ? {aprobado:true,mensaje_narrativo:'Bienvenido.',perks:[{nombre:'SECRETO_RASGO',tipo:'ventaja'}],defectos:[]}
          : data.tirada ? {narrativa:'La consecuencia final respeta la tirada.'}
          : data.accion==='ARRIESGADA' ? {requiere_dado:true,narrativa_previa:'Preparas el salto.',dados_a_lanzar:['1d20','2d6'],cd_base:15,
              modificadores:[{nombre:'SECRETO_RASGO',valor:3,tipo:'ventaja'}]}
          : {requiere_dado:false,narrativa_previa:'La puerta se abre ante el grupo.',dados_a_lanzar:[],cd_base:0,modificadores:[]};
        return {response:{candidates:[{finishReason:'STOP'}],text:()=>JSON.stringify(value)}};
      }};
    }
  }};
  return original.call(this,name,...args);
};
require('../server');
