'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XwrLaunch = require('../www/launch.js');

test('ordinary visit waits for user selection', () => {
  const launcher = new XwrLaunch('https://xbox.example.com/');
  assert.equal(launcher.take([{serverId:'F1'}]), null);
});
test('authorized direct link targets exactly one console, once per visit', () => {
  const launcher = new XwrLaunch('https://xbox.example.com/?console=F2');
  const consoles = [{serverId:'F1'}, {serverId:'F2'}];
  // Authorization does not consume the target; it is taken after console discovery.
  assert.equal(launcher.take(consoles), consoles[1]);
  assert.equal(launcher.take(consoles), null);
});
test('unknown console never starts another available console', () => {
  const launcher = new XwrLaunch('https://xbox.example.com/?console=missing');
  assert.equal(launcher.take([{serverId:'F1'}]), null);
  assert.equal(launcher.missing, true);
});
test('bookmarked link survives opening in a new browser session', () => {
  const link = XwrLaunch.link('https://xbox.example.com/?other=1#old', 'F+1');
  assert.equal(link, 'https://xbox.example.com/?console=F%2B1');
  assert.equal(new XwrLaunch(link).take([{serverId:'F+1'}]).serverId, 'F+1');
});
