'use strict';

// 每次打开直达链接只自动发起一次；断开、刷新列表不会再次唤醒主机。
class XwrLaunch {
  constructor(href) {
    this.target = new URL(href).searchParams.get('console');
    this.consumed = false;
    this.missing = false;
  }

  take(consoles) {
    if (!this.target || this.consumed) return null;
    this.consumed = true;
    const console = consoles.find(c => c.serverId === this.target);
    this.missing = !console;
    return console || null;
  }

  static link(href, serverId) {
    const url = new URL(href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('console', serverId);
    return url.href;
  }
}

if (typeof module !== 'undefined') module.exports = XwrLaunch;
