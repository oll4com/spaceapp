import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCatalog,completionSucceeded,selectWorkingFreeModel} from '../../deploy/docker/opencode-first-run.mjs';
const entry=(id,cost=0)=>`opencode/${id}\n${JSON.stringify({id,providerID:'opencode',name:id,status:'active',cost:{input:cost,output:cost},capabilities:{toolcall:true},release_date:'2026-09-01'},null,2)}`;
test('only native explicitly zero-priced tool models are eligible',()=>{
 assert.deepEqual(parseCatalog(entry('free')+'\n'+entry('paid',1)).map(x=>x.id),['opencode/free']);
});
test('successful exit without native text and completion is not a completed model request',()=>{
 assert.equal(completionSucceeded({code:0,stdout:''}),false);
 assert.equal(completionSucceeded({code:0,stdout:JSON.stringify({type:'text',part:{text:'SPACEAPP_READY'}})}),false);
});
test('unavailable free model falls through to another free model without provider override',async()=>{
 const calls=[];
 const selected=await selectWorkingFreeModel({executeNative:async(args,env)=>{
 calls.push(args); assert.equal(env.OPENCODE_API_KEY,undefined);
 if(args[0]==='models')return {code:0,stdout:entry('unavailable')+'\n'+entry('working')};
 if(args.includes('opencode/unavailable'))return {code:0,stdout:'{"type":"error"}'};
 return {code:0,stdout:'{"type":"text","part":{"text":"SPACEAPP_READY"}}\n{"type":"step_finish"}'};
 }});
 assert.equal(selected.id,'opencode/working');assert.equal(calls.length,3);
});
