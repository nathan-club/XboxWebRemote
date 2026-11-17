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
  vm.runInContext(fs.readFileSync(path.join(root, 'quality.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  vm.runInContext(js, context);
  vm.runInContext('const originalStartFlow=startFlow; startFlow = captureStart; renderConsoles = ()=>{};', context);
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


test('automatic launch picks the bounded high profile; manual selection bypasses calibration',async()=>{
  const p=page(true,{videoBitrate:8000});
  p.context.captureStream=async()=>{};
  vm.runInContext('startStream=captureStream;',p.context);
  await vm.runInContext("originalStartFlow({serverId:'synthetic',powerState:'On'})",p.context);
  assert.equal(vm.runInContext('effectiveBitrate',p.context),8000);
  assert.equal(vm.runInContext('quality',p.context),'1080p');
  assert.equal(vm.runInContext('qualityTuner.done',p.context),false);
  vm.runInContext("autoQuality=false;quality='1440p';",p.context);
  await vm.runInContext("originalStartFlow({serverId:'synthetic',powerState:'On'})",p.context);
  assert.equal(vm.runInContext('qualityTuner',p.context),null);
  assert.equal(vm.runInContext('quality',p.context),'1440p');
});

function adjustingPage() {
  const p=page(true);
  const calls=[];
  p.context.oldSession={async stop(){calls.push('stop');}};
  p.context.oldPlayer={destroy(){calls.push('destroy');}};
  p.context.oldGamepad={detach(){calls.push('detach');}};
  p.context.captureStream=async()=>{calls.push('start');};
  p.context.fetch=async url=>{
    assert.equal(url,'/api/config');calls.push('config');
    return {ok:true,json:async()=>({videoBitrate:8000})};
  };
  vm.runInContext(`currentConsole={serverId:'synthetic',deviceName:'console'};
    qualityTuner=new XwrQuality(8000);qualityTuner.index=1;
    stream=oldSession;player=oldPlayer;window.__gp0=oldGamepad;
    startStream=captureStream;refreshConsoles=()=>{};`,p.context);
  return {...p,calls};
}

test('calibration closes the old player and awaits remote stop before starting a lower profile',async()=>{
  const p=adjustingPage();
  await vm.runInContext('adjustQuality()',p.context);
  assert.deepEqual(p.calls,['detach','destroy','stop','config','start']);
  assert.equal(vm.runInContext('effectiveBitrate',p.context),4000);
  assert.equal(vm.runInContext('quality',p.context),'720p');
});

test('user disconnect cancels calibration while remote cleanup is in flight',async()=>{
  const p=adjustingPage();let finish;
  p.context.oldSession.stop=()=>new Promise(resolve=>{finish=resolve;});
  const adjusting=vm.runInContext('adjustQuality()',p.context);
  await vm.runInContext('backToConsoles()',p.context);
  finish();await adjusting;
  assert.equal(p.calls.includes('start'),false);
  assert.equal(vm.runInContext('qualityTuner',p.context),null);
});

test('remote stop failure ends calibration rather than creating another session',async()=>{
  const p=adjustingPage();
  p.context.oldSession.stop=async()=>{throw new Error('stop rejected');};
  await vm.runInContext('adjustQuality()',p.context);
  assert.equal(p.calls.includes('start'),false);
  assert.equal(p.nodes.get('stageTitle').textContent,'画质调整失败');
  assert.match(p.nodes.get('stageSub').textContent,/stop rejected/);
});

test('a session created after the user disconnects is immediately stopped',async()=>{
  const p=page(true);let finish,stops=0;
  p.context.xCloudPlayer.default.ApiClient=class {startStream(){return new Promise(resolve=>{finish=resolve;});}};
  p.context.XwrSignalling={install:()=>()=>{throw new Error('Stale session attached');}};
  const pending=vm.runInContext("startStream('synthetic','console',false,false)",p.context);
  vm.runInContext('flowGeneration++;',p.context);
  finish({async stop(){stops++;}});
  await pending;
  assert.equal(stops,1);
  assert.equal(vm.runInContext('stream',p.context),null);
});

test('missing browser metrics cannot leave the calibration overlay stuck forever',async()=>{
  const p=page(true),timers=[];
  p.context.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
  let stateChanged;
  p.context.xCloudPlayer.default.Player=class {
    constructor(){
      this._peerConnection={connectionState:'connected',iceConnectionState:'connected',
        setConfiguration(){},addEventListener(){},getStats:async()=>new Map()};
      this._channels={message:{sendConfig(){}}};
    }
    onConnectionStateChange(fn){stateChanged=fn;}
    setChatSdpHandler(){}
    createOffer(){return new Promise(()=>{});}
  };
  vm.runInContext('qualityTuner=new XwrQuality(8000);stream={onMediaConnected(){}};startPlayer();',p.context);
  stateChanged('connected');
  assert.equal(vm.runInContext('qualityTuner.done',p.context),false);
  timers.find(t=>t.ms===30000).fn();
  assert.equal(vm.runInContext('qualityTuner.done',p.context),true);
  assert.equal(vm.runInContext('qualityTuner.label',p.context),'统计不足，保留当前档位');
  assert.equal(p.nodes.get('stageMsg').style.display,'none');
});


test('a fresh lower server cap takes precedence during automatic adjustment',async()=>{
  const p=adjustingPage();
  p.context.fetch=async()=>({ok:true,json:async()=>({videoBitrate:1500})});
  await vm.runInContext('adjustQuality()',p.context);
  assert.equal(vm.runInContext('effectiveBitrate',p.context),1500);
  assert.equal(vm.runInContext('quality',p.context),'720p');
});

test('a late offer result cannot act on a replacement session',async()=>{
  const p=page(true);let finish;
  p.context.xCloudPlayer.default.Player=class {
    constructor(){this._peerConnection={setConfiguration(){},addEventListener(){},getStats:async()=>new Map()};this._channels={message:{sendConfig(){}}};}
    onConnectionStateChange(){}
    setChatSdpHandler(){}
    createOffer(){return new Promise(resolve=>{finish=resolve;});}
    getIceCandidates(){throw new Error('Stale offer resumed');}
  };
  vm.runInContext('stream={};',p.context);
  const pending=vm.runInContext('startPlayer()',p.context);
  vm.runInContext('stream={};',p.context);
  finish({sdp:'synthetic'});
  await pending;
});
