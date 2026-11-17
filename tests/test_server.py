import base64
import concurrent.futures
import contextlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patches = patch.multiple(
            server, DATA_DIR=self.temp.name,
            TOKEN_FILE=os.path.join(self.temp.name, 'tokens.json'),
            ACCESS_USER='xbox', ACCESS_PASSWORD='test-password',
            PUBLIC_ORIGIN='https://xbox.example.com', ENABLE_LIVE=False,
            TURN_URL='', TURN_URL_FILE='', TURN_SECRET='', STUN_URLS=[], FORCE_RELAY=False, VIDEO_BITRATE=0,
            _state={key: None for key in server._state}, _xal_flow=None)
        self.patches.start()
        self.addCleanup(self.patches.stop)

    @contextlib.contextmanager
    def http_server(self):
        httpd = server.http.server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield httpd.server_port
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def request(self, port, path, method='GET', body=None, authorized=True, headers=None):
        headers = dict(headers or {})
        if authorized:
            headers['Authorization'] = 'Basic ' + base64.b64encode(b'xbox:test-password').decode()
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_remote_access_requires_password_for_page_and_credential_apis(self):
        with self.http_server() as port:
            for path in ['/', '/api/config', '/api/msal', '/v6/servers/home', '/login-helper.ps1']:
                status, headers, body = self.request(port, path, authorized=False)
                self.assertEqual(status, 401, path)
                self.assertIn('WWW-Authenticate', headers)
                self.assertEqual(body, b'')
            status, _, body = self.request(port, '/api/config')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {'remoteLogin': True, 'liveEnabled': False, 'iceServers': [], 'forceRelay': False, 'videoBitrate': 0})

    def test_config_exposes_configured_stun_without_changing_relay_default(self):
        with patch.multiple(server, STUN_URLS=['stun:stun.example.com:3478']):
            with self.http_server() as port:
                status, _, body = self.request(port, '/api/config')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['iceServers'], [{'urls': ['stun:stun.example.com:3478']}])

    def test_turn_credentials_are_short_lived_and_do_not_expose_shared_secret(self):
        import hmac
        import hashlib
        with patch.multiple(server, TURN_URL='turn:relay.example.com:3478?transport=udp',
                            TURN_SECRET='synthetic-shared-key', FORCE_RELAY=True, VIDEO_BITRATE=1500):
            with self.http_server() as port:
                status, _, body = self.request(port, '/api/config')
        self.assertEqual(status, 200)
        config = json.loads(body)
        ice = config['iceServers'][0]
        expires = int(ice['username'].split(':')[0])
        self.assertLessEqual(abs(expires - time.time() - 3600), 5)
        expected = base64.b64encode(hmac.new(b'synthetic-shared-key', ice['username'].encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(ice['credential'], expected)
        self.assertNotIn(b'synthetic-shared-key', body)
        self.assertTrue(config['forceRelay'])
        self.assertEqual(config['videoBitrate'], 1500)

    def test_turn_address_file_changes_without_restart(self):
        endpoint = Path(self.temp.name) / 'turn-url'
        endpoint.write_text('turn:192.0.2.1:3478?transport=udp')
        with patch.multiple(server, TURN_URL='turn:fallback.example.com:3478',
                            TURN_URL_FILE=str(endpoint), TURN_SECRET='synthetic-key'):
            with self.http_server() as port:
                status, _, body = self.request(port, '/api/config')
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['iceServers'][0]['urls'],
                                 'turn:192.0.2.1:3478?transport=udp')
                replacement = endpoint.with_suffix('.new')
                replacement.write_text('turn:192.0.2.2:3478?transport=udp')
                replacement.replace(endpoint)
                status, _, body = self.request(port, '/api/config')
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['iceServers'][0]['urls'],
                                 'turn:192.0.2.2:3478?transport=udp')

    def test_invalid_turn_address_file_does_not_silently_use_stale_address(self):
        endpoint = Path(self.temp.name) / 'turn-url'
        with patch.multiple(server, TURN_URL='turn:fallback.example.com:3478',
                            TURN_URL_FILE=str(endpoint)):
            with self.assertRaises(FileNotFoundError):
                server.current_turn_url()
            for value in ['', 'https://relay.example.com', 'turn:bad host', 'turn:' + 'a' * 4096]:
                endpoint.write_text(value)
                with self.subTest(value=value[:30]), self.assertRaises(ValueError):
                    server.current_turn_url()

    def test_input_diagnostics_only_accept_anonymous_numeric_state(self):
        state = {'started': True, 'registered': True, 'focused': True,
                 'frames': 100, 'ticks': 100, 'pads': 1, 'buttons': 16, 'axes': 4, 'error': None}
        with self.http_server() as port, patch.object(server, 'log') as logged:
            status, _, _ = self.request(port, '/api/diagnostics/input', 'POST', json.dumps(state))
            self.assertEqual(status, 200)
            self.assertEqual(logged.call_count, 1)
            for invalid in [dict(state, token='private'), dict(state, error='private detail'),
                            dict(state, frames=-1), dict(state, focused='yes')]:
                status, _, _ = self.request(port, '/api/diagnostics/input', 'POST', json.dumps(invalid))
                self.assertEqual(status, 400)
            self.assertEqual(logged.call_count, 1)
            status, _, _ = self.request(port, '/api/diagnostics/input', 'POST', json.dumps(state), authorized=False)
            self.assertEqual(status, 401)

    def test_unauthorized_post_does_not_logout(self):
        server._state['xaluser'] = {'refresh_token': 'retained'}
        with self.http_server() as port:
            status, _, _ = self.request(port, '/api/auth/logout', 'POST', '{}', authorized=False)
        self.assertEqual(status, 401)
        self.assertIsNotNone(server._state['xaluser'])

    def test_cross_site_logout_rejected_and_same_origin_logout_removes_persisted_auth(self):
        server._state['xaluser'] = {'refresh_token': 'retained'}
        server.save_tokens()
        with self.http_server() as port:
            for headers in [{'Origin': 'https://other.example'}, {'Sec-Fetch-Site': 'cross-site'}]:
                status, _, _ = self.request(port, '/api/auth/logout', 'POST', '{}', headers=headers)
                self.assertEqual(status, 403)
                self.assertTrue(Path(server.TOKEN_FILE).exists())
            status, _, _ = self.request(port, '/api/auth/logout', 'POST', '{}',
                                        headers={'Origin': server.PUBLIC_ORIGIN})
        self.assertEqual(status, 200)
        self.assertFalse(Path(server.TOKEN_FILE).exists())
        self.assertTrue(all(value is None for value in server._state.values()))

    def test_live_endpoints_disabled(self):
        with self.http_server() as port:
            for path in ['/live.flv', '/api/live/status']:
                self.assertEqual(self.request(port, path)[0], 404)

    def test_static_files_cannot_escape_web_root(self):
        with self.http_server() as port:
            for path in ['/../server.py', '/%2e%2e/server.py', '/../www-other/tokens.json']:
                self.assertEqual(self.request(port, path)[0], 404, path)
            self.assertEqual(self.request(port, '/')[0], 200)

    def test_proxy_keeps_query_parameters(self):
        def proxy(handler, method, path):
            handler._json({'method': method, 'path': path})
        with patch.object(server.Handler, '_proxy', proxy), self.http_server() as port:
            status, _, body = self.request(port, '/v6/servers/home?mr=50')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['path'], '/v6/servers/home?mr=50')

    def test_tokens_survive_restart_and_have_private_permissions(self):
        server._state['xaluser'] = {'refresh_token': 'persisted', 'expires_at': 0}
        server.save_tokens()
        self.assertEqual(os.stat(server.TOKEN_FILE).st_mode & 0o777, 0o600)
        server._state['xaluser'] = None
        server.load_tokens()
        self.assertEqual(server._state['xaluser']['refresh_token'], 'persisted')
        self.assertEqual(list(Path(self.temp.name).glob('.tokens-*')), [])

    def test_corrupt_token_file_fails_instead_of_silently_forgetting_login(self):
        Path(server.TOKEN_FILE).write_text('{broken')
        with self.assertRaises(json.JSONDecodeError):
            server.load_tokens()

    def test_concurrent_refresh_exchanges_rotating_token_once(self):
        server._state['xaluser'] = {'refresh_token': 'old', 'expires_at': 0}
        def refresh(*args, **kwargs):
            time.sleep(0.02)
            self.assertEqual(kwargs['form']['refresh_token'], 'old')
            return 200, {'access_token': 'new-access', 'refresh_token': 'new-refresh', 'expires_in': 3600}
        with patch.object(server, 'http_json', side_effect=refresh) as http:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: server.xal_user_access(), range(8)))
        self.assertEqual(results, ['new-access'] * 8)
        self.assertEqual(http.call_count, 1)
        self.assertEqual(json.loads(Path(server.TOKEN_FILE).read_text())['xaluser']['refresh_token'], 'new-refresh')

    def test_transient_refresh_failure_preserves_authorization(self):
        server._state['xaluser'] = {'refresh_token': 'old', 'expires_at': 0}
        server.save_tokens()
        with patch.object(server, 'http_json', return_value=(503, {'error': 'temporarily_unavailable'})):
            with self.assertRaises(RuntimeError):
                server.xal_user_access()
        self.assertEqual(server._state['xaluser']['refresh_token'], 'old')
        self.assertEqual(json.loads(Path(server.TOKEN_FILE).read_text())['xaluser']['refresh_token'], 'old')

    def test_revoked_refresh_requires_new_authorization(self):
        server._state['xaluser'] = {'refresh_token': 'revoked', 'expires_at': 0}
        with patch.object(server, 'http_json', return_value=(400, {'error': 'invalid_grant'})):
            with self.assertRaises(RuntimeError):
                server.xal_user_access()
        self.assertIsNone(server._state['xaluser'])
        self.assertNotIn('xaluser', json.loads(Path(server.TOKEN_FILE).read_text()))

    def test_callback_must_match_current_login_without_consuming_flow(self):
        server._xal_flow = {'state': 'expected'}
        with patch.object(server, 'http_json') as http:
            for code in ['bare-code', 'https://bad.example/?code=a&state=expected',
                         server.XAL_APP['RedirectUri'] + '?code=a&state=wrong']:
                with self.assertRaises(ValueError):
                    server.xal_complete_login(code)
                self.assertEqual(server._xal_flow['state'], 'expected')
            http.assert_not_called()

    def test_matching_callback_persists_authorization(self):
        server._xal_flow = {'state': 'expected', 'verifier': 'proof', 'device_token': 'device', 'session_id': 'session'}
        tokens = {'access_token': 'access', 'refresh_token': 'refresh', 'expires_in': 3600}
        with patch.object(server, 'http_json', return_value=(200, tokens)), \
                patch.object(server, '_sisu_authorize'), patch.object(server, 'get_xhome_token'):
            server.xal_complete_login(server.XAL_APP['RedirectUri'] + '?code=a&state=expected')
        self.assertIsNone(server._xal_flow)
        self.assertEqual(json.loads(Path(server.TOKEN_FILE).read_text())['xaluser']['refresh_token'], 'refresh')

    def test_non_loopback_listener_without_password_fails_before_serving(self):
        with patch.multiple(server, HOST='0.0.0.0', ACCESS_PASSWORD=''), \
                patch.object(server, 'handle_auth_code_arg'), patch.object(server, 'load_tokens') as load:
            with self.assertRaisesRegex(ValueError, 'XWR_ACCESS_PASSWORD'):
                server.main()
            load.assert_not_called()


if __name__ == '__main__':
    unittest.main()
