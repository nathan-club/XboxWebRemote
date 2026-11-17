'use strict';

// Reject gateway errors before the vendor library starts polling for a reply.
const XwrSignalling = {
  install(client, {requestTimeout = 45000, pollTimeout = 60000, interval = 1000} = {}) {
    const controllers = new Set();
    let stopped = false;
    const request = async (method, path, body, headers = {}) => {
      if (stopped && method !== 'DELETE') throw new Error('会话已停止');
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      try {
        const response = await fetch(client.getBaseHost() + path, {
          method, signal: controller.signal, body,
          headers: {Accept:'application/json', 'Content-Type':'application/json',
            'X-MS-Device-Info':client.getDeviceInfo(), ...headers},
        });
        if (!response.ok) {
          // Don't expose upstream response bodies containing session details or tokens.
          throw new Error(`${method} ${path.split('/').pop()} 失败（HTTP ${response.status}）`);
        }
        if (response.status === 204) return {status:204};
        const text = await response.text();
        // SDP/ICE submissions and DELETE may acknowledge with an empty 202.
        if (!text.trim()) {
          if (method !== 'GET') return {status:response.status};
          throw new Error(`GET ${path.split('/').pop()} 返回空响应（HTTP ${response.status}）`);
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${method} ${path.split('/').pop()} 返回无效 JSON（HTTP ${response.status}）`);
        }
      } catch (error) {
        if (controller.signal.aborted) throw new Error('信令请求超时或会话已停止');
        throw error;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    };
    client.get = (path, headers) => request('GET', path, undefined, headers);
    client.post = (path, body, headers) => request('POST', path, body, headers);
    client.delete = (path, headers) => request('DELETE', path, undefined, headers);

    return session => {
      let generation = 0;
      const delay = () => new Promise(resolve => setTimeout(resolve, interval));
      const wait = async endpoint => {
        const deadline = Date.now() + pollTimeout;
        while (!stopped && Date.now() < deadline) {
          const reply = await client.get(session.getSessionPath() + '/' + endpoint);
          if (stopped) throw new Error('会话已停止');
          if (reply.status !== 204) return reply;
          await delay();
        }
        throw new Error(stopped ? '会话已停止' : `${endpoint.toUpperCase()} 回复超时，请断开后重新连接`);
      };
      session.waitForSdpResponse = () => wait('sdp');
      session.waitForIceResponse = () => wait('ice');
      session.waitForState = target => {
        const current = ++generation;
        const deadline = Date.now() + (target === 'Provisioned' ? 300000 : pollTimeout);
        const poll = async () => {
          while (!stopped && current === generation && Date.now() < deadline) {
            const state = await session.refreshState();
            if (state === target || stopped || current !== generation) return;
            if (state === 'Failed' || state === 'Terminated') throw new Error('串流会话已终止');
            await delay();
          }
          if (!stopped && current === generation) throw new Error('等待主机状态超时');
        };
        return poll().catch(error => { if (!stopped) session.onSignallingError(error); });
      };
      session.onSignallingError = () => {};
      const stop = session.stop.bind(session);
      session.stop = () => {
        stopped = true;
        generation++;
        for (const controller of controllers) controller.abort();
        return stop();
      };
      return session;
    };
  },
};

if (typeof module !== 'undefined') module.exports = XwrSignalling;
