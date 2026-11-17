'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Quality=require('../www/quality.js');
const frame=(second,overrides={})=>({id:'video',timestamp:second*1000,
  framesDecoded:second*60,framesDropped:0,packetsReceived:second*100,
  packetsLost:0,totalFreezesDuration:0,jitterBufferDelay:second*0.6,
  jitterBufferEmittedCount:second*60,...overrides});
function baseline(tuner){tuner.sample(frame(0));tuner.sample(frame(3));}

test('automatic profiles respect configured ceiling and deduplicate low limits',()=>{
  assert.deepEqual(new Quality(8000).profiles.map(p=>p.bitrate),[8000,4000,2000]);
  assert.deepEqual(new Quality(1500).profiles,[{bitrate:1500,quality:'720p'}]);
  assert.equal(new Quality(0).profile.bitrate,8000);
  assert.equal(new Quality(3000).profile.quality,'720p');
});
test('warmup is excluded and a full observation window is required',()=>{
  const q=new Quality();baseline(q);
  assert.equal(q.sample(frame(12)),null);
  assert.equal(q.sample(frame(13)).type,'ready');
  assert.equal(q.done,true);assert.equal(q.profile.bitrate,8000);
});
test('packet loss lowers one profile and a fresh session has its own warmup',()=>{
  const q=new Quality();baseline(q);
  const decision=q.sample(frame(13,{packetsLost:40}));
  assert.equal(decision.type,'adjust');assert.equal(decision.profile.bitrate,4000);
  assert.ok(decision.reasons.includes('网络丢包'));
  assert.equal(q.sample(frame(0,{id:'next'})),null);
  assert.equal(q.sample(frame(3,{id:'next'})),null);
  assert.equal(q.sample(frame(13,{id:'next'})).type,'ready');
});
test('severe freezes jump to lowest profile and cannot cause endless reconnects',()=>{
  const q=new Quality();baseline(q);
  assert.equal(q.sample(frame(13,{totalFreezesDuration:3})).profile.bitrate,2000);
  baseline(q);
  const result=q.sample(frame(13,{totalFreezesDuration:3}));
  assert.equal(result.type,'ready');assert.equal(result.bad,true);assert.equal(q.done,true);
});
test('buffering and decoder drops trigger degradation even without RTP loss',()=>{
  for(const extra of [{jitterBufferDelay:200},{framesDropped:100}]){
    const q=new Quality();baseline(q);
    assert.equal(q.sample(frame(13,extra)).type,'adjust');
  }
});
test('completed calibration only warns and never reconnects during gameplay',()=>{
  const q=new Quality();baseline(q);q.sample(frame(13));
  assert.equal(q.sample(frame(23,{packetsLost:500})).type,'warning');
  assert.equal(q.profile.bitrate,8000);
});
test('background tabs reset observation rather than treating throttling as poor network',()=>{
  const q=new Quality();baseline(q);
  assert.equal(q.sample(frame(13,{totalFreezesDuration:10}),false),null);
  assert.equal(q.sample(frame(14)),null);
  assert.equal(q.sample(frame(17)),null);
  assert.equal(q.sample(frame(27)).type,'ready');
});
test('changed RTP stream and reset counters require a fresh window',()=>{
  const q=new Quality();baseline(q);
  assert.equal(q.sample(frame(0,{id:'replacement'})),null);
  assert.equal(q.sample(frame(3,{id:'replacement'})),null);
  assert.equal(q.sample(frame(13,{id:'replacement'})).type,'ready');
});
test('static content low bitrate and low FPS are not mistaken for poor throughput',()=>{
  const q=new Quality();baseline(q);
  assert.equal(q.sample(frame(13,{framesDecoded:181,packetsReceived:310})).type,'ready');
  assert.equal(q.profile.bitrate,8000);
});
test('negative packet loss corrections are harmless',()=>{
  const result=Quality.assess(frame(3,{packetsLost:20}),frame(13,{packetsLost:5}));
  assert.equal(result.bad,false);
});
test('missing statistics are not fabricated as success',()=>{
  const q=new Quality();
  assert.equal(q.sample(null),null);
  assert.equal(q.sample({timestamp:1000}),null);
  assert.equal(q.done,false);
});
test('received RTP without decoded frames is identified separately from success',()=>{
  const q=new Quality(1500);q.sample(frame(0,{framesDecoded:0}));q.sample(frame(3,{framesDecoded:0}));
  const result=q.sample(frame(13,{framesDecoded:0}));
  assert.equal(result.noFrames,true);assert.equal(result.bad,true);
});
