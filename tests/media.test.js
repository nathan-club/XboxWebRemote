'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Media = require('../www/media.js');

const servers = [
  {urls:'stun:stun.example.com:3478'},
  {urls:['turn:relay.example.com:3478?transport=udp', 'turns:relay.example.com:443?transport=tcp'], username:'synthetic', credential:'synthetic'},
];

test('direct mode removes all TURN URLs and relay credentials', () => {
  assert.deepEqual(Media.rtcConfig('direct', servers), {
    iceServers:[{urls:['stun:stun.example.com:3478']}], iceTransportPolicy:'all',
  });
  assert.deepEqual(Media.rtcConfig('direct', [{urls:['stun:stun.example.com', 'turn:relay.example.com'], credential:'secret'}]).iceServers,
    [{urls:['stun:stun.example.com']}]);
});

test('automatic mode permits both direct and relay without changing credentials', () => {
  const config = Media.rtcConfig('auto', servers);
  assert.equal(config.iceTransportPolicy, 'all');
  assert.equal(config.iceServers[1].credential, 'synthetic');
  assert.equal(config.iceServers[1].urls.length, 2);
});

test('relay mode fails before creating a session when no TURN exists', () => {
  assert.throws(()=>Media.rtcConfig('relay', servers.slice(0,1)), /尚未配置中继/);
  assert.equal(Media.rtcConfig('relay', servers).iceTransportPolicy, 'relay');
});

test('direct mode can operate without STUN when local addresses are reachable', () => {
  assert.deepEqual(Media.rtcConfig('direct', []), {iceServers:[], iceTransportPolicy:'all'});
});

test('bookmark overrides browser preference; invalid values use deployment default', () => {
  assert.equal(Media.mode('https://example.com/?mode=direct','relay',{forceRelay:true}), 'direct');
  assert.equal(Media.mode('https://example.com/','direct',{forceRelay:true}), 'direct');
  assert.equal(Media.mode('https://example.com/?mode=invalid','invalid',{forceRelay:true}), 'relay');
  assert.equal(Media.mode('https://example.com/',null,{forceRelay:false}), 'auto');
});

class Peer extends EventTarget {
  iceGatheringState = 'gathering';
  candidate(value) {
    const e = new Event('icecandidate');e.candidate = value;this.dispatchEvent(e);
  }
  complete() {
    this.iceGatheringState = 'complete';this.dispatchEvent(new Event('icegatheringstatechange'));
  }
}
const first = {candidate:'candidate:1 1 udp 1 192.0.2.1 50000 typ host'};
const second = {candidate:'candidate:2 1 udp 2 192.0.2.2 50001 typ relay'};

test('already gathered candidates are retained when ICE has completed', async () => {
  const pc = new Peer();pc.complete();
  assert.deepEqual(await Media.gather(pc, [first]), [first]);
});

test('gather combines existing and later candidates without duplicates', async () => {
  const pc = new Peer();const pending = Media.gather(pc,[first]);
  pc.candidate(first);pc.candidate(second);pc.complete();
  assert.deepEqual(await pending, [first,second]);
});

test('no candidates is an explicit failure rather than an empty exchange', async () => {
  await assert.rejects(Media.gather(new Peer(),[],5), /没有获取到可用网络地址/);
});
