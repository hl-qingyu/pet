const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { ConfigStore,validate,migrate }=require('../src/config.cjs');
const { History }=require('../src/history.cjs');
const defaults=require('../config.example.json');
const scratch=path.resolve(__dirname,'../work/tests');fs.mkdirSync(scratch,{recursive:true});
function folder(t){const dir=fs.mkdtempSync(path.join(scratch,'case-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('invalid external configuration does not overwrite last valid state',t=>{
  const file=path.join(folder(t),'config.json');const store=new ConfigStore(file,path.resolve(__dirname,'../config.example.json'));
  const invalid=structuredClone(store.value);invalid.pet.scale=-1;assert.throws(()=>store.save(invalid),/宠物大小/);
  assert.equal(JSON.parse(fs.readFileSync(file)).pet.scale,defaults.pet.scale);assert.equal(store.value.pet.scale,defaults.pet.scale);
});
test('remote credentials require TLS; extraBody cannot replace message or tool boundaries',()=>{
  const config=structuredClone(defaults);config.providers.custom.baseUrl='http://remote.test/v1';assert.throws(()=>validate(config),/HTTPS/);
  config.providers.custom.baseUrl='http://127.0.0.1:1234/v1';validate(config);
  config.providers.custom.extraBody={tools:[{}]};assert.throws(()=>validate(config),/tools/);
});
test('history only commits complete turns and respects persistence switch',t=>{
  const file=path.join(folder(t),'history.json');const history=new History(file);history.append('hello','reply',false);assert.equal(fs.existsSync(file),false);
  history.append('next','answer',true);assert.equal(new History(file).messages.length,4);
  assert.deepEqual(history.context(3).map(m=>m.role),['user','assistant']);history.clear();assert.deepEqual(new History(file).messages,[]);
});
test('config is stored in the requested directory and roundtrips UTF-8',t=>{
  const dir=folder(t),file=path.join(dir,'配置.json');const store=new ConfigStore(file,path.resolve(__dirname,'../config.example.json'));
  const next=structuredClone(store.value);next.characters.dragon.name='龙龙🦋';next.characters.whale.name='鲸鲸🐋';next.startup.enabled=true;store.save(next);
  const reloaded=new ConfigStore(file,path.resolve(__dirname,'../config.example.json')).value;
  assert.equal(reloaded.characters.dragon.name,'龙龙🦋');assert.equal(reloaded.characters.whale.name,'鲸鲸🐋');
});
test('legacy configs work and effort is validated independently per provider',t=>{
  const config=structuredClone(defaults);for(const provider of Object.values(config.providers))delete provider.reasoning;validate(config);
  config.providers.deepseek.reasoning={format:'deepseek',effort:'medium'};assert.throws(()=>validate(config),/推理强度/);
  config.providers.deepseek.reasoning.effort='max';config.providers.openai.reasoning={format:'openai',effort:'xhigh'};validate(config);
  const file=path.join(folder(t),'config.json');const store=new ConfigStore(file,path.resolve(__dirname,'../config.example.json'));store.save(config);
  const reloaded=new ConfigStore(file,path.resolve(__dirname,'../config.example.json')).value;
  assert.equal(reloaded.providers.deepseek.reasoning.effort,'max');assert.equal(reloaded.providers.openai.reasoning.effort,'xhigh');
});

function legacyConfig() {
  const old=structuredClone(defaults);old.version=1;
  old.pet.name='原来的小龙';old.pet.greetings=['旧台词'];old.personality={systemPrompt:'旧性格，保留原文'};
  delete old.characters;old.pet.alwaysOnTop=true;old.providers.custom.apiKey='test-local-secret';return old;
}
test('v1 migration preserves the old dragon and connection settings and adds an independent whale',t=>{
  const old=legacyConfig(),file=path.join(folder(t),'config.json');fs.writeFileSync(file,JSON.stringify(old));
  const store=new ConfigStore(file,path.resolve(__dirname,'../config.example.json'));
  assert.equal(store.value.version,2);
  assert.deepEqual(store.value.characters.dragon,{name:old.pet.name,systemPrompt:old.personality.systemPrompt,greetings:old.pet.greetings});
  assert.deepEqual(store.value.characters.whale,defaults.characters.whale);
  assert.deepEqual(store.value.providers,old.providers);assert.equal(store.value.pet.alwaysOnTop,true);
  const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.personality,undefined);assert.equal(saved.pet.name,undefined);
  assert.deepEqual(migrate(saved),saved);assert.equal(new ConfigStore(file,path.resolve(__dirname,'../config.example.json')).value.version,2);
});
test('invalid legacy migration does not replace the file',t=>{
  const old=legacyConfig();old.pet.greetings='broken';const file=path.join(folder(t),'config.json'),raw=JSON.stringify(old);fs.writeFileSync(file,raw);
  assert.throws(()=>new ConfigStore(file,path.resolve(__dirname,'../config.example.json')),/互动台词/);
  assert.equal(fs.readFileSync(file,'utf8'),raw);
});
test('both characters are validated even when one is inactive',()=>{
  const config=structuredClone(defaults);config.chat.provider='deepseek';config.characters.dragon.name='';assert.throws(()=>validate(config),/龙娘名字/);
  config.characters.dragon.name='小龙';config.characters.whale.greetings=[123];assert.throws(()=>validate(config),/鲸鱼娘互动台词/);
});
test('saved assistant names survive reload without entering API message metadata',t=>{
  const file=path.join(folder(t),'history.json'),history=new History(file);
  history.append('hi','鲸鱼回答',true,{id:'whale',name:'鲸鲸'});history.append('hello','龙娘回答',true,{id:'dragon',name:'龙龙'});
  const reloaded=new History(file);assert.equal(reloaded.messages[1].characterName,'鲸鲸');assert.equal(reloaded.messages[3].characterName,'龙龙');
  assert.deepEqual(Object.keys(reloaded.context(4)[1]).sort(),['content','role']);
});

