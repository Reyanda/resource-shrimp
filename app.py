#!/usr/bin/env python3
"""Resource Shrimp — zero-dependency server. stdlib only."""

import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import hashlib
import secrets
import base64
import html
from datetime import datetime
from urllib.parse import urlparse, parse_qs, quote, unquote
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import mimetypes
import http.cookies
import providers
import library
import gdrive
import ai
import searchstrat
import vault as _vault_mod

PORT = int(os.environ.get("PORT", 8080))
BASE = os.path.dirname(os.path.abspath(__file__))
TEMP_ROOT = tempfile.mkdtemp(prefix="rshrimp_")

# Persistent per-user library (sandbox + searchable index)
library.init()

# ── In-memory state (replaces Flask globals) ────────────────────────
downloads = {}          # id -> dict
downloads_lock = threading.Lock()
ACTIVE_DOWNLOADS = 0
MAX_CONCURRENT = 5
MAX_URL_LEN = 2048

# ── Rate limiter ────────────────────────────────────────────────────
# Separate buckets: reads (status polling + library browsing) need a high
# ceiling; starting a new download is the expensive action and stays tight.
_rate = {}  # (bucket, ip) -> [timestamps]
RATE_LIMIT = 600         # read requests per window (status polling + browsing)
RATE_WINDOW = 60         # seconds
DOWNLOAD_LIMIT = 20      # new downloads per window

def rate_check(ip, bucket="read", limit=RATE_LIMIT, window=RATE_WINDOW):
    now = time.time()
    key = (bucket, ip)
    _rate.setdefault(key, [])
    _rate[key] = [t for t in _rate[key] if now - t < window]
    if len(_rate[key]) >= limit:
        return False
    _rate[key].append(now)
    return True

# ── Session cookie (anonymous; becomes Google identity in Phase B) ──
COOKIE_NAME = "rs_session"

def get_session(handler):
    raw = handler.headers.get("Cookie")
    if raw:
        try:
            jar = http.cookies.SimpleCookie(raw)
            if COOKIE_NAME in jar:
                return sanitize_id(jar[COOKIE_NAME].value)
        except Exception:
            pass
    return None

def new_session():
    return secrets.token_urlsafe(16)

def session_cookie(sid):
    return f"{COOKIE_NAME}={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"

# ── Google OAuth state (CSRF) + access-token helper ─────────────────
_oauth_states = {}        # state -> (session, created_ts, extra)
_oauth_lock = threading.Lock()
OAUTH_STATE_TTL = 600     # seconds

# Launcher origins allowed to receive a login profile back from OAuth.
DEFAULT_LOGIN_RETURN = "https://reyanda.github.io/"
LOGIN_RETURN_ALLOW = {
    "https://reyanda.github.io/",
    "https://reyanda.github.io",
}

def oauth_new_state(session, extra=None):
    state = secrets.token_urlsafe(24)
    now = time.time()
    with _oauth_lock:
        # opportunistic prune of expired states
        for s in [k for k, (_, ts, _e) in _oauth_states.items() if now - ts > OAUTH_STATE_TTL]:
            _oauth_states.pop(s, None)
        _oauth_states[state] = (session, now, extra or {})
    return state

def oauth_take_state(state):
    """Consume a state token, returning (session, extra) or (None, None)."""
    with _oauth_lock:
        entry = _oauth_states.pop(state, None)
    if not entry:
        return None, None
    session, ts, extra = entry
    if time.time() - ts > OAUTH_STATE_TTL:
        return None, None
    return session, extra

def google_access_token(session):
    """Return a valid access token for the session, refreshing if needed."""
    auth = library.get_google(session)
    if not auth or not auth.get("access_token"):
        return None
    if auth.get("expiry", 0) > time.time() + 60:
        return auth["access_token"]
    # expired — refresh
    if not auth.get("refresh_token"):
        return None
    try:
        tok = gdrive.refresh(auth["refresh_token"])
    except Exception as e:
        print(f"[gdrive] refresh failed: {e}", file=sys.stderr)
        return None
    access = tok.get("access_token")
    if not access:
        return None
    expiry = time.time() + int(tok.get("expires_in", 3600))
    library.set_google(session, auth.get("email"), access,
                       tok.get("refresh_token"), expiry)
    return access

def drive_autosync(session, rec):
    """Push a freshly-persisted file to the user's Drive when connected.
    Hosted disks (e.g. Render) are ephemeral, so Drive is the durable store."""
    if not (rec and rec.get('filepath') and gdrive.configured()):
        return
    access = google_access_token(session)
    if not access:
        return
    try:
        folder = gdrive.ensure_folder(access)
        gdrive.upload(access, rec['filepath'], rec['filename'], folder,
                      rec.get('mime') or 'application/octet-stream')
        print(f"[gdrive] auto-synced {rec['filename']}", file=sys.stderr)
    except Exception as e:
        print(f"[gdrive] autosync failed: {e}", file=sys.stderr)

# ── AI assistant (Phase C/D) ────────────────────────────────────────
# NotebookLM-style: grounded in the user's own library, honest about gaps.
AI_SYSTEM_PROMPT = (
    "You are Resource Shrimp's research assistant — a NotebookLM-style guide over the "
    "user's own library of downloaded papers, articles, and transcripts of audio/video.\n"
    "Follow these rules strictly:\n"
    "1. Answer ONLY from the provided context. Do not use outside knowledge or guess.\n"
    "2. If the answer is not in the context, say plainly what is missing — never fabricate "
    "facts, quotes, numbers, or citations.\n"
    "3. Cite the resource titles you used (and timestamps when the context includes them).\n"
    "4. When sources cover the same point, synthesize them and note any disagreement.\n"
    "5. Be concise and plain — no marketing, filler, or hedging. Mark uncertainty explicitly.\n"
    "6. For summary requests, give a faithful, structured summary of the sources, not opinion."
)

def ensure_resource_text(session, rid):
    """Return cached/extracted text for a resource the session owns."""
    cached = library.get_text(session, rid)
    if cached:
        return cached
    rec = library.get(session, rid)
    if not rec or not rec.get('filepath'):
        return None
    real = os.path.realpath(rec['filepath'])
    if not real.startswith(os.path.realpath(library.LIBRARY_ROOT) + os.sep):
        return None
    text = ai.extract_text(real, rec.get('mime'))
    if text:
        library.set_text(rid, text)
    return text

def build_ai_context(session, rid, project=None):
    """Return (context_string, [resource_ids_used]) for the model.

    rid → one resource; project → that project's resources; else recent.
    """
    if rid:
        rec = library.get(session, rid)
        if not rec:
            return "", []
        text = ensure_resource_text(session, rid)
        head = rec.get('title') or rec.get('filename') or rid
        body = text or "(no extractable text in this resource)"
        return f"# {head}\n{body[:ai.MAX_CONTEXT_CHARS]}", [rid]
    # Project scope, or most recent resources, within a char budget
    if project:
        items = library.list_resources(session, project=project, limit=25)
    else:
        items = library.list_resources(session, limit=8)
    used, chunks, total = [], [], 0
    per, budget = 6000, ai.MAX_CONTEXT_CHARS
    for it in items:
        head = it.get('title') or it.get('filename') or it['id']
        text = ensure_resource_text(session, it['id']) if it.get('filename') else None
        block = f"# {head}\n{(text or '')[:per]}".strip()
        if total + len(block) > budget:
            break
        chunks.append(block)
        used.append(it['id'])
        total += len(block)
    return "\n\n---\n\n".join(chunks), used

# ── URL validation ──────────────────────────────────────────────────
ALLOWED_SCHEMES = {"http", "https"}
BLOCKED_HOSTS = {
    "localhost", "127.0.0.1", "0.0.0.0", "::1",
    "metadata.google.internal", "169.254.169.254",
    "0.0.0.0", "localhost.localdomain",
}

def validate_url(url):
    if not url or len(url) > MAX_URL_LEN:
        return False, "URL too long or empty"
    try:
        parsed = urlparse(url)
    except Exception:
        return False, "Invalid URL"
    if parsed.scheme not in ALLOWED_SCHEMES:
        return False, "Only http/https URLs allowed"
    host = (parsed.hostname or "").lower()
    if not host:
        return False, "No hostname"
    for blocked in BLOCKED_HOSTS:
        if host == blocked or host.endswith("." + blocked):
            return False, "Blocked host"
    # Block private IPs
    if re.match(r'^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)', host):
        return False, "Private IP blocked"
    return True, None

# ── Input sanitisation ──────────────────────────────────────────────
def sanitize_id(raw):
    """Download IDs must be alphanumeric + underscore/hyphen only.
    Rejects input that contained any dangerous chars (no stripping)."""
    if not raw or not isinstance(raw, str):
        return None
    if not re.fullmatch(r'[a-zA-Z0-9_-]{3,80}', raw):
        return None
    return raw

def sanitize_filename(name):
    """Strip anything dangerous from filenames."""
    name = re.sub(r'[^\w\s\-\.]', '', name)
    name = re.sub(r'\.{2,}', '.', name)
    name = name.strip('. ')
    return name[:200] if name else "download"

