'use strict';
// No CDN para workers/WASM/modelos: misma procedencia, rutas relativas a Pages.
const fs=require('node:fs');
const path=require('node:path');
const {build}=require('esbuild');
const root=path.resolve(__dirname,'..');
async function main() {
  let current=path.dirname(require.resolve('@3d-dice/dice-box'));
  while(!fs.existsSync(path.join(current,'package.json'))) {
    const parent=path.dirname(current);
    if(parent===current) throw new Error('No se encontró el paquete dice-box.');
    current=parent;
  }
  const assets=path.join(current,'dist','assets');
  if(!fs.existsSync(assets)) throw new Error('dice-box no incluye dist/assets; revisa la versión instalada.');
  const dest=path.join(root,'public','vendor');
  fs.mkdirSync(dest,{recursive:true});
  fs.rmSync(path.join(dest,'dice-assets'),{recursive:true,force:true});
  fs.cpSync(assets,path.join(dest,'dice-assets'),{recursive:true});
  // Copiar todos los auxiliares distribuidos y licencias, sin cambiar su estructura.
  fs.cpSync(path.join(current,'dist'),path.join(dest,'dice-box-dist'),{recursive:true});
  for(const file of fs.readdirSync(current).filter(n=>/^licen[cs]e/i.test(n))) {
    if(fs.statSync(path.join(current,file)).isFile()) fs.copyFileSync(path.join(current,file),path.join(dest,file));
  }
  await build({stdin:{contents:"export {default} from '@3d-dice/dice-box';",resolveDir:root},
    outfile:path.join(dest,'dice-box.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',
    legalComments:'linked'});
  const files=[];
  function walk(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
    const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files.push(path.relative(dest,p));
  }}
  walk(path.join(dest,'dice-assets'));
  if(!files.some(n=>/worker/i.test(n))||!files.some(n=>/\.wasm$/i.test(n))) throw new Error('Distribución incompleta: faltan workers o WASM.');
  fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({package:'@3d-dice/dice-box',version:'1.1.4',assets:files},null,2));
  console.log('DiceBox compilado; assets, workers y WASM locales: '+files.length+' archivos.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
