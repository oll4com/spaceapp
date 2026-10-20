import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { TRACE_HEADER, parseParent, stableSpanId, traceIdForRun, contextForRun, carrierForChild, carrierForContinuation, withTraceHeader, parentFromHeaders, parentFromArgs } from '../src/trace-carrier.ts';
const traceId='11111111111111111111111111111111',spanId='2222222222222222';
const parent={traceId,parentSpanId:spanId,flags:'01'};
const wire=`00-${traceId}-${spanId}-01`;

test('retains W3C context and rejects zero or malformed identifiers',()=>{
 assert.deepEqual(parseParent(wire),parent);
 for(const input of [null, 'secret', wire.replace(traceId,'0'.repeat(32)), wire.replace(spanId,'0'.repeat(16)), wire+'-extra'])assert.equal(parseParent(input),null);
});
test('derives run spans without consuming the application random stream',()=>{
 const previous=Math.random;Math.random=()=>{throw Error('random stream changed');};
 try{const a=contextForRun('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',parent),b=contextForRun('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',parent);assert.deepEqual(a,b);assert.equal(a.traceId,traceId);assert.match(a.spanId,/^[0-9a-f]{16}$/);assert.notEqual(a.spanId,'0'.repeat(16));assert.notEqual(a.spanId,contextForRun('another-run',parent).spanId);}finally{Math.random=previous;}
});
test('creates a reproducible independent trace without an API carrier',()=>{
 assert.equal(traceIdForRun('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),'aaaaaaaabbbbccccddddeeeeeeeeeeee');
 assert.match(traceIdForRun('non-uuid-fixture'),/^[0-9a-f]{32}$/);assert.notEqual(traceIdForRun('a'),traceIdForRun('b'));assert.notEqual(stableSpanId('a'),stableSpanId('b'));
});
test('nests children under the actual workflow span',()=>{
 const current=contextForRun('run:1',parent),carrier=carrierForChild(current);assert.equal(carrier.parentSpanId,current.spanId);const child=contextForRun('run:2',carrier);assert.equal(child.traceId,current.traceId);assert.notEqual(child.spanId,current.spanId);
});
test('continue-as-new links the prior run while preserving API parent',()=>{
 const current=contextForRun('run:1',parent),carrier=carrierForContinuation(current,parent);assert.equal(carrier.parentSpanId,spanId);assert.deepEqual(carrier.links,[{traceId,spanId:current.spanId}]);const next=contextForRun('run:2',carrier);assert.equal(next.traceId,current.traceId);assert.notEqual(next.spanId,current.spanId);
});
test('round-trips only allowlisted carrier fields and preserves unrelated headers',()=>{
 const other={data:Uint8Array.of(42)};const original={other};const headers=withTraceHeader(original,{...parent,secret:'prompt',links:[{traceId,spanId,error:'secret'}]});assert.equal(headers.other,other);assert.equal(original[TRACE_HEADER],undefined);assert.deepEqual(parentFromHeaders(headers),{...parent,links:[{traceId,spanId}]});assert(!String.fromCharCode(...headers[TRACE_HEADER].data).includes('secret'));
});
test('malformed or oversized header payloads never affect workflow work',()=>{
 const headers=withTraceHeader({},parent),base=headers[TRACE_HEADER];
 for(const payload of [{...base,data:new Uint8Array(2049)},{...base,data:Uint8Array.of(123)},{...base,metadata:{encoding:new Uint8Array(1_000_000)}},{...base,metadata:{}},{}])assert.equal(parentFromHeaders({[TRACE_HEADER]:payload}),null);
 assert.equal(parentFromHeaders({}),null);
});
test('bounded carrier decoder discards invalid links and unknown properties',()=>{
 const data=Uint8Array.from(JSON.stringify({...parent,secret:'private',links:[null,{traceId:'0'.repeat(32),spanId},...Array.from({length:10},()=>({traceId,spanId,secret:'private'}))]}),c=>c.charCodeAt(0));const base=withTraceHeader({},parent)[TRACE_HEADER];const decoded=parentFromHeaders({[TRACE_HEADER]:{...base,data}});assert.equal(decoded.links.length,6);assert(!JSON.stringify(decoded).includes('private'));
});
test('reads nested carrier positions without traversing user text or outputs',()=>{
 assert.deepEqual(parentFromArgs([{turn:{traceparent:wire}}]),parent);assert.deepEqual(parentFromArgs([{item:{turn:{traceparent:wire}}}]),parent);assert.equal(parentFromArgs([{prompt:{traceparent:wire},result:{traceparent:wire},error:{traceparent:wire}}]),null);assert.equal(parentFromArgs([{input:{input:{input:{traceparent:wire}}}}]),null);
});
