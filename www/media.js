'use strict';

const XwrMedia = {
  modes: ['auto', 'direct', 'relay'],

  mode(href, saved, config) {
    const requested = new URL(href).searchParams.get('mode');
    const mode = [requested, saved, config.forceRelay ? 'relay' : 'auto']
      .find(value => this.modes.includes(value));
    return mode;
  },

  rtcConfig(mode, iceServers) {
    if (!this.modes.includes(mode)) throw new Error('未知连接方式');
    const servers = (iceServers || []).flatMap(server => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
        .filter(url => typeof url === 'string' &&
          (mode !== 'direct' || /^stuns?:/i.test(url)));
      return urls.length ? [mode === 'direct' ? {urls} : {...server, urls}] : [];
    });
    if (mode === 'relay' && !servers.some(server => server.urls.some(url => /^turns?:/i.test(url)))) {
      throw new Error('尚未配置中继，请选择自动或仅直连');
    }
    return {iceServers: servers, iceTransportPolicy: mode === 'relay' ? 'relay' : 'all'};
  },

  inputReady(player) {
    const channels = player && player._channels;
    return !!(channels && channels.message && channels.message._handshakeCompleted &&
      channels.control && channels.control._dataChannel &&
      channels.control._dataChannel.readyState === 'open' &&
      channels.input && channels.input._dataChannel &&
      channels.input._dataChannel.readyState === 'open');
  },

  ensureGamepad(player, gamepad) {
    if (!this.inputReady(player)) return false;
    const control = player._channels.control;
    if (control.getGamepadHandlers()[0] !== gamepad) {
      // Authorization clears slot zero. Re-register without duplicating listeners.
      if (gamepad._player === player) control.sendGamepadState(0, true, gamepad);
      else gamepad.attach(player);
    }
    return control.getGamepadHandlers()[0] === gamepad;
  },

  // The vendor ICE helper starts listening before createOffer. Seed from that
  // collection so candidates gathered before this function runs are not lost.
  gather(pc, existing, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const candidates = new Map();
      const add = candidate => {
        if (candidate && candidate.candidate) candidates.set(candidate.candidate, candidate);
      };
      existing.forEach(add);
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        pc.removeEventListener('icecandidate', onCandidate);
        pc.removeEventListener('icegatheringstatechange', onState);
      };
      const finish = () => {
        cleanup();
        if (!candidates.size) reject(new Error('没有获取到可用网络地址，请检查 UDP 或中继服务'));
        else resolve([...candidates.values()]);
      };
      const onCandidate = event => add(event.candidate);
      const onState = () => { if (pc.iceGatheringState === 'complete') finish(); };
      pc.addEventListener('icecandidate', onCandidate);
      pc.addEventListener('icegatheringstatechange', onState);
      timer = setTimeout(finish, timeoutMs);
      if (pc.iceGatheringState === 'complete') finish();
    });
  },
};

if (typeof module !== 'undefined') module.exports = XwrMedia;