def safe_path(base, user_path):
    """Resolve user_path inside base, preventing traversal."""
    try:
        resolved = os.path.realpath(os.path.join(base, user_path))
        if resolved.startswith(os.path.realpath(base)):
            return resolved
    except Exception:
        pass
    return None

# ── Academic helpers (stdlib only) ──────────────────────────────────
OPENALEX = "https://api.openalex.org"
UNPAYWALL = "https://api.unpaywall.org/v2"
SCIHUB = "https://sci-hub.su"
EUROPEPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest"
# Some OA hosts (Wiley, etc.) reject non-browser agents on direct PDF links.
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")

def http_get(url, timeout=15, headers=None):
    h = {"User-Agent": "ResourceShrimp/2.0"}
    if headers:
        h.update(headers)
    req = Request(url, headers=h)
    try:
        with urlopen(req, timeout=timeout) as r:
            return r.read(), r.status, dict(r.headers)
    except (URLError, HTTPError) as e:
        code = getattr(e, "code", 0) if isinstance(e, HTTPError) else 0
        return b"", code, {}

def detect_url_type(url):
    u = url.lower().strip()
    if re.search(r'^10\.\d{4,}/', u) or 'doi.org/10.' in u or 'dx.doi.org/10.' in u:
        return 'doi'
    if 'arxiv.org' in u:
        return 'arxiv'
    if 'pubmed' in u or 'ncbi.nlm.nih.gov' in u:
        return 'pubmed'
    # A DOI embedded in a publisher URL (e.g. wiley /doi/10.1111/..)
    if re.search(r'/10\.\d{4,}/', u):
        return 'doi'
    if re.search(r'springer|wiley|sciencedirect|nature\.com|science\.org|ieee|acm', u):
        return 'academic'
    return 'video'

def extract_doi(url):
    """Pull a DOI from a raw DOI, a doi.org link, or any publisher URL path."""
    url = url.strip()
    if re.match(r'^10\.\d{4,}/', url):
        m = re.match(r'(10\.\d{4,}/\S+)', url)
    else:
        m = re.search(r'(?:doi\.org|dx\.doi\.org)/(10\.\d{4,}/[^\s?#]+)', url) \
            or re.search(r'(10\.\d{4,}/[^\s?#]+)', url)
    if not m:
        return None
    doi = m.group(1)
    # Trim common publisher path suffixes and trailing punctuation
    doi = re.sub(r'/(full|pdf|epdf|pdfdirect|abstract|meta)$', '', doi)
    return doi.rstrip('/.')

def fetch_openalex(doi=None, search=None):
    try:
        if doi:
            url = f"{OPENALEX}/works/doi:{quote(doi, safe='/')}"
        elif search:
            url = f"{OPENALEX}/works?search={quote(search)}&per_page=1"
        else:
            return None
        data, code, _ = http_get(url)
        if code == 200:
            d = json.loads(data)
            if 'results' in d and d['results']:
                return d['results'][0]
            if 'id' in d:
                return d
    except Exception as e:
        print(f"[openalex] {e}", file=sys.stderr)
    return None

def fetch_unpaywall(doi):
    try:
        url = f"{UNPAYWALL}/{quote(doi, safe='/')}?email=downloader@resourceshrimp.app"
        data, code, _ = http_get(url)
        if code == 200:
            d = json.loads(data)
            best = d.get('best_oa_location', {})
            if best:
                return {
                    'pdf_url': best.get('url_for_pdf') or best.get('url'),
                    'is_oa': d.get('is_oa', False),
                    'oa_status': d.get('oa_status', 'unknown'),
                }
    except Exception as e:
        print(f"[unpaywall] {e}", file=sys.stderr)
    return None

def fetch_europepmc(doi):
    """Lawful OA route: if the paper is open-access in Europe PMC / PMC,
    return its render-PDF URL. Reliable for biomedical/nutrition papers
    where publisher links (Unpaywall) are blocked."""
    try:
        q = quote(f'DOI:"{doi}"')
        url = f"{EUROPEPMC}/search?query={q}&format=json&resultType=core&pageSize=1"
        data, code, _ = http_get(url, timeout=20)
        if code != 200:
            return None
        results = json.loads(data).get('resultList', {}).get('result', [])
        if not results:
            return None
        a = results[0]
        pmcid = a.get('pmcid')
        if pmcid and (a.get('isOpenAccess') == 'Y' or a.get('inEPMC') == 'Y'):
            return {'pdf_url': f"https://europepmc.org/articles/{pmcid}?pdf=render",
                    'pmcid': pmcid}
    except Exception as e:
        print(f"[europepmc] {e}", file=sys.stderr)
    return None

def fetch_scihub(doi):
    try:
        data, code, _ = http_get(f"{SCIHUB}/{quote(doi, safe='/')}", headers={'User-Agent': 'Mozilla/5.0'})
        if code == 200:
            text = data.decode('utf-8', errors='ignore')
            m = re.search(r'src="(https?://[^"]*\.pdf[^"]*)"', text, re.I)
            if m:
                return m.group(1)
            m = re.search(r'(https?://[^"\']*sci-hub[^"\']*\.pdf)', text, re.I)
            if m:
                return m.group(1)
    except Exception as e:
        print(f"[scihub] {e}", file=sys.stderr)
    return None

def fetch_arxiv(arxiv_url):
    try:
        m = re.search(r'arxiv\.org/(?:abs|pdf)/(\d+\.\d+)', arxiv_url)
        if not m:
            return None
        aid = m.group(1)
        data, code, _ = http_get(f"http://export.arxiv.org/api/query?id_list={aid}")
        if code == 200:
            t = data.decode('utf-8', errors='ignore')
            # Parse the paper <entry>, not the feed header (which also has <title>)
            entry = re.search(r'<entry>(.*?)</entry>', t, re.DOTALL)
            block = entry.group(1) if entry else t
            title = re.search(r'<title>(.*?)</title>', block, re.DOTALL)
            summary = re.search(r'<summary>(.*?)</summary>', block, re.DOTALL)
            authors = re.findall(r'<name>(.*?)</name>', block)
            return {
                'title': html.unescape(title.group(1).strip()) if title else 'Unknown',
                'abstract': html.unescape(summary.group(1).strip()) if summary else '',
                'authors': [html.unescape(a.strip()) for a in authors],
                'pdf_url': f"https://arxiv.org/pdf/{aid}",
                'url': f"https://arxiv.org/abs/{aid}",
            }
    except Exception as e:
        print(f"[arxiv] {e}", file=sys.stderr)
    return None

# ── Download workers ────────────────────────────────────────────────
def progress_hook(d, did):
    with downloads_lock:
        if did not in downloads:
            return
        if d['status'] == 'downloading':
            downloads[did].update({
                'status': 'downloading', 'phase': 'fetching',
                'progress': d.get('_percent_str', '0%').strip('%'),
                'speed': d.get('_speed_str', 'N/A'),
                'eta': d.get('_eta_str', 'N/A'),
                'size': d.get('_total_bytes_str', d.get('_total_bytes_estimate_str', 'N/A')),
                'downloaded': d.get('_downloaded_bytes_str', 'N/A'),
                'message': 'Downloading...',
            })
        elif d['status'] == 'finished':
            downloads[did].update({
                'status': 'processing', 'phase': 'encoding',
                'progress': '100', 'speed': '--', 'eta': '--',
                'message': 'Processing...',
            })

_ytdlp_cookie_path = None
def ytdlp_cookies_file():
    """Return a cookies.txt path for yt-dlp, or None.

    Supports YTDLP_COOKIES_FILE (a path on the host) or YTDLP_COOKIES (the
    Netscape cookie-file CONTENTS, e.g. pasted as a Render secret). This is the
    reliable way past YouTube's 'confirm you're not a bot' check on cloud IPs.
    Cached after the first write."""
    global _ytdlp_cookie_path
    p = (os.environ.get('YTDLP_COOKIES_FILE') or '').strip()
    if p and os.path.isfile(p):
        return p
    raw = os.environ.get('YTDLP_COOKIES') or ''
    if not raw.strip():
        return None
    if _ytdlp_cookie_path and os.path.isfile(_ytdlp_cookie_path):
        return _ytdlp_cookie_path
    try:
        fd, path = tempfile.mkstemp(prefix='ytcookies_', suffix='.txt')
        with os.fdopen(fd, 'w') as f:
            f.write(raw if raw.endswith('\n') else raw + '\n')
        _ytdlp_cookie_path = path
        return path
    except Exception:
        return None


# bgutil PO token provider — the "underground" YouTube token refresher. yt-dlp's
# plugin auto-calls this local service ONLY for YouTube URLs, minting a fresh
# proof-of-origin token per request to get past the bot check on flagged IPs.
POT_BIN = os.path.join(BASE, 'bin', 'bgutil-pot')
POT_PLUGINS = os.path.join(BASE, 'yt-dlp-plugins')
POT_PORT = int(os.environ.get('POT_PORT', '4416'))
_pot_started = False

