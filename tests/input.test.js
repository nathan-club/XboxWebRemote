'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const media = require('../www/media.js');
const Input = require('../www/input.js');

function fixture() {
  const listeners = new Map(), timers=[];
  const pad = {index:2, buttons:Array.from({length:17},()=>({value:0})), axes:[0,0,0,0]};
  const context = {console:{log(){},warn(){}}, performance:{now:()=>100},
    setTimeout:(fn)=>{const timer={fn};timers.push(timer);return timer;},
    clearTimeout:timer=>{if(timer) timer.cancelled=true;}, navigator:{getGamepads:()=>[null,null,pad]},
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
  control._dataChannel=Object.assign(new EventTarget(),{readyState:'open'});
  const player={_config:{keyframe_interval:0}, _channels:{control,
    input:{_dataChannel:{readyState:'open'}}, message:{_handshakeCompleted:false}}};
  control.getPlayer=()=>player;
  const VendorInput=context.vendorRequire(8).default, Queue=context.vendorRequire(612).default;
  const input=Object.create(VendorInput.prototype), packets=[];
  input.getPlayer=()=>player;
  input._inputQueue=new Queue(player);
  input._dataChannel=Object.assign(new EventTarget(),{readyState:'open'});
  input.send=buffer=>packets.push(new Uint8Array(buffer.buffer || buffer));
  player._channels.input=input;
  return {player,control,input,packets,context,timers,
    tick(){let timer;do{timer=timers.shift();}while(timer && timer.cancelled);if(timer) timer.fn();},
    gamepad:new Gamepad(0,{enable_keyboard:true}),listeners,sent,pad};
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


test('real vendor loop dies on a controller without Guide button',()=>{
  const f=fixture();f.pad.buttons.length=16;
  f.gamepad.attach(f.player);
  f.input.start();
  assert.throws(()=>f.tick(),/value/);
  assert.equal(f.timers.length,0);
});

function installInput(f) {
  const errors=[];
  const state=Input.install(f.player,{schedule:f.context.setTimeout,cancel:f.context.clearTimeout,onError:e=>errors.push(e)});
  Input.prepareGamepad(f.gamepad,{pads:()=>[null,null,f.pad],focused:()=>true});
  return {state,errors};
}

test('16-button pad and keyboard both produce serialized packets without video metadata',()=>{
  const f=fixture();f.pad.buttons.length=16;
  const {state,errors}=installInput(f);
  f.player._channels.message._handshakeCompleted=true;
  media.ensureGamepad(f.player,f.gamepad);
  f.input.start();f.tick();
  assert.equal(state.frames,1);assert.equal(f.packets.length,2);
  assert.equal(f.packets[1][0]&2,2); // Gamepad report flag
  const key={key:'ArrowUp',preventDefault(){}};
  f.listeners.get('keydown').forEach(handler=>handler(key));
  assert.equal(f.gamepad.getGamepadState().DPadUp,1);
  f.tick();assert.equal(state.frames,2);assert.equal(f.packets.length,3);
  f.pad.buttons[0].value=1;assert.equal(f.gamepad.getGamepadState().A,1);
  assert.deepEqual(errors,[]);
});

test('native frame queue waits for rendered video unless explicitly flushed',()=>{
  const f=fixture();f.gamepad.attach(f.player);
  f.input.queueGamepadFrames([f.gamepad.getGamepadState()]);
  assert.equal(f.packets.length,0);
  f.input.queueGamepadFrames([f.gamepad.getGamepadState()],true);
  assert.equal(f.packets.length,1);
  assert.equal(f.input._inputQueue._gamepadQueue.length,0);
});

test('start waits for both channels and duplicate handshakes cannot create extra loops',()=>{
  const f=fixture();const {state}=installInput(f);
  f.player._channels.message._handshakeCompleted=true;
  f.input._dataChannel.readyState='connecting';
  f.input.start();f.input.start();assert.equal(state.started,false);
  f.input._dataChannel.readyState='open';f.input._dataChannel.dispatchEvent(new Event('open'));
  assert.equal(state.started,true);assert.equal(f.packets.length,1);assert.equal(f.timers.length,1);
  f.input.start();assert.equal(f.timers.length,1);
});

test('destroy stops the loop and late channel opens cannot restart it',()=>{
  const f=fixture();const {state}=installInput(f);
  f.player._channels.message._handshakeCompleted=true;
  f.input.start();f.input.destroy();f.tick();
  assert.equal(state.stopped,true);assert.equal(state.ticks,0);
  f.input._dataChannel.dispatchEvent(new Event('open'));f.input.start();
  assert.equal(f.packets.length,1);assert.equal(f.timers.length,0);
});

test('focus and controller slot are refreshed from current browser state',()=>{
  const f=fixture();let focused=false;
  Input.prepareGamepad(f.gamepad,{pads:()=>[null,null,f.pad],focused:()=>focused});
  f.gamepad.attach(f.player);
  assert.equal(f.gamepad.getGamepadState().A,0); // Release once on loss of focus
  assert.equal(f.gamepad.getGamepadState(),undefined);
  focused=true;assert.ok(f.gamepad.getGamepadState());
  f.gamepad._physicalGamepadId=7;
  assert.ok(f.gamepad.getGamepadState());assert.equal(f.gamepad.getPhysicalGamepadId(),2);
});

test('missing axes and transient nonfinite values cannot corrupt input frames',()=>{
  const f=fixture();f.pad.axes=[NaN];f.pad.buttons.length=16;f.pad.buttons[0].value=NaN;
  Input.prepareGamepad(f.gamepad,{pads:()=>[null,null,f.pad],focused:()=>true});
  f.gamepad.attach(f.player);
  const frame=f.gamepad.getGamepadState();
  assert.equal(frame.A,0);assert.equal(frame.Nexus,0);
  assert.ok(Object.values(frame).every(Number.isFinite));
});

test('unexpected loop errors are surfaced and cannot appear as healthy input',()=>{
  const f=fixture();const {state,errors}=installInput(f);
  f.gamepad.getGamepadState=()=>{throw new Error('synthetic failure');};
  f.player._channels.message._handshakeCompleted=true;media.ensureGamepad(f.player,f.gamepad);
  f.input.start();f.tick();
  assert.equal(errors.length,1);assert.equal(state.error,'Error');assert.equal(f.timers.length,0);
});

test('keyboard-only input sends immediately when no physical controller is connected',()=>{
  const f=fixture();const {state}=installInput(f);
  f.context.navigator.getGamepads=()=>[];
  Input.prepareGamepad(f.gamepad,{pads:()=>[],focused:()=>true});
  f.player._channels.message._handshakeCompleted=true;
  media.ensureGamepad(f.player,f.gamepad);
  f.listeners.get('keydown').forEach(handler=>handler({key:'Enter',preventDefault(){}}));
  assert.equal(f.gamepad.getGamepadState().A,1);
  f.input.start();f.tick();
  assert.equal(state.frames,1);assert.equal(f.packets.length,2);
});


test('reconnect prefers the standard controller when browser exposes multiple pads',()=>{
  const f=fixture();
  const virtual={index:1,mapping:'',buttons:Array.from({length:16},()=>({value:0})),axes:[0,0,0,0,0,0]};
  const standard={index:2,mapping:'standard',buttons:Array.from({length:17},()=>({value:0})),axes:[0,0,0,0]};
  const pads=()=>[virtual,standard];
  Input.prepareGamepad(f.gamepad,{pads,focused:()=>true});
  f.gamepad._physicalGamepadId=1;
  f.gamepad.attach(f.player);
  assert.equal(f.gamepad.getGamepadState().GamepadIndex,0);
  assert.equal(f.gamepad.getPhysicalGamepadId(),1);
  assert.equal(f.gamepad.getGamepad(1).index,2);
});

test('standard mapping remains selected after a new session replaces the old pad list',()=>{
  const f=fixture();let current=[{index:0,mapping:'',buttons:Array.from({length:16},()=>({value:0})),axes:[0,0,0,0,0,0]}];
  Input.prepareGamepad(f.gamepad,{pads:()=>current,focused:()=>true});
  f.gamepad._physicalGamepadId=0;f.gamepad.attach(f.player);assert.equal(f.gamepad.getPhysicalGamepadId(),0);
  current=[{index:0,mapping:'',buttons:Array.from({length:16},()=>({value:0})),axes:[0,0,0,0,0,0]}, {index:1,mapping:'standard',buttons:Array.from({length:17},()=>({value:0})),axes:[0,0,0,0]}];
  assert.ok(f.gamepad.getGamepadState());assert.equal(f.gamepad.getPhysicalGamepadId(),1);
});
