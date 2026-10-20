import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { createOtlpSpanExporter, otlpTraceRequest, spanAttributes } from '../src/otlp-span-exporter.ts';

const traceId='11111111111111111111111111111111';
const spanId='2222222222222222';
const parentSpanId='3333333333333333';
const base=()=>({traceId,spanId,parentSpanId,name:'activity example',startTimeUnixNano:1n,endTimeUnixNano:2n,attributes:{'space.activity_type':'example','space.attempt':1},error:false,kind:1});
const exported=(request)=>request.resourceSpans[0].scopeSpans[0].spans;

test('keeps existing HTTP span fields and OTLP integer encoding',()=>{
 const span={...base(),name:'GET /api/rooms/:id',attributes:{'http.request.method':'GET','http.route':'/api/rooms/:id','http.response.status_code':200,'space.request_id':'req:1'},kind:2};
 const [actual]=exported(otlpTraceRequest([span],'space-api'));
 assert.equal(actual.name,span.name);assert.equal(actual.parentSpanId,parentSpanId);assert.equal(actual.kind,2);
 assert.deepEqual(actual.attributes.find(a=>a.key==='http.response.status_code').value,{intValue:'200'});
 assert.equal(actual.startTimeUnixNano,'1');assert.equal(actual.endTimeUnixNano,'2');
});

test('emits a causal continuation link with only allowlisted metadata',()=>{
 const s={...base(),links:[{traceId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',spanId:'bbbbbbbbbbbbbbbb',attributes:{'space.continued_run_id':'run:1','prompt':'private prompt','path':'/private/customer'}}]};
 const [actual]=exported(otlpTraceRequest([s],'space-worker'));
 assert.equal(actual.links.length,1);assert.equal(actual.links[0].traceId,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 assert.deepEqual(actual.links[0].attributes,[{key:'space.continued_run_id',value:{stringValue:'run:1'}}]);
 assert(!JSON.stringify(actual).includes('private'));
});

test('drops user text, error strings, URLs and unsafe identifier values',()=>{
 const attrs=spanAttributes({'space.workflow_type':'myWorkflow','space.reason_code':'STATE_NOT_FOUND','space.room_id':'customer@example.com','space.workflow_id':'/private/file','space.category':'UPSTREAM_TRANSIENT','prompt':'secret','model.output':'secret','error.message':'secret','url':'https://example.test/private','space.attempt':2,'space.duration_ms':2.5});
 assert.deepEqual(attrs,{'space.workflow_type':'myWorkflow','space.reason_code':'STATE_NOT_FOUND','space.category':'UPSTREAM_TRANSIENT','space.attempt':2,'space.duration_ms':2.5});
 assert.deepEqual(exported(otlpTraceRequest([{...base(),attributes:attrs}],'space-worker'))[0].attributes.find(a=>a.key==='space.duration_ms').value,{doubleValue:2.5});
});

test('rejects URL, query and newline values in route metadata',()=>{
 for(const route of ['https://example.test/private','/api/rooms?token=private','/api/rooms\nprivate'])assert.equal(spanAttributes({'http.route':route})['http.route'],undefined);
});

test('rejects nonfinite and negative numeric attributes',()=>{
 assert.deepEqual(spanAttributes({'space.attempt':NaN,'space.duration_ms':Infinity,'http.response.status_code':-1}),{});
});

test('filters invalid/zero links, deduplicates, and bounds link count',()=>{
 const links=[{traceId:'0'.repeat(32),spanId},{traceId,spanId:'bad'},{traceId,spanId},{traceId,spanId},...Array.from({length:10},(_,i)=>({traceId,spanId:(i+4).toString(16).padStart(16,'0')}))];
 const [actual]=exported(otlpTraceRequest([{...base(),links}],'space-worker'));
 assert.equal(actual.links.length,5);assert(actual.links.every(l=>l.traceId===traceId));
});

test('queue snapshots metadata and links instead of retaining caller objects',async()=>{
 const requests=[];const exporter=createOtlpSpanExporter({endpoint:'http://127.0.0.1:9999',serviceName:'test',batchSize:10,flushIntervalMs:60000,fetch:async(_url,init)=>{requests.push(JSON.parse(init.body));return{ok:true};}});
 const span={...base(),links:[{traceId,spanId:parentSpanId,attributes:{'space.continued_run_id':'run:before'}}]};
 exporter.record(span);span.attributes['space.activity_type']='changed';span.links[0].attributes['space.continued_run_id']='run:after';
 await exporter.close();const [actual]=exported(requests[0]);
 assert(actual.attributes.some(a=>a.value.stringValue==='example'));assert.equal(actual.links[0].attributes[0].value.stringValue,'run:before');
});

test('queue stays bounded and rejected zero IDs do not send a span',async()=>{
 const requests=[];const exporter=createOtlpSpanExporter({endpoint:'http://127.0.0.1:9999',serviceName:'test',batchSize:10,maxQueue:2,flushIntervalMs:60000,fetch:async(_url,init)=>{requests.push(JSON.parse(init.body));return{ok:true};}});
 exporter.record({...base(),traceId:'0'.repeat(32)});exporter.record({...base(),spanId:'0'.repeat(16)});
 exporter.record(base());exporter.record(base());exporter.record(base());await exporter.close();
 assert.equal(exported(requests[0]).length,2);assert.deepEqual(exporter.stats(),{exported:2,dropped:1,failed:0});
});

test('collector failure is contained and counted',async()=>{
 const exporter=createOtlpSpanExporter({endpoint:'http://127.0.0.1:9999',serviceName:'test',flushIntervalMs:60000,fetch:async()=>{throw new Error('collector down');}});
 assert.doesNotThrow(()=>exporter.record(base()));await exporter.close();assert.deepEqual(exporter.stats(),{exported:0,dropped:0,failed:1});
});
