const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { streamReply, sse, endpoint, userError } = require('../src/backends/api.cjs');
const defaults = require('../config.example.json');

async function server(t, callback) {
  const instance = http.createServer(callback);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); });
  const config = structuredClone(defaults);
  config.chat.provider = 'custom';
  config.providers.custom = { ...config.providers.custom, baseUrl: `http://127.0.0.1:${instance.address().port}/v1`, model: 'test-model', apiKey: 'private-test-key' };
  return config;
}
test('Chat Completions sends personality, history and only streams the public answer', async t => {
  let received;
  const config = await server(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer private-test-key');
    let body = ''; for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"hidden reasoning"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好，小龙"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = Buffer.from(text); for (let i=0; i<bytes.length; i+=3) res.write(bytes.subarray(i,i+3)); res.end();
  });
  const deltas = [];
  const result = await streamReply({ config, messages: [{ role:'user',content:'你好' }], onDelta: d => deltas.push(d) });
  assert.equal(result, '你好，小龙'); assert.equal(deltas.join(''), result);
  assert.ok(received.messages[0].content.includes(config.characters.dragon.systemPrompt));
  assert.ok(received.messages[0].content.includes(config.characters.dragon.name));
  assert.equal(received.messages[1].content, '你好'); assert.equal(received.stream, true); assert.equal(received.tools, undefined);
});
test('Responses handles typed deltas and disables server persistence', async t => {
  let received;
  const config = await server(t, async (req,res) => {
    assert.equal(req.url,'/v1/responses'); let data=''; for await (const chunk of req) data+=chunk; received=JSON.parse(data);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"在呢"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  config.providers.custom.protocol='responses';
  assert.equal(await streamReply({ config, messages:[{role:'user',content:'在吗'}], onDelta:()=>{} }), '在呢');
  assert.equal(received.store,false); assert.ok(received.instructions.includes(config.characters.dragon.systemPrompt)); assert.equal(received.messages,undefined);
});
test('stream parser preserves split UTF-8 and multiline SSE data', async () => {
  const bytes=Buffer.from('data: {"a":\r\ndata: "龙"}\r\n\r\n: heartbeat\r\n\r\ndata: [DONE]');
  async function* chunks(){ for(const byte of bytes) yield Uint8Array.of(byte); }
  const items=[]; for await(const data of sse(chunks())) items.push(data);
  assert.deepEqual(items,['{"a":\n"龙"}','[DONE]']);
});

test('the selected character name and personality reach both API protocols through custom models',async t=>{
  let received;
  const config=await server(t,async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;received=JSON.parse(raw);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(received.input?{output_text:'OK'}:{choices:[{message:{content:'OK'}}]}));
  });
  config.characters.dragon={name:'龙龙',systemPrompt:'安静沉稳的龙娘设定',greetings:['龙台词']};
  config.characters.whale={name:'鲸鲸',systemPrompt:'活泼傲娇的鲸鱼设定',greetings:['鲸台词']};
  for(const protocol of ['chat-completions','responses'])for(const [model,id] of [['deepseek-flash','whale'],['gpt-codex','dragon']]){
    config.providers.custom.protocol=protocol;config.providers.custom.model=model;
    await streamReply({config,messages:[{role:'user',content:'你是谁'}],onDelta:()=>{}});
    const instructions=received.instructions||received.messages[0].content;
    assert.ok(instructions.includes(config.characters[id].name));assert.ok(instructions.includes(config.characters[id].systemPrompt));
    assert.ok(!instructions.includes(config.characters[id==='dragon'?'whale':'dragon'].systemPrompt));
  }
});
test('API errors redact keys returned by an untrusted server', async t => {
  const config=await server(t,(_req,res)=>{ res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'rejected private-test-key'}})); });
  await assert.rejects(streamReply({config,messages:[],onDelta:()=>{}}),error=>!error.message.includes('private-test-key') && error.message.includes('401'));
});
test('cancellation stops a pending HTTP stream', async t => {
  const config=await server(t,(_req,res)=>{ res.writeHead(200,{'Content-Type':'text/event-stream'}); res.write(': waiting\n\n'); });
  const controller=new AbortController(); const promise=streamReply({config,messages:[],signal:controller.signal,onDelta:()=>{}});
  setTimeout(()=>controller.abort(new Error('user stopped')),40);
  await assert.rejects(promise,/user stopped/);
});
test('an interrupted stream never commits a partial answer', async t => {
  const config=await server(t,(_req,res)=>{ res.writeHead(200,{'Content-Type':'text/event-stream'}); res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); });
  await assert.rejects(streamReply({config,messages:[],onDelta:()=>{}}),/连接提前中断/);
});
test('non-streaming compatibility gateway response works',async t=>{
  const config=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"choices":[{"message":{"content":"完整答复"}}]}');});
  assert.equal(await streamReply({config,messages:[],onDelta:()=>{}}),'完整答复');
});
test('model and key validation happens before any request',async()=>{
  const config=structuredClone(defaults); let called=false;
  await assert.rejects(streamReply({config,messages:[],onDelta:()=>{},fetchImpl:()=>{called=true;}}),/API Key/); assert.equal(called,false);
  config.chat.provider='openai'; await assert.rejects(streamReply({config,messages:[],onDelta:()=>{}}),/模型名称/);
});
test('URL joining accepts both base URL and full endpoint',()=>{
  assert.equal(endpoint('https://example.test/v1/','responses'),'https://example.test/v1/responses');
  assert.equal(endpoint('https://example.test/v1/chat/completions','chat-completions'),'https://example.test/v1/chat/completions');
  assert.equal(userError(new Error('Bearer secret')),'Bearer [已隐藏]');
});

