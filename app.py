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
from datetime import datetime
from urllib.parse import urlparse, parse_qs, quote, unquote
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import mimetypes

PORT = int(os.environ.get("PORT", 8080))
BASE = os.path.dirname(os.path.abspath(__file__))
TEMP_ROOT = tempfile.mkdtemp(prefix="rshrimp_")

# ── In-memory state (replaces Flask globals) ────────────────────────
downloads = {}          # id -> dict
downloads_lock = threading.Lock()
ACTIVE_DOWNLOADS = 0
MAX_CONCURRENT = 5
MAX_URL_LEN = 2048

# ── Rate limiter ────────────────────────────────────────────────────
_rate = {}  # ip -> [timestamps]
RATE_LIMIT = 10          # requests per window
RATE_WINDOW = 60         # seconds

def rate_check(ip):
    now = time.time()
    _rate.setdefault(ip, [])
    _rate[ip] = [t for t in _rate[ip] if now - t < RATE_WINDOW]
    if len(_rate[ip]) >= RATE_LIMIT:
        return False
    _rate[ip].append(now)
    return True

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
    if re.search(r'springer|wiley|sciencedirect|nature\.com|science\.org|ieee|acm', u):
        return 'academic'
    return 'video'

def extract_doi(url):
    url = url.strip()
    if re.match(r'^10\.\d{4,}/', url):
        return url
    m = re.search(r'(?:doi\.org|dx\.doi\.org)/(10\.\d{4,}/[^\s]+)', url)
    return m.group(1) if m else None

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
            title = re.search(r'<title>(.*?)</title>', t, re.DOTALL)
            summary = re.search(r'<summary>(.*?)</summary>', t, re.DOTALL)
            authors = re.findall(r'<name>(.*?)</name>', t)
            return {
                'title': title.group(1).strip() if title else 'Unknown',
                'abstract': summary.group(1).strip() if summary else '',
                'authors': authors,
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
            with downloads_lock:
                downloads[did].update({'status': 'error', 'error': err, 'message': f'yt-dlp error: {err}'})
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
        pdf_url = None

        with downloads_lock:
            downloads[did].update({'status': 'fetching', 'phase': 'fetching', 'message': 'Searching databases...'})

        if url_type == 'arxiv':
            paper_info = fetch_arxiv(url)
            if paper_info:
                pdf_url = paper_info.get('pdf_url')
                paper_info['source'] = 'arXiv'
        elif url_type == 'doi':
            doi = extract_doi(url)
            if doi:
                paper_info = fetch_openalex(doi=doi)
                oa = fetch_unpaywall(doi)
                if paper_info:
                    paper_info['doi'] = doi
                    paper_info['source'] = 'OpenAlex'
                if oa and oa.get('pdf_url'):
                    pdf_url = oa['pdf_url']
                elif not pdf_url:
                    pdf_url = fetch_scihub(doi)
        else:
            paper_info = fetch_openalex(search=url)
            if paper_info:
                paper_info['source'] = 'OpenAlex'
                doi_raw = paper_info.get('doi', '')
                doi = doi_raw.replace('https://doi.org/', '') if doi_raw else None
                if doi:
                    oa = fetch_unpaywall(doi)
                    if oa and oa.get('pdf_url'):
                        pdf_url = oa['pdf_url']
                    elif not pdf_url:
                        pdf_url = fetch_scihub(doi)

        if not paper_info:
            raise ValueError("Could not find paper. Check the URL or try a DOI.")

        title = paper_info.get('title', 'Paper')
        clean_title = sanitize_filename(title)[:100]

        with downloads_lock:
            downloads[did].update({
                'status': 'downloading', 'phase': 'fetching', 'message': 'Downloading paper...',
                'title': title,
                'authors': [a.get('author', {}).get('display_name', '') for a in paper_info.get('authorships', [])[:10]],
                'doi': paper_info.get('doi', ''),
                'journal': (paper_info.get('primary_location') or {}).get('source', {}).get('display_name', '') if paper_info.get('primary_location') else '',
                'year': paper_info.get('publication_year', ''),
                'pdf_url': pdf_url,
            })

        if pdf_url:
            data, code, headers = http_get(pdf_url, timeout=30)
            ct = headers.get('Content-Type', '').lower()
            if code == 200 and ('pdf' in ct or pdf_url.lower().endswith('.pdf')):
                pdf_path = os.path.join(temp_dir, f"{clean_title}.pdf")
                with open(pdf_path, 'wb') as f:
                    f.write(data)
                with downloads_lock:
                    downloads[did].update({
                        'status': 'complete', 'phase': 'ready', 'progress': '100',
                        'filename': f"{clean_title}.pdf", 'filepath': pdf_path,
                        'message': 'Paper downloaded!', 'has_pdf': True,
                    })
            else:
                with downloads_lock:
                    downloads[did].update({
                        'status': 'complete', 'phase': 'ready', 'progress': '100',
                        'message': 'Paper found', 'has_pdf': False,
                    })
        else:
            with downloads_lock:
                downloads[did].update({
                    'status': 'complete', 'phase': 'ready', 'progress': '100',
                    'message': 'Paper found', 'has_pdf': False,
                })

    except Exception as e:
        with downloads_lock:
            downloads[did].update({'status': 'error', 'error': str(e), 'message': f'Error: {e}'})

# ── HTTP request handler ────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {args[0]}", file=sys.stderr)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(body)

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
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', len(body))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        ip = self.client_address[0]
        if not rate_check(ip):
            self.send_json({'error': 'Rate limit exceeded'}, 429)
            return

        parsed = urlparse(self.path)
        path = unquote(parsed.path)

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
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(body)
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
                info = downloads.get(did, {'status': 'not_found'})
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
            with downloads_lock:
                info = downloads.get(did)
            if not info or info.get('status') != 'complete':
                self.send_json({'error': 'File not ready'}, 404)
                return

            filepath = info.get('filepath')
            if not filepath:
                self.send_json({'error': 'No file path'}, 404)
                return

            # Path traversal check
            real = os.path.realpath(filepath)
            if not real.startswith(os.path.realpath(TEMP_ROOT)):
                self.send_json({'error': 'Access denied'}, 403)
                return
            if not os.path.isfile(real):
                self.send_json({'error': 'File not found'}, 404)
                return

            filename = sanitize_filename(info.get('filename', 'download'))
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

            # Cleanup after streaming
            try:
                temp_dir = info.get('temp_dir')
                if temp_dir and os.path.exists(temp_dir):
                    shutil.rmtree(temp_dir, ignore_errors=True)
                with downloads_lock:
                    downloads.pop(did, None)
            except Exception:
                pass
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
            if length > 8192:
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

            # Concurrency limit
            global ACTIVE_DOWNLOADS
            if ACTIVE_DOWNLOADS >= MAX_CONCURRENT:
                self.send_json({'error': 'Too many concurrent downloads'}, 429)
                return

            did = secrets.token_urlsafe(16)
            url_type = detect_url_type(url) if dl_type == 'auto' else dl_type

            with downloads_lock:
                ACTIVE_DOWNLOADS += 1

            if url_type == 'video':
                t = threading.Thread(target=self._run_video, args=(url, did, quality, subtitles, fmt), daemon=True)
            else:
                t = threading.Thread(target=self._run_article, args=(url, did), daemon=True)
            t.start()
            self.send_json({'download_id': did, 'type': url_type})
            return

        self.send_error(404)

    def _run_video(self, url, did, quality, subtitles, fmt):
        global ACTIVE_DOWNLOADS
        try:
            download_video(url, did, quality, subtitles, fmt)
        finally:
            with downloads_lock:
                ACTIVE_DOWNLOADS -= 1

    def _run_article(self, url, did):
        global ACTIVE_DOWNLOADS
        try:
            download_article(url, did)
        finally:
            with downloads_lock:
                ACTIVE_DOWNLOADS -= 1

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == '__main__':
    print(f"Resource Shrimp running on http://0.0.0.0:{PORT}", file=sys.stderr)
    srv = ThreadedHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)
        srv.shutdown()
