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

const reply = (body, status = 200) => ({ok:status >= 200 && status < 300, status, json:async()=>body});

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
