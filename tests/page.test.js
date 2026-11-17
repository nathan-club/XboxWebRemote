'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function page(authenticated) {
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
    document:{getElementById:element, querySelectorAll:()=>[], addEventListener(){}},
    localStorage:{getItem:()=>null, setItem(){}},
    navigator:{}, addEventListener(){}, setTimeout:()=>1, clearTimeout(){},
    setInterval:()=>1, clearInterval(){},
    fetch:async url => {
      requests.push(url);
      const body = url === '/api/config' ? {remoteLogin:true, liveEnabled:false}
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
