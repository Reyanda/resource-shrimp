"""
Resource Shrimp API Vault
Stores API keys encrypted with a master password.
Uses PBKDF2 key derivation + Fernet symmetric encryption.
"""
import os
import json
import hashlib
import hmac
import base64
import secrets
import time
from pathlib import Path

# ── Fernet implementation (subset, stdlib only) ─────────────────────
# Fernet = AES-128-CBC + HMAC-SHA256 + timestamp + padding
# We implement it with the `cryptography` package which we install
# as a build dep alongside yt-dlp.

try:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False


class Vault:
    def __init__(self, vault_path=None):
        self.vault_path = vault_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '.vault.json'
        )
        self._key = None
        self._fernet = None
        self._data = {'keys': {}, 'salt': None, 'verify': None}

    def _derive_key(self, password, salt):
        if not HAS_CRYPTO:
            # Fallback: PBKDF2-HMAC-SHA256 via hashlib, key = raw bytes
            return hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 480000)
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=480000,
        )
        return base64.urlsafe_b64encode(kdf.derive(password.encode()))

    def _load(self):
        if os.path.exists(self.vault_path):
            with open(self.vault_path, 'r') as f:
                self._data = json.load(f)

    def _save(self):
        # Atomic write
        tmp = self.vault_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(self._data, f, indent=2)
        os.replace(tmp, self.vault_path)
        # Restrict permissions
        try:
            os.chmod(self.vault_path, 0o600)
        except OSError:
            pass

    def unlock(self, password):
        """Unlock vault with master password. Returns True if OK."""
        self._load()
        salt = self._data.get('salt')
        verify = self._data.get('verify')

        if not salt or not verify:
            # First time — create vault
            salt = secrets.token_bytes(16)
            self._data['salt'] = base64.b64encode(salt).decode()
            key = self._derive_key(password, salt)
            self._fernet = Fernet(key) if HAS_CRYPTO else None
            self._key = key
            # Store verification hash
            self._data['verify'] = hashlib.sha256(
                (password + self._data['salt']).encode()
            ).hexdigest()
            self._save()
            return True

        # Verify password
        salt = base64.b64decode(salt)
        check = hashlib.sha256(
            (password + self._data['salt']).encode()
        ).hexdigest()
        if not hmac.compare_digest(check, verify):
            return False

        key = self._derive_key(password, salt)
        self._fernet = Fernet(key) if HAS_CRYPTO else None
        self._key = key
        return True

    def is_unlocked(self):
        return self._key is not None

    def _encrypt(self, plaintext):
        if self._fernet:
            return self._fernet.encrypt(plaintext.encode()).decode()
        # Fallback: XOR-based obfuscation (NOT secure, placeholder)
        return base64.b64encode(plaintext.encode()).decode()

    def _decrypt(self, ciphertext):
        if self._fernet:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        return base64.b64decode(ciphertext.encode()).decode()

    def add_key(self, provider, api_key, label=None):
        """Store an API key for a provider (openai, anthropic, etc.)"""
        if not self.is_unlocked():
            raise RuntimeError("Vault locked")
        provider = provider.lower().strip()
        if provider not in ('openai', 'anthropic', 'google', 'groq', 'openrouter',
                            'deepseek', 'glm', 'kimi', 'custom'):
            raise ValueError(f"Unknown provider: {provider}")
        entry = {
            'key': self._encrypt(api_key),
            'label': label or provider,
            'added': time.time(),
            'last_tested': None,
            'status': 'untested',
        }
        self._data.setdefault('keys', {})[provider] = entry
        self._save()
        return True

    def get_key(self, provider):
        """Retrieve decrypted API key for a provider."""
        if not self.is_unlocked():
            raise RuntimeError("Vault locked")
        entry = self._data.get('keys', {}).get(provider.lower())
        if not entry:
            return None
        return self._decrypt(entry['key'])

    def remove_key(self, provider):
        """Remove stored key for a provider."""
        keys = self._data.get('keys', {})
        keys.pop(provider.lower(), None)
        self._save()
        return True

    def list_keys(self):
        """List stored providers (no key values exposed)."""
        result = {}
        for prov, entry in self._data.get('keys', {}).items():
            result[prov] = {
                'label': entry.get('label', prov),
                'added': entry.get('added'),
                'status': entry.get('status', 'untested'),
                'last_tested': entry.get('last_tested'),
            }
        return result

    def mark_tested(self, provider, status):
        """Mark a key as tested (valid/invalid)."""
        entry = self._data.get('keys', {}).get(provider.lower())
        if entry:
            entry['status'] = status
            entry['last_tested'] = time.time()
            self._save()

    def verify_key_openai(self, provider='openai'):
        """Quick validation: make a tiny API call."""
        key = self.get_key(provider)
        if not key:
            return False, 'No key stored'
        try:
            from urllib.request import urlopen, Request
            from urllib.error import HTTPError
            req = Request(
                'https://api.openai.com/v1/models',
                headers={'Authorization': f'Bearer {key}'}
            )
            with urlopen(req, timeout=10) as r:
                if r.status == 200:
                    self.mark_tested(provider, 'valid')
                    return True, 'Valid'
        except HTTPError as e:
            if e.code == 401:
                self.mark_tested(provider, 'invalid')
                return False, 'Invalid key'
            self.mark_tested(provider, 'error')
            return False, f'HTTP {e.code}'
        except Exception as e:
            self.mark_tested(provider, 'error')
            return False, str(e)
        return False, 'Unknown error'

    def verify_key_anthropic(self, provider='anthropic'):
        key = self.get_key(provider)
        if not key:
            return False, 'No key stored'
        try:
            from urllib.request import urlopen, Request
            from urllib.error import HTTPError
            req = Request(
                'https://api.anthropic.com/v1/messages',
                headers={
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                data=json.dumps({
                    'model': 'claude-3-haiku-20240307',
                    'max_tokens': 1,
                    'messages': [{'role': 'user', 'content': 'hi'}]
                }).encode(),
                method='POST'
            )
            with urlopen(req, timeout=15) as r:
                if r.status == 200:
                    self.mark_tested(provider, 'valid')
                    return True, 'Valid'
        except HTTPError as e:
            if e.code == 401:
                self.mark_tested(provider, 'invalid')
                return False, 'Invalid key'
            # 400 = valid key but bad request format — still valid
            if e.code == 400:
                self.mark_tested(provider, 'valid')
                return True, 'Valid'
            self.mark_tested(provider, 'error')
            return False, f'HTTP {e.code}'
        except Exception as e:
            self.mark_tested(provider, 'error')
            return False, str(e)
        return False, 'Unknown error'


# Singleton
_vault = None

def get_vault():
    global _vault
    if _vault is None:
        _vault = Vault()
    return _vault
