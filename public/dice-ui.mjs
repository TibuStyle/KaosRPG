// Módulo local compilado por npm install/build:frontend. Sin workers remotos.
let instance=null,initializing=null,activeRoll=null;
const assetURL=new URL('./vendor/dice-assets/',import.meta.url);
async function diceBox() {
  if(instance) return instance;
  if(!initializing) initializing=(async()=> {
    const {default:DiceBox}=await import('./vendor/dice-box.js');
    const box=new DiceBox('#dice-stage',{
      origin:assetURL.origin,assetPath:assetURL.pathname,theme:'default',scale:5,offscreen:false,
      onRollComplete:results=>activeRoll?.resolve(results)
    });
    await box.init();instance=box;return box;
  })().catch(e=>{initializing=null;throw e;});
  return initializing;
}
function normalize(results,notations) {
  if(!Array.isArray(results)) throw new Error('DiceBox no devolvió resultados individuales.');
  const expected=notations.map(n=>{const [count,sides]=n.split('d').map(Number);return {count,sides};});
  // groupId corresponde al índice de la notación; orden estable, sin sumar por duplicado.
  const sorted=[...results].sort((a,b)=>Number(a.groupId)-Number(b.groupId)||Number(a.rollId)-Number(b.rollId));
  const flat=[];
  for(let group=0;group<expected.length;group++) {
    const values=sorted.filter(r=>Number(r.groupId)===group);
    if(values.length!==expected[group].count) throw new Error('Cantidad de dados renderizados inesperada.');
    for(const r of values) {
      if(Number(r.sides)!==expected[group].sides||!Number.isInteger(r.value)||r.value<1||r.value>Number(r.sides)) throw new Error('Resultado físico inválido.');
      flat.push({caras:Number(r.sides),valor:r.value});
    }
  }
  if(flat.length!==results.length) throw new Error('Dados extra inesperados.');
  return {resultados:flat,total:flat.reduce((sum,r)=>sum+r.valor,0)};
}
export async function rollDice(notations) {
  if(activeRoll) throw new Error('Ya hay una tirada en curso.');
  const box=await diceBox();
  box.clear();
  let timeout;
  const finished=new Promise((resolve,reject)=> {
    activeRoll={resolve,reject};
    timeout=setTimeout(()=>reject(new Error('El motor 3D no terminó. Revisa WebGL, workers y assets.')),60000);
  });
  try {
    // Exactamente el array guardado por servidor, sin modificadores añadidos al motor.
    Promise.resolve(box.roll([...notations])).catch(error=>activeRoll?.reject(error));
    const results=await finished;
    return normalize(results,notations);
  } finally {clearTimeout(timeout);activeRoll=null;}
}
