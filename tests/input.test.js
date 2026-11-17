'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const media = require('../www/media.js');

function fixture() {
  const listeners = new Map();
  const pad = {index:2, buttons:Array.from({length:17},()=>({value:0})), axes:[0,0,0,0]};
  const context = {console:{log(){}}, navigator:{getGamepads:()=>[null,null,pad]},
    setInterval:()=>1, clearInterval(){},
    addEventListener:(name,fn)=>{if(!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(fn);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
  context.window=context;
  vm.createContext(context);
  // Expose the bundled module loader only in this test; exercise the actual
  // vendor authorization and Gamepad implementations without a browser/network.
  const source=fs.readFileSync(require.resolve('../www/lib/xCloudPlayer.min.js'),'utf8')
    .replace('return e[i].call(o.exports,o,o.exports,n),o.exports',
      'globalThis.vendorRequire=n;return e[i].call(o.exports,o,o.exports,n),o.exports');
  vm.runInContext(source, context);
  const Control=context.vendorRequire(269).default;
  const Gamepad=context.vendorRequire(552).default;
  const control=Object.create(Control.prototype);
  const sent=[];
  control._gamepadHandlers={};
  control.send=message=>sent.push(JSON.parse(message));
  control._dataChannel={readyState:'open'};
  const player={_config:{keyframe_interval:0}, _channels:{control,
    input:{_dataChannel:{readyState:'open'}}, message:{_handshakeCompleted:false}}};
  control.getPlayer=()=>player;
  return {player,control,gamepad:new Gamepad(0,{enable_keyboard:true}),listeners,sent,pad};
}

test('vendor authorization really clears a prematurely registered controller',()=>{
  const f=fixture();
  f.gamepad.attach(f.player);
  assert.equal(f.control.getGamepadHandlers()[0],f.gamepad);
  f.control.sendAuthorization();
  assert.equal(f.control.getGamepadHandlers()[0],undefined);
});

test('wait for handshake and both channels then register once and emit physical input',()=>{
  const f=fixture();
  assert.equal(media.ensureGamepad(f.player,f.gamepad),false);
  assert.equal(f.sent.length,0);
  f.control.sendAuthorization();
  f.player._channels.message._handshakeCompleted=true;
  f.player._channels.input._dataChannel.readyState='connecting';
  assert.equal(media.ensureGamepad(f.player,f.gamepad),false);
  f.player._channels.input._dataChannel.readyState='open';
  assert.equal(media.ensureGamepad(f.player,f.gamepad),true);
  assert.equal(f.gamepad.getPhysicalGamepadId(),2);
  f.pad.buttons[0].value=1;
  assert.equal(f.gamepad.getGamepadState().A,1);
  const count=f.sent.length;
  assert.equal(media.ensureGamepad(f.player,f.gamepad),true);
  assert.equal(f.sent.length,count);
  assert.equal(f.listeners.get('keydown').size,1);
});

test('registration cleared by later authorization is restored without listener leaks',()=>{
  const f=fixture();
  f.player._channels.message._handshakeCompleted=true;
  media.ensureGamepad(f.player,f.gamepad);
  f.control.sendAuthorization();
  assert.equal(media.ensureGamepad(f.player,f.gamepad),true);
  assert.equal(f.listeners.get('keydown').size,1);
  f.gamepad.detach();
  assert.equal(f.listeners.get('keydown').size,0);
});

test('failed attachment propagates and can be retried',()=>{
  const f=fixture();
  f.player._channels.message._handshakeCompleted=true;
  const attach=f.gamepad.attach;
  f.gamepad.attach=()=>{throw new Error('attach failure');};
  assert.throws(()=>media.ensureGamepad(f.player,f.gamepad),/attach failure/);
  f.gamepad.attach=attach;
  assert.equal(media.ensureGamepad(f.player,f.gamepad),true);
});
