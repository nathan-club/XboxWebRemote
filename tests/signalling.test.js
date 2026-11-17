'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Signalling = require('../www/signalling.js');

function vendorClient() {
  const context = {setInterval, clearInterval, console};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../www/lib/xCloudPlayer.min.js'), 'utf8'), context);
  return new context.xCloudPlayer.default.ApiClient({host:'https://example.com'});
}

function setup(t, fetcher, options = {}) {
  const old = global.fetch;
  global.fetch = fetcher;
  t.after(() => {global.fetch = old;});
  const client = vendorClient();
  const attach = Signalling.install(client, {interval:1, pollTimeout:15, ...options});
  return {client, attach};
}

const reply = (body, status = 200) => new Response(
  status === 204 ? null : JSON.stringify(body), {status});

test('real vendor SDP method rejects HTTP 502 without polling absent answer', async t => {
  const requests = [];
  const {client, attach} = setup(t, async (url, opts) => {
    requests.push(opts.method + ' ' + url.split('/').pop());
    return opts.method === 'POST' ? reply({sessionId:'synthetic', sessionPath:'v5/sessions/home/synthetic'}) : reply({});
  });
  const stream = attach(await client.startStream('home', 'synthetic-console'));
  global.fetch = async (url, opts) => {requests.push(opts.method + ' ' + url.split('/').pop()); return reply({error:'private upstream detail'}, 502);};
  await assert.rejects(stream.sendSDPOffer({sdp:'synthetic'}), /POST sdp.*502/);
  assert.deepEqual(requests, ['POST play', 'POST sdp']);
});

test('HTTP 204 replies are polled until SDP answer arrives', async t => {
  let calls = 0;
  const {attach} = setup(t, async () => ++calls < 3 ? reply(null, 204) : reply({exchangeResponse:'answer'}));
  const session = attach({getSessionPath:()=>'/session', stop:async()=>{}});
  assert.deepEqual(await session.waitForSdpResponse(), {exchangeResponse:'answer'});
  assert.equal(calls, 3);
});

test('absent SDP answer times out instead of polling forever', async t => {
  const {attach} = setup(t, async () => reply(null, 204));
  const session = attach({getSessionPath:()=>'/session', stop:async()=>{}});
  await assert.rejects(session.waitForSdpResponse(), /SDP 回复超时/);
});

test('state transition callback can start ReadyToConnect polling without losing it', async t => {
  const {attach} = setup(t, async () => reply({}));
  let calls = 0, next;
  const session = attach({
    getSessionPath:()=>'/session', stop:async()=>{},
    refreshState:async()=>{
      calls++;
      if(calls === 1) { next = session.waitForState('ReadyToConnect'); return 'Provisioned'; }
      return 'ReadyToConnect';
    },
  });
  await session.waitForState('Provisioned');
  await next;
  assert.equal(calls, 2);
});

test('request timeout rejects network stalls', async t => {
  const {client} = setup(t, (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', ()=>reject(new Error('aborted')));
  }), {requestTimeout:5});
  await assert.rejects(client.post('/sdp', '{}'), /超时/);
});

test('explicit stop aborts in-flight polling and does not restart it', async t => {
  let calls = 0;
  const {attach} = setup(t, async () => {calls++;return reply(null, 204);});
  const session = attach({getSessionPath:()=>'/session', stop:async()=>({status:'ok'})});
  const pending = session.waitForIceResponse();
  await session.stop();
  await assert.rejects(pending, /会话已停止/);
  assert.equal(calls, 1);
});


test('real vendor SDP and ICE accept empty 202 before receiving answers', async t => {
  const requests = [];
  const {client, attach} = setup(t, async (url, opts) => {
    const endpoint = url.split('/').pop();
    requests.push(opts.method + ' ' + endpoint);
    if(endpoint === 'play') return reply({sessionId:'synthetic', sessionPath:'v5/sessions/home/synthetic'}, 202);
    if(opts.method === 'POST' || opts.method === 'DELETE') return new Response(null, {status:202});
    return reply({exchangeResponse:endpoint + '-answer'});
  });
  const session = attach(await client.startStream('home', 'synthetic-console'));
  assert.deepEqual(await session.sendSDPOffer({sdp:'synthetic'}), {exchangeResponse:'sdp-answer'});
  assert.deepEqual(await session.sendIceCandidates([]), {exchangeResponse:'ice-answer'});
  assert.deepEqual(await session.sendMSALAuth('synthetic-token'), {status:202});
  assert.deepEqual(await session.sendKeepalive(), {status:202});
  await session.stop();
  assert.deepEqual(requests, ['POST play','POST sdp','GET sdp','POST ice','GET ice',
    'POST connect','POST keepalive','DELETE synthetic']);
});

test('empty GET response reports the endpoint instead of pretending to have SDP', async t => {
  const {client} = setup(t, async () => new Response(null, {status:200}));
  await assert.rejects(client.get('/sdp'), /GET sdp 返回空响应/);
});

test('malformed nonempty JSON remains an error without disclosing the response', async t => {
  const {client} = setup(t, async () => new Response('private upstream invalid payload', {status:200}));
  await assert.rejects(client.get('/ice'), error => {
    assert.match(error.message, /GET ice 返回无效 JSON/);
    assert.equal(error.message.includes('private upstream'), false);
    return true;
  });
});

test('connected media cancels readiness timeout while keepalive and session remain usable', async t => {
  const requests=[];
  const {client,attach}=setup(t,async(url,opts)=>{
    requests.push(opts.method+' '+url.split('/').pop());
    if(url.endsWith('/play')) return reply({sessionId:'synthetic',sessionPath:'v5/sessions/home/synthetic'},202);
    if(url.endsWith('/state')) return reply({state:'Provisioned'});
    return new Response(null,{status:202});
  });
  const session=attach(await client.startStream('home','synthetic-console'));
  const errors=[];
  session.onSignallingError=e=>errors.push(e);
  const pending=session.waitForState('ReadyToConnect');
  session.cancelStateWait();
  await pending;
  await new Promise(resolve=>setTimeout(resolve,25));
  await session.sendMSALAuth('synthetic-token');
  await session.sendKeepalive();
  assert.deepEqual(errors,[]);
  assert.equal(requests.some(r=>r.startsWith('DELETE')),false);
  assert.equal(requests.filter(r=>r==='GET state').length,1);
  assert.ok(requests.includes('POST connect'));
  assert.ok(requests.includes('POST keepalive'));
});

test('cancelled or superseded state requests cannot report late errors',async t=>{
  const {attach}=setup(t,async()=>reply({}));
  let rejectState;
  const session=attach({getSessionPath:()=>'/session',stop:async()=>{},
    refreshState:()=>new Promise((resolve,reject)=>{rejectState=reject;})});
  const errors=[];
  session.onSignallingError=e=>errors.push(e);
  const pending=session.waitForState('ReadyToConnect');
  session.cancelStateWait();
  rejectState(new Error('late failure'));
  await pending;
  assert.deepEqual(errors,[]);
});

test('a session that never becomes ready or connects still reports timeout',async t=>{
  const {attach}=setup(t,async()=>reply({}));
  const session=attach({getSessionPath:()=>'/session',stop:async()=>{},refreshState:async()=>'Provisioned'});
  const errors=[];
  session.onSignallingError=e=>errors.push(e.message);
  await session.waitForState('ReadyToConnect');
  assert.deepEqual(errors,['等待主机状态超时']);
});
