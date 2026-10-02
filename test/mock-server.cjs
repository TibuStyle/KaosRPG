// Solo usado por integration.test.js. No existe bypass de aprobación en producción.
'use strict';
const Module = require('node:module');
const original = Module._load;
Module._load = function(name,...args) {
  if(name==='openai') return class MockOpenAI {
    constructor() {
      this.chat={completions:{create:async params=> {
        await new Promise(resolve=>setTimeout(resolve,40));
        const data=JSON.parse(params.messages[1].content);
        const value=data.personaje
          ? {aprobado:true,mensaje_narrativo:'Bienvenido.',perks:[{nombre:'SECRETO_RASGO',tipo:'ventaja'}],defectos:[]}
          : {narrativa:'La puerta se abre ante el grupo.'};
        return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]};
      }}};
    }
  };
  return original.call(this,name,...args);
};
require('../server');
