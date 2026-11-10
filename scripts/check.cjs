const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');let failed=false;
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(dir,item.name)):[path.join(dir,item.name)]);}
for(const file of [...walk(path.join(root,'src')),...walk(path.join(root,'renderer')),...walk(path.join(root,'scripts')),...walk(path.join(root,'test'))].filter(f=>/\.(?:cjs|js)$/.test(f))){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){console.error(result.stderr);failed=true;}
}
require('../src/config.cjs').validate(require('../config.example.json'));
for (const sprite of ['assets/spritesheet.webp','assets/whale/spritesheet.webp']) {
  const sheet=fs.readFileSync(path.join(root,sprite));if(sheet.toString('ascii',0,4)!=='RIFF'||sheet.toString('ascii',8,12)!=='WEBP')throw new Error(`Invalid sprite: ${sprite}`);
}
const cleanup=require('../assets/whale/cleanup-report.json');
const whaleHash=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'assets/whale/spritesheet.webp'))).digest('hex');
if(whaleHash!==cleanup.output_sha256)throw new Error('Whale atlas does not match its reviewed cleanup report');
console.log(failed?'Syntax check failed':'Syntax, default config and sprite checks passed');process.exitCode=failed?1:0;
