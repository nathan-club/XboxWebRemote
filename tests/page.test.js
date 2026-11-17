'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function page(authenticated, config = {}) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style:{}, classList:{add(){}, remove(){}, toggle(){}},
      textContent:'', innerHTML:'', value:'',
    });
    return nodes.get(id);
  };
  const requests = [], started = [];
  const context = {
    URL, console,
    location:{href:'https://xbox.example.com/?console=F2', origin:'https://xbox.example.com'},
    isSecureContext:true, xCloudPlayer:{default:{}},
    document:{hasFocus:()=>true, getElementById:element, querySelectorAll:()=>[], addEventListener(){}},
    localStorage:{getItem:()=>null, setItem(){}},
    navigator:{getGamepads:()=>[]}, addEventListener(){}, setTimeout:()=>1, clearTimeout(){},
    setInterval:()=>1, clearInterval(){},
    fetch:async url => {
      requests.push(url);
      const body = url === '/api/config' ? {remoteLogin:true, liveEnabled:false, ...config}
        : url === '/api/auth/status' ? {authenticated}
        : url === '/v6/servers/home?mr=50' ? {results:[{serverId:'F1'}, {serverId:'F2'}]}
        : null;
      if (!body) throw new Error('Unexpected request '+url);
      return {ok:true, status:200, json:async()=>body};
    },
    captureStart:async c => started.push(c.serverId),
  };
  context.window = context;
  vm.createContext(context);
  const root = path.join(__dirname, '..', 'www');
  vm.runInContext(fs.readFileSync(path.join(root, 'launch.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'media.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  vm.runInContext(js, context);
  vm.runInContext('startFlow = captureStart; renderConsoles = ()=>{};', context);
  return {context, requests, started, nodes};
}

test('saved NAS authorization opens the bookmarked console directly', async () => {
  const p = page(true);
  await vm.runInContext('boot()', p.context);
  assert.deepEqual(p.started, ['F2']);
  assert.deepEqual(p.requests, ['/api/config', '/api/auth/status', '/v6/servers/home?mr=50']);
  assert.equal(p.nodes.get('btnSource').style.display, 'none');
  await vm.runInContext('refreshConsoles()', p.context);
  assert.deepEqual(p.started, ['F2']);
});

test('expired authorization waits for login then retains the requested console', async () => {
  const p = page(false);
  await vm.runInContext('boot()', p.context);
  assert.deepEqual(p.started, []);
  assert.equal(p.requests.includes('/v6/servers/home?mr=50'), false);
  assert.match(p.nodes.get('loginSteps').innerHTML, /剪贴板/);
  // Successful Microsoft callback enters the existing console-discovery flow.
  await vm.runInContext('enterConsoles()', p.context);
  assert.deepEqual(p.started, ['F2']);
});

test('plain HTTP stops before starting authorization or media', async () => {
  const p = page(true);
  p.context.isSecureContext = false;
  await vm.runInContext('boot()', p.context);
  assert.deepEqual(p.requests, []);
  assert.match(p.nodes.get('loginMsg').textContent, /HTTPS/);
});


test('low bandwidth configuration selects 720p before starting a session', async () => {
  const p = page(true, {videoBitrate:1500});
  await vm.runInContext('boot()', p.context);
  assert.equal(vm.runInContext('quality', p.context), '720p');
});


test('configured relay remains the default until the user selects a mode', async () => {
  const p = page(true, {forceRelay:true});
  await vm.runInContext('boot()', p.context);
  assert.equal(p.nodes.get('mediaMode').value, 'relay');
  p.nodes.get('mediaMode').onchange({target:{value:'direct'}});
  assert.equal(vm.runInContext('mediaMode', p.context), 'direct');
  assert.match(p.nodes.get('mediaHint').textContent, /不使用 TURN/);
});

test('media readiness cancels startup polling, sends host authorization once and retains keepalive', async()=>{
  const p=page(true);
  const calls={cancel:0,auth:0,keepalive:0,player:0,stop:0};
  const intervals=[];
  const session={getSessionId:()=> 'synthetic',waitForState(){},
    cancelStateWait(){calls.cancel++;},
    async sendMSALAuth(token){assert.equal(token,'synthetic-token');calls.auth++;},
    async sendKeepalive(){calls.keepalive++;return {};},
    async stop(){calls.stop++;}};
  p.context.xCloudPlayer.default.ApiClient=class {async startStream(){return session;}};
  p.context.XwrSignalling={install:()=>s=>s};
  p.context.capturePlayer=async()=>{calls.player++;};
  p.context.setInterval=callback=>{intervals.push(callback);return intervals.length;};
  p.context.fetch=async url=>{
    assert.equal(url,'/api/msal');
    return {ok:true,json:async()=>({token:'synthetic-token'})};
  };
  vm.runInContext('startPlayer=capturePlayer;',p.context);
  await vm.runInContext("startStream('synthetic','console',false,false)",p.context);
  session.onProvisioned();
  session.onProvisioned();
  assert.equal(calls.player,1);
  session.onReadyToConnect();
  session.onMediaConnected();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.cancel,1);
  assert.equal(calls.auth,1);
  await intervals[0]();
  assert.equal(calls.keepalive,1);
  assert.equal(calls.stop,0);
});

test('host authorization errors are reported instead of leaving an unauthenticated stream',async()=>{
  const p=page(true);
  let stopped=0;
  const session={getSessionId:()=> 'synthetic',waitForState(){},cancelStateWait(){},async stop(){stopped++;}};
  p.context.xCloudPlayer.default.ApiClient=class {async startStream(){return session;}};
  p.context.XwrSignalling={install:()=>s=>s};
  p.context.fetch=async()=>({ok:false,status:503});
  vm.runInContext('startPlayer=async()=>{};',p.context);
  await vm.runInContext("startStream('synthetic','console',false,false)",p.context);
  session.onProvisioned();
  session.onMediaConnected();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,1);
  assert.match(p.nodes.get('stageSub').textContent,/主机授权失败.*503/);
});


test('failed ICE diagnostics remain available before any media connects',async()=>{
  const p=page(true);
  p.context.probePeer={iceConnectionState:'failed',iceGatheringState:'complete',__iceErrors:[701],
    getStats:async()=>new Map([
      ['transport',{id:'transport',type:'transport',dtlsState:'new'}],
      ['pair',{id:'pair',type:'candidate-pair',state:'failed'}],
    ])};
  vm.runInContext('player={_peerConnection:probePeer,_channels:{}};',p.context);
  await vm.runInContext('pollStats()',p.context);
  const panel=p.nodes.get('statsPanel').innerHTML;
  assert.match(panel,/ICE 状态/);
  assert.match(panel,/failed/);
  assert.match(panel,/DTLS 状态/);
  assert.match(panel,/701/);
  assert.match(panel,/0 成功 \/ 1 失败/);
});
