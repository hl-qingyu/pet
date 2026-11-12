const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const defaults = require('../config.example.json');

async function renderer(model = 'deepseek-flash') {
  const elements = new Map(), handlers = new Map(), frames = [];
  const config = structuredClone(defaults);
  config.chat.provider = 'custom'; config.providers.custom.model = model; config.pet.followMouse = false;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {style:{},dataset:{},events:{},classList:{add(){},remove(){},toggle(){}},
      addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(){},
      setPointerCapture(){},hasPointerCapture(){return false;},releasePointerCapture(){}});
    return elements.get(id);
  }
  const context = vm.createContext({
    document: {querySelector:element,documentElement:{dataset:{}},addEventListener(){}},
    window: {petThemes:require('../renderer/themes.js'),petMotion:require('../renderer/pet-motion.js'),
      dragon:{on:(name,fn)=>handlers.set(name,fn),invoke:async()=>({config,state:'idle'}),send(){}}},
    setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:fn=>frames.push(fn),
  });
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/pet.js'),'utf8'),context);
  await Promise.resolve(); await Promise.resolve();
  return {sprite:element('#sprite'),art:element('#sprite-art'),
    state:value=>handlers.get('pet:state')({state:value}),
    dragDirection:value=>handlers.get('pet:drag-direction')(value),
    account:value=>handlers.get('dsh:account')(value),
    tick:time=>{ const next=frames.shift();assert.ok(next);next(time);return element('#sprite').style.backgroundPosition; }};
}

test('whale hover plays one complete jump and then rests until the pointer reenters', async () => {
  const app=await renderer();app.tick(0);app.sprite.events.pointerenter();
  const frames=[];for(let time=10;time<3000;time+=10)frames.push(app.tick(time));
  for(let column=0;column<5;column++)assert.ok(frames.includes(`${-column*192}px -832px`));
  const rest=frames.findIndex(position=>position.endsWith(' 0px'));
  assert.ok(rest>=80,'last jump frame should retain its duration');
  assert.ok(frames.slice(rest).every(position=>position.endsWith(' 0px')));
  app.sprite.events.pointerleave();app.sprite.events.pointerenter();assert.ok(app.tick(3010).endsWith(' -832px'));
});

function drag(app) {
  app.sprite.events.pointerdown({button:0,pointerId:1,screenX:100,screenY:100});
  app.sprite.events.pointermove({pointerId:1,screenX:120,screenY:100});
}

test('whale left and right runs use matching strides with no pause at the loop boundary', async () => {
  for (const direction of ['running-left','running-right']) {
    const app=await renderer();drag(app);app.dragDirection(direction);
    for(let frame=0;frame<10;frame++)assert.equal(app.tick(frame*120),`${-(frame%8)*192}px -416px`);
    assert.equal(app.art.style.transform,direction==='running-right'?'translateX(0px) scaleX(-1)':'translateX(0px)');
    assert.equal(app.sprite.style.transform,undefined,'mirroring must leave the drag target fixed');
  }
});

test('whale changes drag direction at the current stride and restores pending work when released', async () => {
  const app=await renderer();drag(app);app.dragDirection('running-right');
  app.tick(0);app.tick(120);assert.equal(app.tick(240),'-384px -416px');
  app.dragDirection('running-left');
  assert.equal(app.tick(250),'-384px -416px');assert.equal(app.art.style.transform,'translateX(0px)');
  assert.equal(app.tick(360),'-576px -416px');
  app.state('running');assert.equal(app.tick(370),'-576px -416px');
  app.dragDirection('running-right');assert.equal(app.tick(380),'-576px -416px');
  assert.equal(app.art.style.transform,'translateX(0px) scaleX(-1)');
  app.sprite.events.pointerup({pointerId:1});assert.equal(app.tick(390),'0px -1456px');
});

test('dragon keeps its separate running rows and original loop timing', async () => {
  for (const [direction,row] of [['running-right',1],['running-left',2]]) {
    const app=await renderer('gpt-codex');drag(app);app.dragDirection(direction);
    for(let frame=0;frame<8;frame++)assert.equal(app.tick(frame*120),`${-frame*192}px ${-row*208}px`);
    assert.equal(app.tick(960),`-1344px ${-row*208}px`);assert.equal(app.tick(1060),`0px ${-row*208}px`);
    assert.equal(app.art.style.transform,'translateX(0px)');
  }
});

test('working whale holds frames longer while visual registration leaves the pointer target still', async () => {
  const app=await renderer();app.state('running');
  assert.equal(app.tick(0),'0px -1456px');
  assert.equal(app.tick(120),'0px -1456px');
  assert.equal(app.tick(149),'0px -1456px');
  assert.equal(app.tick(150),'-192px -1456px');
  const first=app.art.style.transform;app.tick(520);
  assert.equal(app.art.style.transform,first);
  assert.equal(app.sprite.style.transform,undefined,'visual correction must not move the hover/drag target');
});

test('dragon working animation retains its cadence and receives no whale frame correction', async () => {
  const app=await renderer('gpt-codex');app.state('running');
  assert.equal(app.tick(0),'0px -1456px');assert.equal(app.tick(120),'-192px -1456px');
  assert.equal(app.art.style.transform,'translateX(0px)');
});


test('low balance plays sleep animation and clearing it restores idle; dragon remains unaffected',async()=>{
 const app=await renderer();app.account({insufficient:true});assert.equal(app.tick(0),'0px -1248px');
 app.sprite.events.pointerenter();assert.equal(app.tick(300),'0px -832px');
 app.sprite.events.pointerleave();app.account({insufficient:false});assert.equal(app.tick(301),'0px 0px');
 app.account({error:'unavailable'});assert.equal(app.tick(302),'0px 0px');
 const dragon=await renderer('gpt-codex');dragon.account({insufficient:true});assert.equal(dragon.tick(0),'0px 0px');
});

test('working animation takes priority over low balance and sleep resumes after work',async()=>{
 const app=await renderer();app.account({insufficient:true});app.state('running');
 assert.equal(app.tick(0),'0px -1456px');
 app.state('idle');assert.equal(app.tick(300),'0px -1248px');
});

test('low balance does not override interaction, completion or failure animations',async()=>{
 for(const [state,row] of [['waving',3],['jumping',4],['failed',5],['waiting',6],['review',8]]){
  const app=await renderer();app.account({insufficient:true});app.state(state);
  assert.equal(app.tick(0),'0px '+(-row*208)+'px');
 }
});

test('zero balance plays failure once then freezes and blocks other animations until recovery',async()=>{
 const app=await renderer();app.account({depleted:true,insufficient:true});
 assert.equal(app.tick(0),'0px -1040px');
 for(let i=1;i<8;i++)assert.equal(app.tick(i*500),(-i*192)+'px -1040px');
 app.state('running');app.sprite.events.pointerenter();
 assert.equal(app.tick(5000),'-1344px -1040px');
 app.account({error:'unavailable'});assert.equal(app.tick(6000),'-1344px -1040px');
 app.account({depleted:false,insufficient:false});assert.equal(app.tick(6500),'0px -1456px');
});
