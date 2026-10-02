'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {buildDice}=require('../scripts/build-dice.cjs');
// Fixtures sintéticas de topologías: NO son una copia certificada del paquete npm.
function fixture(t,external=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cronicas-dice-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pkg=path.join(root,'package');
  fs.mkdirSync(path.join(pkg,'dist','assets','ammo'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@3d-dice/dice-box',version:'1.1.4'}));
  fs.writeFileSync(path.join(pkg,'dist','assets','ammo','ammo.wasm.wasm'),Buffer.from([0,97,115,109]));
  fs.writeFileSync(path.join(pkg,'LICENSE'),'fixture');
  fs.writeFileSync(path.join(pkg,'dist','dice-box.es.js'),external?'export default {};':'const w = new Worker(URL.createObjectURL(new Blob(["fixture"])));');
  if(external) fs.writeFileSync(path.join(pkg,'dist','physics.worker.js'),'importScripts("fixture");');
  return {projectRoot:root,packageRoot:pkg,esbuildBuild:async options=>fs.writeFileSync(options.outfile,'export default {};')};
}
test('WASM en assets y worker embebido en dist no causa falso incompleto',async t=> {
  const options=fixture(t);const manifest=await buildDice(options);
  assert.equal(manifest.workerFiles.length,0);
  assert.ok(manifest.workerSources.includes('dice-box.es.js'));
  assert.ok(fs.existsSync(path.join(options.projectRoot,'public','vendor','dice-assets','ammo','ammo.wasm.wasm')));
  assert.ok(fs.existsSync(path.join(options.projectRoot,'public','vendor','LICENSE')));
});
test('auxiliares externos de dist se copian al assetPath y al árbol dist',async t=> {
  const options=fixture(t,true);const manifest=await buildDice(options);
  assert.ok(manifest.workerFiles.includes('physics.worker.js'));
  for(const dir of ['dice-assets','dice-box-dist']) assert.ok(fs.existsSync(path.join(options.projectRoot,'public','vendor',dir,'physics.worker.js')));
});
test('rechaza WASM ausente y versión distinta',async t=> {
  const options=fixture(t);fs.rmSync(path.join(options.packageRoot,'dist','assets','ammo','ammo.wasm.wasm'));
  await assert.rejects(buildDice(options),/WASM/);
  fs.writeFileSync(path.join(options.packageRoot,'package.json'),JSON.stringify({name:'@3d-dice/dice-box',version:'1.1.3'}));
  await assert.rejects(buildDice(options),/exactamente 1.1.4/);
});
test('fallo de esbuild conserva artefacto anterior y limpia staging',async t=> {
  const options=fixture(t);const vendor=path.join(options.projectRoot,'public','vendor');
  fs.mkdirSync(vendor,{recursive:true});fs.writeFileSync(path.join(vendor,'dice-box.js'),'ANTERIOR');
  options.esbuildBuild=async()=>{throw new Error('fixture fallo');};
  await assert.rejects(buildDice(options),/fixture fallo/);
  assert.equal(fs.readFileSync(path.join(vendor,'dice-box.js'),'utf8'),'ANTERIOR');
  assert.equal(fs.readdirSync(vendor).some(p=>p.startsWith('.dice-build-')),false);
});
