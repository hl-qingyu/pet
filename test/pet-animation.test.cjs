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
    if (!elements.has(id)) elements.set(id, {style:{},dataset:{},events:{},classList:{add(){},remove(){}},
      addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(){}});
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

test('working whale holds frames longer while visual registration leaves the pointer target still', async () => {
  const app=await renderer();app.state('running');
  assert.equal(app.tick(0),'0px -1456px');
  assert.equal(app.tick(120),'0px -1456px');
  assert.equal(app.tick(259),'0px -1456px');
  assert.equal(app.tick(260),'-192px -1456px');
  const first=app.art.style.transform;app.tick(520);
  assert.notEqual(app.art.style.transform,first);
  assert.equal(app.sprite.style.transform,undefined,'visual correction must not move the hover/drag target');
});

test('dragon working animation retains its cadence and receives no whale frame correction', async () => {
  const app=await renderer('gpt-codex');app.state('running');
  assert.equal(app.tick(0),'0px -1456px');assert.equal(app.tick(120),'-192px -1456px');
  assert.equal(app.art.style.transform,'translateX(0px)');
});
