#!/usr/bin/env python3
"""Read Linux Desktop usage without exporting or persisting its OAuth tokens."""

import base64
import hashlib
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


def select_token(cache, account, now):
    prefix = 'acct:' + account['accountUuid'] + '|'
    marker = ':' + account['organizationUuid'] + ':https://api.anthropic.com:'
    matching = []
    for name, entry in cache.items():
        if not name.startswith(prefix) or marker not in name or not isinstance(entry, dict):
            continue
        scopes = name.split(marker, 1)[1].split()
        if 'user:inference' not in scopes or 'user:profile' not in scopes:
            continue
        if not isinstance(entry.get('token'), str) or not entry['token']:
            continue
        expiry = entry.get('expiresAt')
        if not isinstance(expiry, (int, float)):
            continue
        matching.append((expiry > now, 'user:sessions:claude_code' in scopes, expiry, entry))
    matching.sort(key=lambda item: item[:3], reverse=True)
    return matching[0][3] if matching else None


def decrypt_cache(encoded, password):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7

    encrypted = base64.b64decode(encoded, validate=True)
    if encrypted[:3] != b'v11':
        raise ValueError('unsupported safeStorage backend')
    key = hashlib.pbkdf2_hmac('sha1', password, b'saltysalt', 1, 16)
    decoder = Cipher(algorithms.AES(key), modes.CBC(b' ' * 16)).decryptor()
    padded = decoder.update(encrypted[3:]) + decoder.finalize()
    unpad = PKCS7(128).unpadder()
    return json.loads(unpad.update(padded) + unpad.finalize())


def account_for(options, desktop):
    expected = options.get('accountUuid') or desktop.get('lastKnownAccountUuid')
    if not expected or desktop.get('lastKnownAccountUuid') != expected:
        return None
    paths = [pathlib.Path(options['configDir']) / '.claude.json', pathlib.Path.home() / '.claude.json']
    for file in paths:
        try:
            account = json.loads(file.read_text()).get('oauthAccount', {})
        except (OSError, ValueError, AttributeError):
            continue
        if account.get('accountUuid') == expected and account.get('organizationUuid'):
            return account
    return None


def read_usage(options):
    file = pathlib.Path(options['desktopConfigDir']) / 'config.json'
    try:
        desktop = json.loads(file.read_text())
    except FileNotFoundError:
        return {'ok': False, 'kind': 'no_credentials'}
    account = account_for(options, desktop)
    if not account:
        return {'ok': False, 'kind': 'no_credentials'}
    import dbus

    bus = dbus.SessionBus()
    service = dbus.Interface(bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets'), 'org.freedesktop.Secret.Service')
    _, session = service.OpenSession('plain', dbus.String('', variant_level=1))
    try:
        items, _ = service.SearchItems(dbus.Dictionary({
            'application': 'Claude', 'xdg:schema': 'chrome_libsecret_os_crypt_password_v2',
        }, signature='ss'))
        if not items:
            return {'ok': False, 'kind': 'desktop_keyring_locked'}
        # SearchItems returns unlocked items first. Never issue Unlock: a
        # background sampler must not interrupt the desktop with a prompt.
        secret = dbus.Interface(bus.get_object('org.freedesktop.secrets', items[0]), 'org.freedesktop.Secret.Item').GetSecret(session)
        cache = decrypt_cache(desktop.get('oauth:tokenCacheV2', ''), bytes(secret[2]))
        token = select_token(cache, account, time.time() * 1000)
        if not token:
            return {'ok': False, 'kind': 'no_credentials'}
        if token['expiresAt'] <= time.time() * 1000:
            return {'ok': False, 'kind': 'expired'}
        request = urllib.request.Request(USAGE_URL, headers={
            'Authorization': 'Bearer ' + token['token'], 'anthropic-beta': 'oauth-2025-04-20',
            'Accept': 'application/json', 'User-Agent': 'claude-usage-limits/desktop',
        })
        timeout_ms = options.get('timeoutMs')
        timeout = min(15, max(0.1, timeout_ms / 1000)) if isinstance(timeout_ms, (int, float)) else 15
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    return {'ok': False, 'kind': 'bad_response'}
                usage = json.loads(raw)
                if not isinstance(usage, dict):
                    return {'ok': False, 'kind': 'bad_response'}
                return {'ok': True, 'status': 200, 'utilization': usage,
                        'fetchedAtMs': int(time.time() * 1000), 'accountUuid': account['accountUuid']}
        except urllib.error.HTTPError as error:
            kinds = {401: 'unauthorized', 403: 'forbidden', 429: 'rate_limited'}
            result = {'ok': False, 'status': error.code, 'kind': kinds.get(error.code, 'server' if error.code >= 500 else 'http')}
            retry = error.headers.get('Retry-After', '')
            if retry.isdigit():
                result['retryAfterMs'] = int(retry) * 1000
            return result
        except (urllib.error.URLError, TimeoutError, OSError):
            return {'ok': False, 'kind': 'offline'}
    finally:
        dbus.Interface(bus.get_object('org.freedesktop.secrets', session), 'org.freedesktop.Secret.Session').Close()


def main():
    try:
        result = read_usage(json.load(sys.stdin))
    except ImportError:
        result = {'ok': False, 'kind': 'desktop_dependencies'}
    except Exception as error:
        # Neither cache contents nor exception text may reach logs or stdout.
        kind = 'desktop_keyring_locked' if type(error).__module__.startswith('dbus') else 'bad_response'
        result = {'ok': False, 'kind': kind}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