def start_pot_provider():
    """Launch the token refresher as a background daemon if its binary exists."""
    global _pot_started
    if _pot_started or not os.path.isfile(POT_BIN):
        return
    try:
        subprocess.Popen([POT_BIN, 'server', '--host', '127.0.0.1', '--port', str(POT_PORT)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _pot_started = True
        print(f'[pot] YouTube token refresher running on 127.0.0.1:{POT_PORT}', file=sys.stderr)
    except Exception as e:
        print(f'[pot] failed to start: {e}', file=sys.stderr)


def download_video(url, did, quality='1080p', subtitles=False, fmt='mp4'):
    global ACTIVE_DOWNLOADS
    temp_dir = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vid_")
    with downloads_lock:
        downloads[did] = {
            'status': 'starting', 'phase': 'init', 'type': 'video',
            'progress': '0', 'speed': 'N/A', 'eta': 'N/A',
            'size': 'N/A', 'downloaded': 'N/A',
            'filename': None, 'error': None, 'message': 'Starting...',
            'temp_dir': temp_dir,
        }

    quality_map = {
        '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
        '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
        '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
        '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
        '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
        'audio': 'bestaudio/best',
    }
    audio_fmts = {'mp3', 'flac', 'wav', 'opus', 'aac'}
    fmt_map = {
        'mp3': {'codec': 'mp3', 'q': '320'},
        'flac': {'codec': 'flac', 'q': '0'},
        'wav': {'codec': 'wav', 'q': '0'},
        'opus': {'codec': 'opus', 'q': '256'},
        'aac': {'codec': 'aac', 'q': '256'},
    }

    cmd = [sys.executable, '-m', 'yt_dlp', '--no-warnings', '--no-check-certificates']
    # YouTube blocks datacenter IPs (cloud hosts) with a "confirm you're not a
    # bot" check. Mitigate with (1) alternative player clients that avoid PO
    # tokens and (2) optional cookies supplied via env (the reliable fix).
    ex_args = os.environ.get('YTDLP_EXTRACTOR_ARGS', 'youtube:player_client=default,web_safari,mweb,tv')
    if ex_args:
        cmd += ['--extractor-args', ex_args]
    # Underground token refresher: yt-dlp mints a fresh PO token via the local
    # bgutil provider (auto-triggered for YouTube only) when it's available.
    if os.path.isfile(POT_BIN):
        start_pot_provider()
        cmd += ['--extractor-args', f'youtubepot-bgutilhttp:base_url=http://127.0.0.1:{POT_PORT}']
        if os.path.isdir(POT_PLUGINS):
            cmd += ['--plugin-dirs', POT_PLUGINS]
    ck = ytdlp_cookies_file()
    if ck:
        cmd += ['--cookies', ck]
    # Route through a residential proxy (the reliable fix for YouTube blocking a
    # flagged datacenter IP): set YTDLP_PROXY=http://user:pass@host:port.
    proxy = (os.environ.get('YTDLP_PROXY') or '').strip()
    if proxy:
        cmd += ['--proxy', proxy]
    cmd += ['-o', os.path.join(temp_dir, '%(title)s.%(ext)s')]

    if quality == 'audio' or fmt in audio_fmts:
        ci = fmt_map.get(fmt, {'codec': 'mp3', 'q': '320'})
        cmd += ['-f', 'bestaudio/best']
        cmd += ['-x', '--audio-format', ci['codec'], '--audio-quality', ci['q']]
    else:
        fmt_str = quality_map.get(quality, quality_map['1080p'])
        cmd += ['-f', fmt_str]
        cmd += '--merge-output-format', 'mp4'

    if subtitles:
        cmd += ['--write-subs', '--write-auto-subs', '--sub-langs', 'en,es,fr,de,zh,ja,ko']

    cmd += ['--progress', '--newline', url]

    try:
        with downloads_lock:
            downloads[did].update({'status': 'downloading', 'message': 'Starting download...'})

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            # Parse yt-dlp progress output
            pct = re.search(r'(\d+\.?\d*)%', line)
            spd = re.search(r'at\s+([\d.]+\w+/s)', line)
            eta = re.search(r'ETA\s+(\S+)', line)
            if pct:
                with downloads_lock:
                    if did in downloads:
                        downloads[did].update({
                            'progress': pct.group(1),
                            'speed': spd.group(1) if spd else 'N/A',
                            'eta': eta.group(1) if eta else 'N/A',
                        })

        proc.wait()
        if proc.returncode != 0:
            err = proc.stderr.read()[:500]
            msg = f'yt-dlp error: {err}'
            low = err.lower()
            if 'sign in to confirm' in low or ("not a bot" in low) or ('bot' in low and 'confirm' in low):
                msg = ("YouTube blocked this download from the server's IP (bot check). "
                       "The reliable fixes: set YTDLP_PROXY to a residential proxy, or add "
                       "YouTube cookies via YTDLP_COOKIES, on the backend. A cloud IP alone "
                       "(Render/AWS) is too flagged for the bot check.")
            with downloads_lock:
                downloads[did].update({'status': 'error', 'error': err, 'message': msg})
            return

        # Find output file
        ext = fmt if fmt in audio_fmts else 'mp4'
        filepath = None
        for f in os.listdir(temp_dir):
            if any(f.endswith(f'.{e}') for e in [ext, 'webm', 'mkv', 'mp4', 'mp3', 'm4a', 'flac', 'wav', 'opus', 'aac']):
                filepath = os.path.join(temp_dir, f)
                break
        if not filepath or not os.path.exists(filepath):
            with downloads_lock:
                downloads[did].update({'status': 'error', 'error': 'No output file', 'message': 'Download produced no file'})
            return

        filename = os.path.basename(filepath)
        with downloads_lock:
            downloads[did].update({
                'status': 'complete', 'phase': 'ready', 'progress': '100',
                'filename': filename, 'filepath': filepath,
                'message': 'Download complete!',
            })
    except Exception as e:
        with downloads_lock:
            downloads[did].update({'status': 'error', 'error': str(e), 'message': f'Error: {e}'})

# Publisher CDNs that commonly 403 programmatic PDF fetches — try open
# repository copies first, these last (before any fallback).
_BLOCKED_PDF_HOSTS = ('wiley', 'onlinelibrary', 'sciencedirect', 'springer',
                      'tandfonline', 'sagepub', 'ieee')

def _is_blocked_host(u):
    u = (u or '').lower()
    return any(h in u for h in _BLOCKED_PDF_HOSTS)

def openalex_pdf_urls(work):
    """OA PDF URLs from an OpenAlex work — includes green/repository copies
    that are downloadable when the publisher version is blocked."""
    out = []
    if not work:
        return out
    for loc in (work.get('locations') or []):
        if loc.get('is_oa') and loc.get('pdf_url'):
            out.append(loc['pdf_url'])
    best = work.get('best_oa_location') or {}
    if best.get('pdf_url'):
        out.append(best['pdf_url'])
    oa_url = (work.get('open_access') or {}).get('oa_url')
    if oa_url and oa_url.lower().endswith('.pdf'):
        out.append(oa_url)
    return out

def pdf_candidates(doi, work=None):
    """Ordered PDF URLs to try for a DOI: open repositories / PMC first,
    blocked publisher links deferred, configured fallback last."""
    preferred, deferred, fallback = [], [], []
    epmc = fetch_europepmc(doi)
    if epmc and epmc.get('pdf_url'):
        preferred.append(epmc['pdf_url'])
    for u in openalex_pdf_urls(work):
        (deferred if _is_blocked_host(u) else preferred).append(u)
    oa = fetch_unpaywall(doi)
    if oa and oa.get('pdf_url'):
        (deferred if _is_blocked_host(oa['pdf_url']) else preferred).append(oa['pdf_url'])
    sh = fetch_scihub(doi)
    if sh:
        fallback.append(sh)
    seen, out = set(), []
    for u in preferred + deferred + fallback:
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out

def download_article(url, did):
    temp_dir = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="art_")
    with downloads_lock:
        downloads[did] = {
            'status': 'starting', 'phase': 'init', 'type': 'article',
            'progress': '0', 'speed': 'N/A', 'eta': 'N/A',
            'size': 'N/A', 'downloaded': 'N/A',
            'filename': None, 'error': None, 'message': 'Resolving paper...',
            'temp_dir': temp_dir,
        }

    try:
        url_type = detect_url_type(url)
        paper_info = None
        candidates = []

        with downloads_lock:
            downloads[did].update({'status': 'fetching', 'phase': 'fetching', 'message': 'Searching databases...'})

        if url_type == 'arxiv':
            paper_info = fetch_arxiv(url)
            if paper_info:
                if paper_info.get('pdf_url'):
                    candidates.append(paper_info['pdf_url'])
                paper_info['source'] = 'arXiv'
        elif url_type == 'doi':
            doi = extract_doi(url)
            if doi:
                paper_info = fetch_openalex(doi=doi)
                if paper_info:
                    paper_info['doi'] = doi
                    paper_info['source'] = 'OpenAlex'
                candidates = pdf_candidates(doi, paper_info)
        else:
            paper_info = fetch_openalex(search=url)
            if paper_info:
                paper_info['source'] = 'OpenAlex'
                doi_raw = paper_info.get('doi', '')
                doi = doi_raw.replace('https://doi.org/', '') if doi_raw else None
                if doi:
                    candidates = pdf_candidates(doi, paper_info)

        if not paper_info:
            raise ValueError("Could not find paper. Check the URL or try a DOI.")

        title = paper_info.get('title', 'Paper')
        clean_title = sanitize_filename(title)[:100]

        authorships = paper_info.get('authorships') or []
        authors = [a.get('author', {}).get('display_name', '') for a in authorships[:10]]
        if not authors and paper_info.get('authors'):
            authors = list(paper_info['authors'])[:10]  # arXiv shape

        with downloads_lock:
            downloads[did].update({
                'status': 'downloading', 'phase': 'fetching', 'message': 'Downloading paper...',
                'title': title,
                'authors': authors,
                'doi': paper_info.get('doi', ''),
                'journal': (paper_info.get('primary_location') or {}).get('source', {}).get('display_name', '') if paper_info.get('primary_location') else '',
                'year': paper_info.get('publication_year', ''),
                'pdf_url': candidates[0] if candidates else None,
            })

        # Try each candidate (lawful OA first) with a browser UA until one is a real PDF
        pdf_path = None
        for cand in candidates:
            data, code, headers = http_get(
                cand, timeout=40,
                headers={'User-Agent': BROWSER_UA, 'Accept': 'application/pdf,*/*'})
            ct = (headers.get('Content-Type') or '').lower()
            is_pdf = data[:5] == b'%PDF-' or ('pdf' in ct and bool(data))
            if code == 200 and data and is_pdf:
                pdf_path = os.path.join(temp_dir, f"{clean_title}.pdf")
                with open(pdf_path, 'wb') as f:
                    f.write(data)
                break

        with downloads_lock:
            if pdf_path:
                downloads[did].update({
                    'status': 'complete', 'phase': 'ready', 'progress': '100',
                    'filename': f"{clean_title}.pdf", 'filepath': pdf_path,
                    'message': 'Paper downloaded!', 'has_pdf': True,
                })
            else:
                downloads[did].update({
                    'status': 'complete', 'phase': 'ready', 'progress': '100',
                    'message': 'Paper found — no free PDF available', 'has_pdf': False,
                })

    except Exception as e:
        with downloads_lock:
            downloads[did].update({'status': 'error', 'error': str(e), 'message': f'Error: {e}'})


# ── Conversation parsers ────────────────────────────────────────────
def parse_chatgpt_json(data):
    conv = None
    if isinstance(data, dict):
        if "props" in data and "pageProps" in data:
            page_props = data["props"]["pageProps"]
            conv = page_props.get("sharedConversation") or page_props.get("conversation")
        elif "mapping" in data:
            conv = data
        elif "sharedConversation" in data:
            conv = data["sharedConversation"]
        
    if not conv or "mapping" not in conv:
        if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict) and "mapping" in data[0]:
            conv = data[0]
        else:
            return None

    title = conv.get("title") or "ChatGPT Conversation"
    mapping = conv.get("mapping", {})
    current_node_id = conv.get("current_node")
    
    path = []
    node_id = current_node_id
    visited = set()
    while node_id and node_id in mapping and node_id not in visited:
        visited.add(node_id)
        path.append(node_id)
        node_id = mapping[node_id].get("parent")
    path.reverse()
    
    if not path:
        nodes_with_time = []
        for nid, node in mapping.items():
            msg = node.get("message")
            if msg:
                create_time = msg.get("create_time") or 0
                nodes_with_time.append((create_time, nid))
        nodes_with_time.sort()
        path = [nid for _, nid in nodes_with_time]
        
    md_lines = []
    md_lines.append(f"# {title}\n")
    
    for nid in path:
        node = mapping.get(nid)
        if not node:
            continue
        msg = node.get("message")
        if not msg:
            continue
        author = msg.get("author", {})
        role = author.get("role", "unknown")
        content = msg.get("content", {})
        parts = content.get("parts", [])
        
        text_parts = []
        for part in parts:
            if isinstance(part, str):
                text_parts.append(part)
            elif isinstance(part, dict) and "text" in part:
                text_parts.append(part["text"])
        
        text = "\n".join(text_parts).strip()
        if not text:
            continue
            
        role_label = role.capitalize()
        if role == "user":
            role_label = "User"
        elif role == "assistant":
            role_label = "Assistant"
            
        md_lines.append(f"### {role_label}\n{text}\n")
        
    return title, "\n".join(md_lines)