const reasoningCases = [
  { name:'OpenAI Responses preserves other reasoning options', protocol:'responses', format:'openai', effort:'xhigh', extra:{reasoning:{summary:'auto'},thinking:{type:'enabled'},reasoning_effort:'low'}, expected:{reasoning:{summary:'auto',effort:'xhigh'}} },
  { name:'OpenAI Chat uses reasoning_effort', protocol:'chat-completions', format:'openai', effort:'low', extra:{reasoning:{effort:'high'},thinking:{type:'enabled'}}, expected:{reasoning_effort:'low'} },
  { name:'DeepSeek none explicitly disables thinking and removes old effort', protocol:'chat-completions', format:'deepseek', effort:'none', extra:{reasoning_effort:'max',thinking:{type:'enabled'},reasoning:{effort:'high'}}, expected:{thinking:{type:'disabled'}} },
  { name:'DeepSeek max enables thinking with max effort', protocol:'chat-completions', format:'deepseek', effort:'max', extra:{thinking:{type:'disabled'}}, expected:{thinking:{type:'enabled'},reasoning_effort:'max'} },
  { name:'DeepSeek Responses disables via nested none', protocol:'responses', format:'deepseek', effort:'none', extra:{thinking:{type:'enabled'},reasoning_effort:'high'}, expected:{reasoning:{effort:'none'}} },
  { name:'default preserves legacy extraBody reasoning', protocol:'chat-completions', format:'deepseek', effort:'default', extra:{thinking:{type:'disabled'},reasoning_effort:'high'}, expected:{thinking:{type:'disabled'},reasoning_effort:'high'} },
];
for (const scenario of reasoningCases) test(scenario.name, async t => {
  let received;
  const config = await server(t, async (req,res) => {
    let raw=''; for await(const chunk of req) raw+=chunk; received=JSON.parse(raw);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(scenario.protocol==='responses' ? {output_text:'OK'} : {choices:[{message:{content:'OK'}}]}));
  });
  config.providers.custom.protocol=scenario.protocol;
  config.providers.custom.reasoning={format:scenario.format,effort:scenario.effort};
  config.providers.custom.extraBody=scenario.extra;
  await streamReply({config,messages:[{role:'user',content:'hi'}],onDelta:()=>{}});
  const fields={};for(const key of ['reasoning','reasoning_effort','thinking'])if(key in received)fields[key]=received[key];
  assert.deepEqual(fields,scenario.expected);
  if (scenario.protocol==='chat-completions' && scenario.format==='openai' && scenario.effort!=='default') {
    assert.equal(received.max_completion_tokens,config.chat.maxOutputTokens);assert.equal(received.max_tokens,undefined);
  } else if (scenario.protocol==='chat-completions') {
    assert.equal(received.max_tokens,config.chat.maxOutputTokens);assert.equal(received.max_completion_tokens,undefined);
  }
  assert.deepEqual(config.providers.custom.extraBody,scenario.extra);
});
