'use strict';
// Sin CDN: dist/assets mantiene sus rutas, y dist conserva los auxiliares de JS.
const fs=require('node:fs');
const path=require('node:path');
function locatePackage() {
  let current=path.dirname(require.resolve('@3d-dice/dice-box'));
  while(true) {
    const file=path.join(current,'package.json');
    if(fs.existsSync(file) && JSON.parse(fs.readFileSync(file,'utf8')).name==='@3d-dice/dice-box') return current;
    const parent=path.dirname(current);
    if(parent===current) throw new Error('No se encontró el paquete dice-box.');
    current=parent;
  }
}
function walk(dir) {
  const files=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const p=path.join(dir,entry.name);
    if(entry.isDirectory()) files.push(...walk(p)); else if(entry.isFile()) files.push(p);
  }
  return files;
}
async function buildDice(options={}) {
  const root=options.projectRoot || path.resolve(__dirname,'..');
  const current=options.packageRoot || locatePackage();
  const metadata=JSON.parse(fs.readFileSync(path.join(current,'package.json'),'utf8'));
  if(metadata.name!=='@3d-dice/dice-box' || metadata.version!=='1.1.4')
    throw new Error('Se requiere @3d-dice/dice-box exactamente 1.1.4.');
  const dist=path.join(current,'dist');
  const assets=path.join(dist,'assets');
  if(!fs.existsSync(assets) || !fs.statSync(assets).isDirectory())
    throw new Error('Falta @3d-dice/dice-box/dist/assets.');
  const sourceFiles=walk(dist);
  const wasm=sourceFiles.filter(p=>/\.wasm$/i.test(p));
  if(!wasm.length || wasm.some(p=>fs.statSync(p).size===0))
    throw new Error('Distribución incompleta: falta WASM no vacío en dist.');
  // Un Worker puede estar embebido en el bundle (Blob); su nombre no es un contrato.
  const workerFiles=sourceFiles.filter(p=>/worker/i.test(path.basename(p)) && /\.(?:m?js)$/i.test(p));
  const inlineWorkerSources=sourceFiles.filter(p=>/\.(?:m?js)$/i.test(p) &&
    /\b(?:new\s+(?:(?:globalThis|window|self)\.)?Worker\s*\(|Worker\s*\(|importScripts\s*\()/m.test(fs.readFileSync(p,'utf8')));
  if(!workerFiles.length && !inlineWorkerSources.length)
    throw new Error('No se detectó soporte Worker en el JavaScript de dist; revisar paquete instalado.');
  const vendor=path.join(root,'public','vendor');
  fs.mkdirSync(vendor,{recursive:true});
  // Construir en staging; un fallo no elimina el build anterior válido.
  const staging=fs.mkdtempSync(path.join(vendor,'.dice-build-'));
  try {
    const assetDest=path.join(staging,'dice-assets');
    fs.cpSync(assets,assetDest,{recursive:true});
    fs.cpSync(dist,path.join(staging,'dice-box-dist'),{recursive:true});
    // Mantener tanto dist/assets aplanado como dist completo para auxiliares relativos.
    // No filtrar por nombres supuestos de workers, ammo o hashes de compilación.
    for(const entry of fs.readdirSync(dist,{withFileTypes:true})) {
      if(entry.name==='assets') continue;
      const target=path.join(assetDest,entry.name);
      if(fs.existsSync(target)) throw new Error('Colisión de auxiliar: '+entry.name);
      fs.cpSync(path.join(dist,entry.name),target,{recursive:true});
    }
    const licenses=[];
    for(const file of fs.readdirSync(current).filter(n=>/^licen[cs]e/i.test(n))) {
      if(fs.statSync(path.join(current,file)).isFile()) {
        fs.copyFileSync(path.join(current,file),path.join(staging,file));licenses.push(file);
      }
    }
    const build=options.esbuildBuild || require('esbuild').build;
    await build({stdin:{contents:"export {default} from '@3d-dice/dice-box';",resolveDir:root},
      outfile:path.join(staging,'dice-box.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'linked'});
    const relative=p=>path.relative(dist,p).split(path.sep).join('/');
    const manifest={package:metadata.name,version:metadata.version,
      assets:walk(assetDest).map(p=>path.relative(staging,p).split(path.sep).join('/')).sort(),
      wasm:wasm.map(relative),workerFiles:workerFiles.map(relative),
      workerSources:inlineWorkerSources.map(relative),
      note:'Worker puede estar embebido. Detección estática, no prueba de ejecución WebGL.'};
    fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    for(const name of ['dice-assets','dice-box-dist','dice-box.js','dice-box.js.LEGAL.txt','manifest.json',...licenses]) {
      fs.rmSync(path.join(vendor,name),{recursive:true,force:true});
      const file=path.join(staging,name);
      if(fs.existsSync(file)) fs.renameSync(file,path.join(vendor,name));
    }
    console.log('DiceBox 1.1.4: '+manifest.assets.length+' assets locales; Worker verificado estáticamente.');
    return manifest;
  } finally {fs.rmSync(staging,{recursive:true,force:true});}
}
if(require.main===module) buildDice().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={buildDice};

