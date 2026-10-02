// Solo usado por integration.test.js. No existe bypass de aprobación en producción.
'use strict';
const Module = require('node:module');
const original = Module._load;
let resolutionFailed=false;
Module._load = function(name,...args) {
  if(name==='openai') return class MockOpenAI {
    constructor() {
      this.chat={completions:{create:async params=> {
        await new Promise(resolve=>setTimeout(resolve,40));
        const data=JSON.parse(params.messages[1].content);
        if(data.tirada && !resolutionFailed) {resolutionFailed=true;throw new Error('Fallo de resolución mock');}
        const value=data.personaje
          ? {aprobado:true,mensaje_narrativo:'Bienvenido.',perks:[{nombre:'SECRETO_RASGO',tipo:'ventaja'}],defectos:[]}
          : data.tirada ? {narrativa:'La consecuencia final respeta la tirada.'}
          : data.accion==='ARRIESGADA' ? {requiere_dado:true,narrativa_previa:'Preparas el salto.',dados_a_lanzar:['1d20','2d6'],cd_base:15,
              modificadores:[{nombre:'SECRETO_RASGO',valor:3,tipo:'ventaja'}]}
          : {requiere_dado:false,narrativa_previa:'La puerta se abre ante el grupo.',dados_a_lanzar:[],cd_base:0,modificadores:[]};
        return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]};
      }}};
    }
  };
  return original.call(this,name,...args);
};
require('../server');