def parse_json_conversation(text):
    try:
        data = json.loads(text.strip())
    except Exception:
        return None
        
    res = parse_chatgpt_json(data)
    if res:
        return res
        
    messages = None
    title = "JSON Conversation"
    if isinstance(data, list):
        messages = data
    elif isinstance(data, dict):
        if "messages" in data and isinstance(data["messages"], list):
            messages = data["messages"]
            title = data.get("title") or title
        elif "turns" in data and isinstance(data["turns"], list):
            messages = data["turns"]
            title = data.get("title") or title
            
    if messages:
        md_lines = []
        md_lines.append(f"# {title}\n")
        first_user = None
        
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role") or msg.get("author") or "unknown"
            if isinstance(role, dict):
                role = role.get("role") or "unknown"
            role = str(role).lower()
            
            content = msg.get("content") or msg.get("text") or ""
            if isinstance(content, dict):
                parts = content.get("parts")
                if parts and isinstance(parts, list):
                    content = "\n".join([str(p) for p in parts if p])
                else:
                    content = content.get("text") or ""
            
            content = str(content).strip()
            if not content:
                continue
                
            role_label = role.capitalize()
            if role in ("user", "human"):
                role_label = "User"
                if not first_user:
                    first_user = content
            elif role in ("assistant", "ai", "bot"):
                role_label = "Assistant"
            elif role == "system":
                role_label = "System"
                
            md_lines.append(f"### {role_label}\n{content}\n")
            
        if first_user and title == "JSON Conversation":
            title = first_user.split('\n')[0]
            if len(title) > 60:
                title = title[:57] + "..."
            md_lines[0] = f"# {title}\n"
            
        return title, "\n".join(md_lines)
        
    return None


def parse_raw_text_conversation(text):
    lines = text.split('\n')
    prefix_pat = re.compile(
        r'^(\[?(user|assistant|human|ai|system|me|bot|speaker\s*\d+)\]?\s*:|^\[(user|assistant|human|ai|system|me|bot|speaker\s*\d+)\]\s*$)',
        re.IGNORECASE
    )
    
    turns = []
    current_role = None
    current_content = []
    
    for line in lines:
        stripped = line.strip()
        match = prefix_pat.match(stripped)
        if match:
            if current_role and current_content:
                turns.append((current_role, "\n".join(current_content).strip()))
            
            role = None
            content_start = ""
            if match.group(2):
                role = match.group(2).lower()
                colon_idx = line.find(':')
                if colon_idx != -1:
                    content_start = line[colon_idx+1:]
            elif match.group(3):
                role = match.group(3).lower()
                content_start = ""
            
            if not role:
                role = "unknown"
                
            if "user" in role or role in ("human", "me"):
                current_role = "User"
            elif "assistant" in role or role in ("ai", "bot"):
                current_role = "Assistant"
            elif "system" in role:
                current_role = "System"
            else:
                current_role = role.capitalize()
                
            current_content = [content_start]
        else:
            if current_role is not None:
                current_content.append(line)
                
    if current_role and current_content:
        turns.append((current_role, "\n".join(current_content).strip()))
        
    if not turns:
        return None
        
    title = "Pasted Conversation"
    for role, content in turns:
        if role == "User" and content:
            title = content.split('\n')[0].strip()
            if len(title) > 60:
                title = title[:57] + "..."
            break
            
    md_lines = []
    md_lines.append(f"# {title}\n")
    for role, content in turns:
        md_lines.append(f"### {role}\n{content}\n")
        
    return title, "\n".join(md_lines)


def fetch_conversation_url(url):
    req = Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        }
    )
    with urlopen(req, timeout=15) as r:
        return r.read().decode('utf-8', errors='ignore')


