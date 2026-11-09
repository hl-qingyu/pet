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
