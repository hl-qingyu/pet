const test=require('node:test'),assert=require('node:assert/strict');
const {project,DshAccount}=require('../src/backends/dsh-account.cjs');
test('account projection includes only validated monetary summaries',()=>{
 assert.deepEqual(project({normal_wallets:[{currency:'CNY',balance:'1.25'}],bonus_wallets:[],total_costs:[{currency:'USD',amount:'0.5'}],token:'secret'}),{depleted:false,insufficient:false,balance:'¥1.25',bonus:'—',cost:'$0.50'});
 assert.throws(()=>project({}));
 assert.throws(()=>project({normal_wallets:[{currency:'CNY',balance:'oops'}]}));
});
test('disabled account monitor clears data and starts no polling',()=>{
 const updates=[];const monitor=new DshAccount(v=>updates.push(v));monitor.configure(false);assert.deepEqual(updates,[null]);assert.equal(monitor.timer,undefined);monitor.stop();
});

test('only an exhausted combined wallet triggers the insufficient balance state',()=>{
 const sample=(normal,bonus)=>project({normal_wallets:[{currency:'CNY',balance:normal}],bonus_wallets:[{currency:'CNY',balance:bonus}],total_costs:[]});
 assert.equal(sample('0','0').insufficient,true);
 assert.equal(sample('-1','0').insufficient,true);
 assert.equal(sample('0','0.001').insufficient,false);
 assert.equal(sample('1','0').insufficient,false);
 assert.equal(project({normal_wallets:[],bonus_wallets:[],total_costs:[]}).insufficient,false);
});

test('configured warning threshold uses unrounded account amounts',()=>{
 const data={normal_wallets:[{currency:'CNY',balance:'1.50'}],bonus_wallets:[],total_costs:[]};
 assert.equal(project(data,2).insufficient,true);
 assert.equal(project(data,1.5).insufficient,true);
 assert.equal(project(data,1.49).insufficient,false);
});