def download_conversation(url, did):
    temp_dir = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="conv_")
    with downloads_lock:
        downloads[did] = {
            'status': 'starting', 'phase': 'init', 'type': 'conversation',
            'progress': '0', 'speed': 'N/A', 'eta': 'N/A',
            'size': 'N/A', 'downloaded': 'N/A',
            'filename': None, 'error': None, 'message': 'Parsing conversation...',
            'temp_dir': temp_dir,
        }

    try:
        with downloads_lock:
            downloads[did].update({'status': 'fetching', 'phase': 'fetching', 'message': 'Parsing content...'})

        is_url = url.startswith('http://') or url.startswith('https://')
        title = None
        markdown_content = None
        
        if is_url:
            with downloads_lock:
                downloads[did].update({'message': 'Fetching conversation from link...'})
            try:
                html_data = fetch_conversation_url(url)
                if 'chatgpt.com/share' in url or 'chat.openai.com/share' in url:
                    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html_data, re.DOTALL)
                    if match:
                        parsed_json = json.loads(match.group(1))
                        res = parse_chatgpt_json(parsed_json)
                        if res:
                            title, markdown_content = res
                
                if not markdown_content:
                    title_match = re.search(r'<title>(.*?)</title>', html_data, re.IGNORECASE | re.DOTALL)
                    title = html.unescape(title_match.group(1).strip()) if title_match else "Shared Chat"
                    text = re.sub(r'<(script|style).*?>.*?</\1>', '', html_data, flags=re.DOTALL|re.IGNORECASE)
                    text = re.sub(r'<[^>]*>', ' ', text)
                    text = html.unescape(text)
                    lines = [line.strip() for line in text.split('\n') if line.strip()]
                    markdown_content = f"# {title}\n\n" + "\n\n".join(lines)
            except Exception as e:
                raise Exception(
                    f"Could not fetch conversation URL ({e}). "
                    "OpenAI/Claude access controls may block automated scrapers. "
                    "Please copy and paste the chat transcript text directly instead!"
                )
        else:
            res = parse_json_conversation(url)
            if not res:
                res = parse_raw_text_conversation(url)
                
            if res:
                title, markdown_content = res
            else:
                title = "Pasted Conversation"
                lines = [l.strip() for l in url.split('\n') if l.strip()]
                if lines:
                    title_candidate = lines[0]
                    if len(title_candidate) > 60:
                        title = title_candidate[:57] + "..."
                    else:
                        title = title_candidate
                markdown_content = f"# {title}\n\n{url}"

        if not markdown_content:
            raise Exception("Failed to parse conversation content.")

        safe_title = sanitize_filename(title)
        if not safe_title:
            safe_title = "conversation"
        filename = f"{safe_title}.md"
        filepath = os.path.join(temp_dir, filename)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(markdown_content)
            
        with downloads_lock:
            downloads[did].update({
                'status': 'complete',
                'phase': 'ready',
                'progress': '100',
                'filepath': filepath,
                'filename': filename,
                'title': title,
                'type': 'conversation',
                'message': 'Parsed successfully'
            })
    except Exception as e:
        with downloads_lock:
            downloads[did].update({
                'status': 'error',
                'error': str(e),
                'message': str(e)
            })


# ── Provider registry ───────────────────────────────────────────────
# Each resource type is a provider. detect() ranks them by URL; new types
# are added in providers.py without touching the server below.
providers.register(providers.ConversationProvider(download_conversation))
providers.register(providers.ArticleProvider(download_article))
providers.register(providers.VideoProvider(download_video))