test('old v2 and partially specified DSH configs get defaults without losing other settings',t=>{
  const old=structuredClone(defaults);delete old.integrations;
  const file=path.join(folder(t),'config.json');fs.writeFileSync(file,JSON.stringify(old));
  const store=new ConfigStore(file,path.resolve(__dirname,'../config.example.json'));
  assert.deepEqual(store.value.integrations.dsh,defaults.integrations.dsh);
  assert.deepEqual(store.value.providers,old.providers);
  old.integrations={dsh:{enabled:true}};
  assert.equal(migrate(old).integrations.dsh.enabled,true);
  assert.equal(migrate(old).integrations.dsh.pollMs,500);
  assert.deepEqual(old.integrations,{dsh:{enabled:true}});
});
test('DSH config rejects wrong types, fractions and out of bounds settings',()=>{
  for(const [key,value] of [['enabled',1],['showBubble','false'],['pollMs',199],['pollMs',500.5],['activeSeconds',3601],['sessionsRoot',null],['workspace','x'.repeat(1001)]]) {
    const config=structuredClone(defaults);config.integrations.dsh[key]=value;
    assert.throws(()=>validate(migrate(config)),/dsh\./);
  }
  const config=structuredClone(defaults);config.integrations=null;assert.throws(()=>validate(migrate(config)),/integrations/);
});
test('existing DSH settings gain OpenAI defaults without losing their enabled state',()=>{
  const old=structuredClone(defaults);delete old.integrations.openai;old.integrations.dsh.enabled=true;
  const next=migrate(old);assert.deepEqual(next.integrations.openai,defaults.integrations.openai);assert.equal(next.integrations.dsh.enabled,true);
  assert.equal(old.integrations.openai,undefined);
  for(const [key,value] of [['enabled',1],['showBubble','false'],['socketPath',null],['activeSeconds',10.5]]) {
    const config=structuredClone(defaults);config.integrations.openai[key]=value;assert.throws(()=>validate(migrate(config)),/openai\./);
  }
});
test('OpenAI workspace defaults preserve old enabled settings and reject invalid paths',()=>{
  const old=structuredClone(defaults);old.integrations.openai.enabled=true;delete old.integrations.openai.workspace;
  const next=migrate(old);assert.equal(next.integrations.openai.workspace,'');assert.equal(next.integrations.openai.enabled,true);
  assert.equal(old.integrations.openai.workspace,undefined);
  for(const workspace of [null,123,'x'.repeat(1001)]) {
    const config=structuredClone(defaults);config.integrations.openai.workspace=workspace;
    assert.throws(()=>validate(migrate(config)),/openai.workspace/);
  }
});
