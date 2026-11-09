// Runs the actual Electron app against a local mock API. No external credentials or API traffic.
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const {spawn}=require('node:child_process');
const { character:getCharacter }=require('../renderer/themes.js');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'work','ui-smoke');fs.mkdirSync(directory,{recursive:true});
const reportPath=path.join(directory,'data','smoke-report.json');if(fs.existsSync(reportPath))fs.unlinkSync(reportPath);
const config=structuredClone(require('../config.example.json'));config.chat.provider='custom';config.chat.saveHistory=false;config.providers.custom.model='mock-model';
if(process.argv.includes('--whale'))config.providers.custom.model='deepseek-mock-model';
config.providers.custom.reasoning={format:'openai',effort:'high'};
const server=http.createServer(async(req,res)=>{
  let data='';for await(const part of req)data+=part;
  const body=JSON.parse(data);const content=body.messages.at(-1).content;
  const saved=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8')),character=getCharacter(saved);
  if(!body.messages[0].content.includes(character.systemPrompt)||!body.messages[0].content.includes(character.name)){res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":{"message":"wrong character"}}');return;}
  if(body.reasoning_effort!=='high'){res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":{"message":"reasoning effort missing"}}');return;}
  if(content==='触发错误'){res.writeHead(429,{'Content-Type':'application/json'});res.end('{"error":{"message":"mock rate limit"}}');return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: {"choices":[{"delta":{"content":"我在呢，"}}]}\n\n');
  setTimeout(()=>res.end('data: {"choices":[{"delta":{"content":"今天也一起慢慢来。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),100);
});
server.listen(0,'127.0.0.1',()=>{
  config.providers.custom.baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  const file=path.join(directory,'config.json');fs.writeFileSync(file,JSON.stringify(config,null,2));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const packaged=process.argv.includes('--packaged');
  const executable=packaged?path.join(root,'dist','win-unpacked','DragonDesk.exe'):require('electron');
  const child=spawn(executable,[...(packaged?[]:[root]),`--config=${file}`,'--smoke-test'],{cwd:root,env,stdio:'inherit',windowsHide:true});
  const timeout=setTimeout(()=>{console.error('UI smoke timed out');child.kill();process.exitCode=1;server.close();},60000);
  child.on('error',error=>{console.error(error);clearTimeout(timeout);server.close();process.exitCode=1;});
  child.on('exit',(code,signal)=>{clearTimeout(timeout);server.closeAllConnections();server.close();let passed=false;try{passed=JSON.parse(fs.readFileSync(reportPath,'utf8')).pass===true;}catch{}process.exitCode=code===0&&passed?0:1;console.log('UI smoke exit:',code,'signal:',signal,'report passed:',passed);});
});