# ── HTTP request handler ────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {args[0]}", file=sys.stderr)

    def send_json(self, data, status=200, cookie=None):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self, max_len=8192):
        """Read+parse a JSON request body, or send an error and return None."""
        length = int(self.headers.get('Content-Length', 0))
        if length > max_len:
            self.send_json({'error': 'Request too large'}, 413)
            return None
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({'error': 'Invalid JSON'}, 400)
            return None

    def send_redirect(self, location, cookie=None):
        self.send_response(302)
        self.send_header('Location', location)
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Length', 0)
        self.end_headers()

    def send_security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
        csp = (
            "default-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "script-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "frame-src 'none'; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self'"
        )
        self.send_header('Content-Security-Policy', csp)
        # CORS — allow the configured frontends (Pages + the AWS custom domain).
        # CORS_ORIGINS is a comma-separated allowlist; reflect the caller's Origin
        # when it's on the list so multiple frontends can share this API.
        allowed = os.environ.get('CORS_ORIGINS', '*')
        if allowed == '*':
            self.send_header('Access-Control-Allow-Origin', '*')
        else:
            allow_list = [o.strip() for o in allowed.split(',') if o.strip()]
            origin = self.headers.get('Origin', '')
            chosen = origin if origin in allow_list else (allow_list[0] if allow_list else '*')
            self.send_header('Access-Control-Allow-Origin', chosen)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')

    def serve_static(self, path):
        # Only allow files from the static/ directory
        static_dir = os.path.join(BASE, 'static')
        safe = safe_path(static_dir, path.replace('static/', '', 1))
        if not safe or not os.path.isfile(safe):
            self.send_error(404)
            return
        ct, _ = mimetypes.guess_type(safe)
        ct = ct or 'application/octet-stream'
        with open(safe, 'rb') as f:
            body = f.read()
        # Revalidate CSS/JS each load so users never get stale assets after a
        # deploy; other static types can cache normally.
        if safe.endswith(('.css', '.js')):
            cache = 'no-cache'
        else:
            cache = 'public, max-age=3600'
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', len(body))
        self.send_header('Cache-Control', cache)
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_security_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        # Health check (unrated — matches OCS's healthCheckPath convention)
        if path == '/health':
            self.send_json({'ok': True, 'app': 'resource-shrimp'})
            return

        ip = self.client_address[0]
        if not rate_check(ip):
            self.send_json({'error': 'Rate limit exceeded'}, 429)
            return

        # Serve index
        if path == '/':
            idx = os.path.join(BASE, 'templates', 'index.html')
            if not os.path.isfile(idx):
                self.send_error(500, 'Template missing')
                return
            with open(idx, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', len(body))
            if not get_session(self):
                self.send_header('Set-Cookie', session_cookie(new_session()))
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        # Library listing (session-scoped, optional ?q= search)
        if path == '/api/library':
            sid = get_session(self)
            if not sid:
                self.send_json({'resources': []})
                return
            qs = parse_qs(parsed.query)
            q = qs.get('q', [None])[0]
            project = qs.get('project', [None])[0]
            if project == 'unfiled':
                project = '__none__'
            items = library.list_resources(sid, q, project=project)
            out = [{k: v for k, v in r.items() if k != 'filepath'} for r in items]
            self.send_json({'resources': out})
            return

        if path == '/api/projects':
            sid = get_session(self)
            self.send_json({'projects': library.list_projects(sid) if sid else []})
            return

        # Library access credentials (institution / Research4Life)
        if path == '/api/access':
            sid = get_session(self)
            self.send_json(library.get_access(sid) if sid else
                           {'institution': None, 'r4l_user': None, 'has_r4l_pass': False})
            return

        # AI assistant availability + connected providers + settings
        if path == '/api/ai/status':
            sid = get_session(self)
            providers_avail = ai.available()
            connected = library.list_credentials(sid) if sid else []
            settings = library.get_settings(sid) if sid else {'default_provider': None, 'default_model': None}
            self.send_json({
                'providers': providers_avail,        # ready now via env / local
                'connected': connected,              # user-added, key masked
                'settings': settings,
                'catalog': ['openai', 'anthropic', 'groq', 'openrouter', 'deepseek', 'glm', 'kimi', 'ollama', 'opencode', 'custom'],
                'ready': bool(providers_avail) or bool(connected),
            })
            return

        # ── Google Drive (Phase B, optional) ────────────────────────
        if path == '/api/auth/status':
            sid = get_session(self)
            auth = library.get_google(sid) if sid else None
            self.send_json({
                'configured': gdrive.configured(),
                'connected': bool(auth and auth.get('refresh_token')),
                'email': (auth or {}).get('email'),
            })
            return

        if path == '/api/auth/google/start':
            if not gdrive.configured():
                self.send_json({'error': 'Google Drive not configured'}, 503)
                return
            sid = get_session(self)
            set_cookie = None
            if not sid:
                sid = new_session()
                set_cookie = session_cookie(sid)
            state = oauth_new_state(sid)
            self.send_redirect(gdrive.auth_url(state), cookie=set_cookie)
            return

        # Launcher login — server-side OAuth so it works without the
        # static origin (reyanda.github.io) being a registered JS origin.
        # Only Render's redirect URI needs registering, and it already is.
        if path == '/api/auth/google/login':
            ret = parse_qs(parsed.query).get('return', [''])[0]
            ret = ret if ret in LOGIN_RETURN_ALLOW else DEFAULT_LOGIN_RETURN
            if not gdrive.configured():
                self.send_redirect(ret + '#rs_auth_error=not_configured')
                return
            sid = get_session(self)
            set_cookie = None
            if not sid:
                sid = new_session()
                set_cookie = session_cookie(sid)
            state = oauth_new_state(sid, {'kind': 'login', 'return': ret})
            self.send_redirect(gdrive.login_url(state), cookie=set_cookie)
            return

        if path == '/api/auth/google/callback':
            if not gdrive.configured():
                self.send_json({'error': 'Google Drive not configured'}, 503)
                return
            qs = parse_qs(parsed.query)
            code = qs.get('code', [None])[0]
            state = qs.get('state', [None])[0]
            sess_for_state, extra = oauth_take_state(state) if state else (None, None)
            is_login = bool(extra and extra.get('kind') == 'login')
            ret = (extra or {}).get('return') or DEFAULT_LOGIN_RETURN
            if not code or not sess_for_state:
                self.send_redirect(
                    (ret + '#rs_auth_error=denied') if is_login else '/?drive=error')
                return
            try:
                tok = gdrive.exchange_code(code)
                access = tok.get('access_token')
                info = gdrive.userinfo(access) if access else {}
                if is_login:
                    # Hand the verified profile back to the launcher in the URL
                    # fragment — never sent to a server, never logged.
                    user = {
                        'name': info.get('name') or (info.get('email') or '').split('@')[0],
                        'email': info.get('email', ''),
                        'picture': info.get('picture', ''),
                        'sub': info.get('sub', ''),
                    }
                    blob = base64.urlsafe_b64encode(
                        json.dumps(user).encode()).decode().rstrip('=')
                    self.send_redirect(ret + '#rs_auth=' + blob)
                    return
                expiry = time.time() + int(tok.get('expires_in', 3600))
                library.set_google(sess_for_state, info.get('email'),
                                   access, tok.get('refresh_token'), expiry)
                self.send_redirect('/?drive=connected')
            except Exception as e:
                print(f"[gdrive] callback failed: {e}", file=sys.stderr)
                self.send_redirect(
                    (ret + '#rs_auth_error=exchange') if is_login else '/?drive=error')
            return

        # Static files
        if path.startswith('/static/'):
            self.serve_static(path[1:])
            return

        # Status endpoint
        if path.startswith('/api/status/'):
            did = sanitize_id(path.split('/api/status/')[-1])
            if not did:
                self.send_json({'error': 'Invalid ID'}, 400)
                return
            with downloads_lock:
                info = downloads.get(did)
            if info is None:
                # Fall back to the persistent library (job pruned from memory)
                sid = get_session(self)
                rec = library.get(sid, did) if sid else None
                if rec:
                    info = {
                        'status': 'complete', 'phase': 'ready', 'progress': '100',
                        'type': rec['type'], 'filename': rec['filename'],
                        'message': 'In library',
                    }
                    for k in ('title', 'authors', 'doi', 'journal', 'year'):
                        if rec['meta'].get(k):
                            info[k] = rec['meta'][k]
                else:
                    info = {'status': 'not_found'}
            # Strip internal fields
            safe_info = {k: v for k, v in info.items() if k not in ('temp_dir', 'filepath', 'url')}
            self.send_json(safe_info)
            return

        # Stream file
        if path.startswith('/api/stream/'):
            did = sanitize_id(path.split('/api/stream/')[-1])
            if not did:
                self.send_json({'error': 'Invalid ID'}, 400)
                return

            # Prefer the persistent library; fall back to an in-flight job.
            filepath = filename = None
            sid = get_session(self)
            rec = library.get(sid, did) if sid else None
            with downloads_lock:
                info = downloads.get(did)
            done = bool(rec) or bool(info and info.get('status') == 'complete')
            if rec and rec.get('filepath'):
                filepath, filename = rec['filepath'], rec['filename']
            elif info and info.get('status') == 'complete':
                filepath, filename = info.get('filepath'), info.get('filename')

            if not filepath:
                # A completed item with no file = nothing to download
                # (e.g. a paper found without an open-access PDF).
                msg = 'No downloadable file for this item' if done else 'File not ready'
                self.send_json({'error': msg}, 404)
                return

            # Path traversal check — file must live under the temp or library root
            real = os.path.realpath(filepath)
            roots = (os.path.realpath(TEMP_ROOT), os.path.realpath(library.LIBRARY_ROOT))
            if not any(real == r or real.startswith(r + os.sep) for r in roots):
                self.send_json({'error': 'Access denied'}, 403)
                return
            if not os.path.isfile(real):
                self.send_json({'error': 'File not found'}, 404)
                return

            filename = sanitize_filename(filename or 'download')
            ct, _ = mimetypes.guess_type(filename)
            ct = ct or 'application/octet-stream'
            size = os.path.getsize(real)

            self.send_response(200)
            self.send_header('Content-Type', ct)
            self.send_header('Content-Length', size)
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_security_headers()
            self.end_headers()

            with open(real, 'rb') as f:
                shutil.copyfileobj(f, self.wfile)
            # No cleanup — the file lives in the user's library now.
            return

        self.send_error(404)

    def do_HEAD(self):
        """Handle HEAD — headers only, no body."""
        ip = self.client_address[0]
        if not rate_check(ip):
            self.send_response(429)
            self.send_header('Content-Type', 'application/json')
            self.send_security_headers()
            self.end_headers()
            return
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == '/':
            idx = os.path.join(BASE, 'templates', 'index.html')
            if os.path.isfile(idx):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', os.path.getsize(idx))
                self.send_security_headers()
                self.end_headers()
            else:
                self.send_error(500)
        elif path.startswith('/static/'):
            self.serve_static(path[1:])
        else:
            self.send_error(404)

    def do_POST(self):
        ip = self.client_address[0]
        if not rate_check(ip):
            self.send_json({'error': 'Rate limit exceeded'}, 429)
            return

        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/api/download':
            length = int(self.headers.get('Content-Length', 0))
            if length > 2 * 1024 * 1024:
                self.send_json({'error': 'Request too large'}, 413)
                return
            try:
                body = self.rfile.read(length)
                data = json.loads(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_json({'error': 'Invalid JSON'}, 400)
                return

            url = data.get('url', '').strip()
            dl_type = data.get('type', 'auto')
            quality = data.get('quality', '1080p')
            fmt = data.get('format', 'mp4')
            subtitles = bool(data.get('subtitles', False))

            is_conv = (dl_type == 'conversation')
            if dl_type == 'auto':
                prov = providers.detect(url)
                if prov and prov.name == 'conversation':
                    is_conv = True

            if is_conv:
                if not url:
                    self.send_json({'error': 'Conversation content is empty'}, 400)
                    return
            else:
                valid, err = validate_url(url)
                if not valid:
                    self.send_json({'error': err}, 400)
                    return

            # Validate quality/format
            valid_q = {'2160p','1440p','1080p','720p','480p','360p','audio'}
            valid_f = {'mp4','mp3','flac','wav','opus','aac'}
            if quality not in valid_q:
                quality = '1080p'
            if fmt not in valid_f:
                fmt = 'mp4'

            # Per-IP limit on starting new downloads (the expensive action)
            if not rate_check(ip, "download", DOWNLOAD_LIMIT):
                self.send_json({'error': 'Download rate limit exceeded'}, 429)
                return

            # Concurrency limit
            global ACTIVE_DOWNLOADS
            if ACTIVE_DOWNLOADS >= MAX_CONCURRENT:
                self.send_json({'error': 'Too many concurrent downloads'}, 429)
                return

            did = secrets.token_urlsafe(16)
            if dl_type == 'auto':
                provider = providers.detect(url)
            else:
                provider = providers.by_name(dl_type) or providers.detect(url)
            if provider is None:
                self.send_json({'error': 'No handler for this URL'}, 400)
                return

            sid = get_session(self)
            set_cookie = None
            if not sid:
                sid = new_session()
                set_cookie = session_cookie(sid)

            with downloads_lock:
                ACTIVE_DOWNLOADS += 1

            opts = {'quality': quality, 'format': fmt, 'subtitles': subtitles}
            t = threading.Thread(target=self._run_provider, args=(provider, url, opts, did, sid), daemon=True)
            t.start()
            self.send_json({'download_id': did, 'type': provider.name}, cookie=set_cookie)
            return

        if path == '/api/delete':
            length = int(self.headers.get('Content-Length', 0))
            if length > 8192:
                self.send_json({'error': 'Request too large'}, 413)
                return
            try:
                data = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_json({'error': 'Invalid JSON'}, 400)
                return
            sid = get_session(self)
            rid = sanitize_id(data.get('id', ''))
            if not sid or not rid:
                self.send_json({'error': 'Bad request'}, 400)
                return
            ok = library.delete(sid, rid)
            with downloads_lock:
                downloads.pop(rid, None)
            self.send_json({'deleted': ok})
            return

        if path == '/api/auth/logout':
            sid = get_session(self)
            if sid:
                library.clear_google(sid)
            self.send_json({'ok': True})
            return

        if path == '/api/drive/sync':
            if not gdrive.configured():
                self.send_json({'error': 'Google Drive not configured'}, 503)
                return
            length = int(self.headers.get('Content-Length', 0))
            if length > 8192:
                self.send_json({'error': 'Request too large'}, 413)
                return
            try:
                data = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_json({'error': 'Invalid JSON'}, 400)
                return
            sid = get_session(self)
            rid = sanitize_id(data.get('id', ''))
            if not sid or not rid:
                self.send_json({'error': 'Bad request'}, 400)
                return
            rec = library.get(sid, rid)
            if not rec or not rec.get('filepath'):
                self.send_json({'error': 'No file to sync'}, 404)
                return
            access = google_access_token(sid)
            if not access:
                self.send_json({'error': 'Not connected to Google Drive'}, 401)
                return
            real = os.path.realpath(rec['filepath'])
            if not real.startswith(os.path.realpath(library.LIBRARY_ROOT) + os.sep) \
                    or not os.path.isfile(real):
                self.send_json({'error': 'File unavailable'}, 404)
                return
            try:
                folder = gdrive.ensure_folder(access)
                meta = gdrive.upload(access, real, rec['filename'], folder,
                                     rec.get('mime') or 'application/octet-stream')
                self.send_json({'synced': True, 'drive_id': meta.get('id'),
                                'name': meta.get('name')})
            except Exception as e:
                print(f"[gdrive] sync failed: {e}", file=sys.stderr)
                self.send_json({'error': 'Drive upload failed'}, 502)
            return

        if path == '/api/ai/chat':
            length = int(self.headers.get('Content-Length', 0))
            if length > 16384:
                self.send_json({'error': 'Request too large'}, 413)
                return
            try:
                data = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_json({'error': 'Invalid JSON'}, 400)
                return
            sid = get_session(self)
            if not sid:
                self.send_json({'error': 'No session'}, 400)
                return
            question = (data.get('question') or '').strip()
            if not question or len(question) > 4000:
                self.send_json({'error': 'Question missing or too long'}, 400)
                return
            rid = sanitize_id(data.get('id', '')) if data.get('id') else None
            project = sanitize_id(data.get('project', '')) if data.get('project') else None
            provider = data.get('provider') or None
            if provider and provider not in ai.PROVIDERS:
                self.send_json({'error': 'Unknown provider'}, 400)
                return
            key = data.get('key') or None
            model = data.get('model') or None
            base_url = data.get('base_url') or None

            # Fill in provider/key/model from saved settings + credentials
            settings = library.get_settings(sid)
            if not provider:
                provider = settings.get('default_provider') or None
            if provider and provider in ai.PROVIDERS:
                cred = library.get_credential(sid, provider)
                if cred:
                    key = key or cred.get('api_key')
                    base_url = base_url or cred.get('base_url')
                    model = model or cred.get('model')
            if not model:
                model = settings.get('default_model') or None

            context, used = build_ai_context(sid, rid, project)
            system = AI_SYSTEM_PROMPT
            user_msg = (f"Context from the library:\n\n{context or '(empty)'}\n\n"
                        f"Question: {question}")
            messages = [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': user_msg},
            ]
            try:
                result = ai.chat(messages, provider=provider, key=key,
                                 model=model, base_url=base_url)
            except Exception as e:
                self.send_json({'error': str(e)}, 502)
                return
            self.send_json({
                'answer': result['answer'],
                'provider': result['provider'],
                'model': result['model'],
                'used': used,
            })
            return

        # ── Transcription: audio/video → text (NotebookLM media) ────
        if path == '/api/transcribe':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            rid = sanitize_id(data.get('id', ''))
            if not sid or not rid:
                self.send_json({'error': 'Bad request'}, 400)
                return
            rec = library.get(sid, rid)
            if not rec or not rec.get('filepath'):
                self.send_json({'error': 'No media file for this item'}, 404)
                return
            real = os.path.realpath(rec['filepath'])
            if not real.startswith(os.path.realpath(library.LIBRARY_ROOT) + os.sep) \
                    or not os.path.isfile(real):
                self.send_json({'error': 'File unavailable'}, 404)
                return
            if os.path.getsize(real) > 24 * 1024 * 1024:
                self.send_json({'error': 'File too large to transcribe (max ~24MB). '
                                'Use audio-only or shorter clips; chunking is coming.'}, 413)
                return
            # Resolve a transcription-capable provider (Groq or OpenAI)
            provider = data.get('provider') or None
            key = data.get('key') or None
            if not provider or not ai.transcribes(provider):
                provider = None
                for p in ('groq', 'openai'):
                    if library.get_credential(sid, p) or ai._env_key(p):
                        provider = p
                        break
            if not provider:
                self.send_json({'error': 'Connect Groq or OpenAI in Settings — '
                                'they handle transcription.'}, 400)
                return
            cred = library.get_credential(sid, provider)
            if cred and not key:
                key = cred.get('api_key')
            base_url = cred.get('base_url') if cred else None
            try:
                text = ai.transcribe(real, provider, key=key, base_url=base_url)
            except Exception as e:
                self.send_json({'error': f'Transcription failed: {e}'}, 502)
                return
            if not text:
                self.send_json({'error': 'Empty transcript'}, 502)
                return
            library.set_text(rid, text)
            self.send_json({'ok': True, 'chars': len(text), 'provider': provider})
            return

        # ── Projects (Phase D) ──────────────────────────────────────
        if path == '/api/projects':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            name = (data.get('name') or '').strip()[:80]
            if not sid or not name:
                self.send_json({'error': 'Name required'}, 400)
                return
            pid = secrets.token_urlsafe(12)
            self.send_json({'project': library.create_project(sid, name, pid)})
            return

        if path == '/api/projects/rename':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            pid = sanitize_id(data.get('id', ''))
            name = (data.get('name') or '').strip()[:80]
            if not sid or not pid or not name:
                self.send_json({'error': 'Bad request'}, 400)
                return
            self.send_json({'ok': library.rename_project(sid, pid, name)})
            return

        if path == '/api/projects/delete':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            pid = sanitize_id(data.get('id', ''))
            if not sid or not pid:
                self.send_json({'error': 'Bad request'}, 400)
                return
            self.send_json({'deleted': library.delete_project(sid, pid)})
            return

        if path == '/api/resource/move':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            rid = sanitize_id(data.get('id', ''))
            pid_raw = data.get('project') or ''
            pid = sanitize_id(pid_raw) if pid_raw else None
            if not sid or not rid:
                self.send_json({'error': 'Bad request'}, 400)
                return
            self.send_json({'moved': library.assign_resource(sid, rid, pid)})
            return

        # ── AI provider connections + settings (Phase D) ────────────
        if path == '/api/ai/connect':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            provider = data.get('provider')
            key = (data.get('key') or '').strip()
            base_url = (data.get('base_url') or '').strip() or None
            model = (data.get('model') or '').strip() or None
            if not sid or provider not in {'openai', 'anthropic', 'groq', 'openrouter', 'deepseek', 'glm', 'kimi', 'custom'}:
                self.send_json({'error': 'Unsupported provider'}, 400)
                return
            if not key:
                self.send_json({'error': 'API key required'}, 400)
                return
            if provider == 'custom' and not base_url:
                self.send_json({'error': 'Custom provider needs a base URL'}, 400)
                return
            library.set_credential(sid, provider, key, base_url, model, provider)
            self.send_json({'connected': True, 'provider': provider})
            return

        if path == '/api/ai/disconnect':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            provider = data.get('provider')
            if not sid or not provider:
                self.send_json({'error': 'Bad request'}, 400)
                return
            library.delete_credential(sid, provider)
            self.send_json({'ok': True})
            return

        if path == '/api/ai/settings':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            if not sid:
                self.send_json({'error': 'No session'}, 400)
                return
            provider = data.get('default_provider') or None
            if provider and provider not in ai.PROVIDERS:
                self.send_json({'error': 'Unknown provider'}, 400)
                return
            model = (data.get('default_model') or '').strip() or None
            library.set_settings(sid, provider, model)
            self.send_json({'ok': True})
            return

        if path == '/api/ai/models':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            provider = data.get('provider')
            if not provider or provider not in ai.PROVIDERS:
                self.send_json({'error': 'Unknown provider'}, 400)
                return
            key = data.get('key') or None
            base_url = data.get('base_url') or None
            if (not key) and sid:  # fall back to the stored credential
                cred = library.get_credential(sid, provider)
                if cred:
                    key = cred.get('api_key')
                    base_url = base_url or cred.get('base_url')
            try:
                models = ai.list_models(provider, key=key, base_url=base_url)
                self.send_json({'models': models})
            except Exception as e:
                self.send_json({'error': str(e)}, 502)
            return

        if path == '/api/access':
            data = self.read_json_body()
            if data is None:
                return
            sid = get_session(self)
            if not sid:
                self.send_json({'error': 'No session'}, 400)
                return
            library.set_access(sid,
                               (data.get('institution') or '').strip()[:200],
                               (data.get('r4l_user') or '').strip()[:120],
                               (data.get('r4l_pass') or '')[:200])
            self.send_json({'ok': True})
            return

        # ── Vault (API key encryption) ─────────────────────────────
        if path == '/api/vault/unlock':
            data = self.read_json_body()
            if data is None:
                return
            pw = (data.get('password') or '').strip()
            if not pw or len(pw) < 6:
                self.send_json({'error': 'Password must be at least 6 characters'}, 400)
                return
            v = _vault_mod.get_vault()
            if v.unlock(pw):
                self.send_json({'ok': True, 'keys': v.list_keys()})
            else:
                self.send_json({'error': 'Wrong password'}, 401)
            return

        if path == '/api/vault/lock':
            v = _vault_mod.get_vault()
            v._key = None
            v._fernet = None
            self.send_json({'ok': True})
            return

        if path == '/api/vault/add':
            data = self.read_json_body()
            if data is None:
                return
            v = _vault_mod.get_vault()
            if not v.is_unlocked():
                self.send_json({'error': 'Vault locked'}, 401)
                return
            provider = (data.get('provider') or '').strip().lower()
            key = (data.get('key') or '').strip()
            label = (data.get('label') or '').strip() or None
            if not provider or provider not in ('openai', 'anthropic', 'groq', 'openrouter', 'deepseek', 'glm', 'kimi', 'custom'):
                self.send_json({'error': 'Unsupported provider'}, 400)
                return
            if not key:
                self.send_json({'error': 'API key required'}, 400)
                return
            try:
                v.add_key(provider, key, label)
                sid = get_session(self)
                if sid:
                    base_url = (data.get('base_url') or '').strip() or None
                    model = (data.get('model') or '').strip() or None
                    library.set_credential(sid, provider, key, base_url, model, label)
                self.send_json({'ok': True, 'keys': v.list_keys()})
            except Exception as e:
                self.send_json({'error': str(e)}, 400)
            return

        if path == '/api/vault/remove':
            data = self.read_json_body()
            if data is None:
                return
            v = _vault_mod.get_vault()
            if not v.is_unlocked():
                self.send_json({'error': 'Vault locked'}, 401)
                return
            provider = (data.get('provider') or '').strip().lower()
            v.remove_key(provider)
            sid = get_session(self)
            if sid:
                library.delete_credential(sid, provider)
            self.send_json({'ok': True, 'keys': v.list_keys()})
            return

        if path == '/api/vault/test':
            data = self.read_json_body()
            if data is None:
                return
            v = _vault_mod.get_vault()
            if not v.is_unlocked():
                self.send_json({'error': 'Vault locked'}, 401)
                return
            provider = (data.get('provider') or '').strip().lower()
            if provider == 'openai':
                ok, msg = v.verify_key_openai()
            elif provider == 'anthropic':
                ok, msg = v.verify_key_anthropic()
            else:
                self.send_json({'error': 'Test not available for this provider'}, 400)
                return
            self.send_json({'valid': ok, 'message': msg})
            return

        if path == '/api/vault/list':
            v = _vault_mod.get_vault()
            if not v.is_unlocked():
                self.send_json({'error': 'Vault locked'}, 401)
                return
            self.send_json({'keys': v.list_keys()})
            return

        if path == '/api/vault/proxy':
            data = self.read_json_body(max_len=65536)
            if data is None:
                return
            v = _vault_mod.get_vault()
            if not v.is_unlocked():
                self.send_json({'error': 'Vault locked'}, 401)
                return
            provider = (data.get('provider') or '').strip().lower()
            messages = data.get('messages') or []
            model = data.get('model') or None
            if not provider or not messages:
                self.send_json({'error': 'Provider and messages required'}, 400)
                return
            key = v.get_key(provider)
            if not key:
                self.send_json({'error': f'No key stored for {provider}'}, 404)
                return
            try:
                result = ai.chat(messages, provider=provider, key=key, model=model)
                self.send_json(result)
            except Exception as e:
                self.send_json({'error': str(e)}, 502)
            return

        # ── Systematic review: search-strategy builder (PRESS / MeSH) ──
        if path == '/api/search/strategy':
            data = self.read_json_body(max_len=16384)
            if data is None:
                return
            sid = get_session(self)
            concepts = data.get('concepts')
            exclude = data.get('exclude') or []
            # If no concepts, decompose a free-text question into PRISM facets
            if not concepts:
                question = (data.get('question') or '').strip()
                if not question or len(question) > 2000:
                    self.send_json({'error': 'Provide PRISM facets or a question'}, 400)
                    return
                provider, key, model, base_url = self._resolve_ai(sid, data)
                try:
                    chat_fn = lambda msgs: ai.chat(msgs, provider=provider, key=key,
                                                   model=model, base_url=base_url)
                    concepts, exclude = searchstrat.concepts_from_question(question, chat_fn)
                except Exception as e:
                    self.send_json({'error': f'Could not decompose question: {e}'}, 502)
                    return
            # Sanitise facets (bound counts + lengths) — up to the 8 PRISM dimensions
            clean = []
            for c in (concepts or [])[:8]:
                terms = [str(t).strip()[:80] for t in (c.get('terms') or []) if str(t).strip()][:8]
                if terms:
                    op = str(c.get('op', 'AND')).upper()
                    clean.append({'label': str(c.get('label', ''))[:40], 'terms': terms,
                                  'op': op if op in ('AND', 'OR') else 'AND'})
            if not clean:
                self.send_json({'error': 'No usable facets'}, 400)
                return
            excl = [str(t).strip()[:80] for t in (exclude or []) if str(t).strip()][:12]
            try:
                self.send_json(searchstrat.build(clean, excl))
            except Exception as e:
                self.send_json({'error': f'Strategy build failed: {e}'}, 502)
            return

        # Run a strategy against a database → deduped records
        if path == '/api/search/run':
            data = self.read_json_body(max_len=16384)
            if data is None:
                return
            query = (data.get('query') or '').strip()
            if not query:
                self.send_json({'error': 'No query'}, 400)
                return
            source = data.get('source', 'pubmed')
            retmax = max(1, min(int(data.get('retmax', 50) or 50), 200))
            try:
                recs, totals = [], {}
                if source in ('pubmed', 'both'):
                    pm, tp = searchstrat.run_pubmed(query, retmax)
                    recs += pm
                    totals['pubmed'] = tp
                if source in ('europepmc', 'both'):
                    ep, te = searchstrat.run_europepmc(query, retmax)
                    recs += ep
                    totals['europepmc'] = te
                recs = searchstrat.dedupe(recs)
                self.send_json({'records': recs, 'count': len(recs), 'totals': totals})
            except Exception as e:
                self.send_json({'error': f'Search failed: {e}'}, 502)
            return

        # Export the records the client holds as a downloadable RIS / CSV file
        if path == '/api/search/export':
            data = self.read_json_body(max_len=1048576)
            if data is None:
                return
            records = data.get('records') or []
            fmt = data.get('format', 'ris')
            if not isinstance(records, list) or not records:
                self.send_json({'error': 'No records'}, 400)
                return
            if fmt == 'csv':
                body = searchstrat.to_csv(records).encode()
                ct, fn = 'text/csv', 'search-results.csv'
            else:
                body = searchstrat.to_ris(records).encode()
                ct, fn = 'application/x-research-info-systems', 'search-results.ris'
            self.send_response(200)
            self.send_header('Content-Type', ct)
            self.send_header('Content-Length', len(body))
            self.send_header('Content-Disposition', f'attachment; filename="{fn}"')
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        # Import records into the sandbox as references (optionally a project)
        if path == '/api/search/import':
            data = self.read_json_body(max_len=1048576)
            if data is None:
                return
            sid = get_session(self)
            if not sid:
                self.send_json({'error': 'No session'}, 400)
                return
            records = data.get('records') or []
            if not isinstance(records, list) or not records:
                self.send_json({'error': 'No records'}, 400)
                return
            project_id = sanitize_id(data.get('project_id', '')) if data.get('project_id') else None
            name = (data.get('project_name') or '').strip()[:80]
            if name and not project_id:
                project_id = secrets.token_urlsafe(12)
                library.create_project(sid, name, project_id)
            n = 0
            for rec in records[:500]:
                if not isinstance(rec, dict):
                    continue
                library.add_reference(sid, secrets.token_urlsafe(12), project_id, rec)
                n += 1
            self.send_json({'imported': n, 'project_id': project_id})
            return

        self.send_error(404)

    def _resolve_ai(self, sid, data):
        """Resolve (provider, key, model, base_url) from request + saved settings."""
        provider = data.get('provider') or None
        key = data.get('key') or None
        model = data.get('model') or None
        base_url = data.get('base_url') or None
        settings = library.get_settings(sid) if sid else {}
        if not provider:
            provider = settings.get('default_provider') or None
        if provider and provider in ai.PROVIDERS and sid:
            cred = library.get_credential(sid, provider)
            if cred:
                key = key or cred.get('api_key')
                base_url = base_url or cred.get('base_url')
                model = model or cred.get('model')
        if not model:
            model = settings.get('default_model') or None
        return provider, key, model, base_url

    def _run_provider(self, provider, url, opts, did, session):
        global ACTIVE_DOWNLOADS
        try:
            provider.resolve(url, opts, did)
            with downloads_lock:
                job = dict(downloads.get(did, {}))
            try:
                rec = library.persist(job, did, session, url)
                if rec and rec.get('filepath'):
                    # Point the in-flight job at the persisted copy so an
                    # immediate stream request still resolves.
                    with downloads_lock:
                        if did in downloads:
                            downloads[did]['filepath'] = rec['filepath']
                    # Durable storage: sync to the user's Drive when connected
                    drive_autosync(session, rec)
            except Exception as e:
                print(f"[library] persist failed: {e}", file=sys.stderr)
        finally:
            with downloads_lock:
                ACTIVE_DOWNLOADS -= 1

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == '__main__':
    print(f"Resource Shrimp running on http://0.0.0.0:{PORT}", file=sys.stderr)
    start_pot_provider()   # warm the YouTube token refresher (no-op if absent)
    srv = ThreadedHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)
        srv.shutdown()
