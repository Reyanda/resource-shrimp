#!/usr/bin/env python3
"""
Resource Shrimp — Download videos, papers, and articles
Uses yt-dlp for videos + OpenAlex/Sci-Hub for academic papers
"""

from flask import Flask, render_template, request, send_file, jsonify
import os
import tempfile
import yt_dlp
import threading
import requests
import re
from datetime import datetime
from urllib.parse import quote
import hashlib

app = Flask(__name__)

downloads = {}
download_history = []

OPENALEX_API = "https://api.openalex.org"
UNPAYWALL_EMAIL = "downloader@resourceshrimp.app"
SCIHUB_URL = "https://sci-hub.su"


def detect_url_type(url):
    url_lower = url.lower().strip()
    if re.search(r'^10\.\d{4,}/', url_lower) or 'doi.org/10.' in url_lower or 'dx.doi.org/10.' in url_lower:
        return 'doi'
    if 'arxiv.org' in url_lower:
        return 'arxiv'
    if 'pubmed' in url_lower or 'ncbi.nlm.nih.gov' in url_lower:
        return 'pubmed'
    if re.search(r'springer|wiley|sciencedirect|nature\.com|science\.org|ieee|acm', url_lower):
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
            r = requests.get(f"{OPENALEX_API}/works/doi:{doi}", headers={'User-Agent': 'ResourceShrimp/1.0'}, timeout=15)
        elif search:
            r = requests.get(f"{OPENALEX_API}/works?search={quote(search)}&per_page=1", headers={'User-Agent': 'ResourceShrimp/1.0'}, timeout=15)
        else:
            return None
        if r.status_code == 200:
            d = r.json()
            return d['results'][0] if 'results' in d and d['results'] else (d if 'id' in d else None)
    except Exception as e:
        print(f"OpenAlex error: {e}")
    return None


def fetch_unpaywall(doi):
    try:
        r = requests.get(f"https://api.unpaywall.org/v2/{doi}?email={UNPAYWALL_EMAIL}", timeout=10)
        if r.status_code == 200:
            d = r.json()
            best = d.get('best_oa_location', {})
            if best:
                return {
                    'pdf_url': best.get('url_for_pdf') or best.get('url'),
                    'is_oa': d.get('is_oa', False),
                    'oa_status': d.get('oa_status', 'unknown'),
                }
    except Exception as e:
        print(f"Unpaywall error: {e}")
    return None


def fetch_scihub(doi):
    try:
        r = requests.get(f"{SCIHUB_URL}/{doi}", timeout=15, headers={'User-Agent': 'Mozilla/5.0'})
        if r.status_code == 200:
            m = re.search(r'src="(https?://[^"]*\.pdf[^"]*)"', r.text, re.I)
            if m:
                return m.group(1)
            m = re.search(r'(https?://[^"\']*sci-hub[^"\']*\.pdf)', r.text, re.I)
            if m:
                return m.group(1)
            return f"{SCIHUB_URL}/{doi}"
    except Exception as e:
        print(f"Sci-Hub error: {e}")
    return None


def fetch_arxiv(arxiv_url):
    try:
        m = re.search(r'arxiv\.org/(?:abs|pdf)/(\d+\.\d+)', arxiv_url)
        if not m:
            return None
        aid = m.group(1)
        r = requests.get(f"http://export.arxiv.org/api/query?id_list={aid}", timeout=10)
        if r.status_code == 200:
            t = r.text
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
        print(f"arXiv error: {e}")
    return None


def progress_hook(d, download_id):
    if d['status'] == 'downloading':
        downloads[download_id].update({
            'status': 'downloading',
            'phase': 'fetching',
            'progress': d.get('_percent_str', '0%').strip('%'),
            'speed': d.get('_speed_str', 'N/A'),
            'eta': d.get('_eta_str', 'N/A'),
            'size': d.get('_total_bytes_str', d.get('_total_bytes_estimate_str', 'N/A')),
            'downloaded': d.get('_downloaded_bytes_str', 'N/A'),
            'message': 'Downloading from source...'
        })
    elif d['status'] == 'finished':
        downloads[download_id].update({
            'status': 'processing',
            'phase': 'encoding',
            'progress': '100',
            'speed': '--',
            'eta': '--',
            'message': 'Processing...'
        })


def download_video(url, download_id, quality='1080p', subtitles=False, format_type='mp4'):
    temp_dir = tempfile.mkdtemp()

    downloads[download_id] = {
        'status': 'starting', 'phase': 'init', 'type': 'video',
        'progress': '0', 'speed': 'N/A', 'eta': 'N/A', 'size': 'N/A', 'downloaded': 'N/A',
        'filename': None, 'error': None, 'message': 'Initializing...',
        'temp_dir': temp_dir, 'url': url
    }

    quality_map = {
        '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
        '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
        '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
        '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
        '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
        'best': 'bestvideo+bestaudio/best',
        'audio': 'bestaudio/best',
    }

    fmt_map = {
        'mp3': {'codec': 'mp3', 'q': '320'},
        'flac': {'codec': 'flac', 'q': '0'},
        'wav': {'codec': 'wav', 'q': '0'},
        'opus': {'codec': 'opus', 'q': '256'},
        'aac': {'codec': 'aac', 'q': '256'},
    }

    ydl_opts = {
        'format': quality_map.get(quality, quality_map['1080p']),
        'outtmpl': os.path.join(temp_dir, '%(title)s.%(ext)s'),
        'progress_hooks': [lambda d: progress_hook(d, download_id)],
    }

    if quality == 'audio' or format_type in fmt_map:
        ci = fmt_map.get(format_type, {'codec': 'mp3', 'q': '320'})
        ydl_opts['format'] = 'bestaudio/best'
        ydl_opts['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': ci['codec'], 'preferredquality': ci['q']}]
    else:
        ydl_opts['merge_output_format'] = 'mp4'

    if subtitles:
        ydl_opts['writesubtitles'] = True
        ydl_opts['writeautomaticsub'] = True
        ydl_opts['subtitleslangs'] = ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko']

    try:
        downloads[download_id].update({'status': 'downloading', 'message': 'Starting download...'})
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if 'entries' in info:
                info = info['entries'][0]
            base = os.path.splitext(ydl.prepare_filename(info))[0]
            ext = format_type if format_type in fmt_map else 'mp4'
            final_filename = f"{base}.{ext}"

        filepath = os.path.join(temp_dir, final_filename)
        if not os.path.exists(filepath):
            for f in os.listdir(temp_dir):
                if any(f.endswith(f'.{e}') for e in [ext, 'webm', 'mkv', 'mp4', 'mp3', 'm4a']):
                    filepath = os.path.join(temp_dir, f)
                    final_filename = f
                    break

        downloads[download_id].update({
            'status': 'complete', 'phase': 'ready', 'progress': '100',
            'filename': os.path.basename(filepath), 'filepath': filepath,
            'message': 'Download complete!',
            'title': info.get('title', 'Unknown'),
            'uploader': info.get('uploader', 'Unknown'),
            'duration': info.get('duration', 0),
            'thumbnail': info.get('thumbnail', ''),
        })

        download_history.append({
            'id': download_id, 'type': 'video',
            'title': info.get('title', 'Unknown'), 'url': url,
            'timestamp': datetime.now().isoformat(),
        })

    except Exception as e:
        downloads[download_id].update({'status': 'error', 'error': str(e), 'message': f'Error: {str(e)}'})


def download_article(url, download_id):
    temp_dir = tempfile.mkdtemp()

    downloads[download_id] = {
        'status': 'starting', 'phase': 'init', 'type': 'article',
        'progress': '0', 'speed': 'N/A', 'eta': 'N/A', 'size': 'N/A', 'downloaded': 'N/A',
        'filename': None, 'error': None, 'message': 'Resolving paper...',
        'temp_dir': temp_dir, 'url': url
    }

    try:
        url_type = detect_url_type(url)
        paper_info = None
        pdf_url = None

        downloads[download_id].update({'status': 'fetching', 'phase': 'fetching', 'message': 'Searching databases...'})

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
                doi = paper_info.get('doi', '').replace('https://doi.org/', '') if paper_info.get('doi') else None
                if doi:
                    oa = fetch_unpaywall(doi)
                    if oa and oa.get('pdf_url'):
                        pdf_url = oa['pdf_url']
                    elif not pdf_url:
                        pdf_url = fetch_scihub(doi)

        if not paper_info:
            raise ValueError("Could not find paper. Check the URL or try a DOI.")

        title = paper_info.get('title', 'Paper')
        clean_title = re.sub(r'[^\w\s-]', '', title)[:100].strip()

        downloads[download_id].update({
            'status': 'downloading', 'phase': 'fetching', 'message': 'Downloading paper...',
            'title': title,
            'authors': [a.get('author', {}).get('display_name', '') for a in paper_info.get('authorships', [])[:10]],
            'doi': paper_info.get('doi', ''),
            'journal': paper_info.get('primary_location', {}).get('source', {}).get('display_name', '') if paper_info.get('primary_location') else '',
            'year': paper_info.get('publication_year', ''),
            'pdf_url': pdf_url,
        })

        if pdf_url:
            try:
                pdf_r = requests.get(pdf_url, timeout=30, headers={'User-Agent': 'Mozilla/5.0 (compatible; ResourceShrimp/1.0)'})
                if pdf_r.status_code == 200 and 'pdf' in pdf_r.headers.get('content-type', '').lower():
                    pdf_path = os.path.join(temp_dir, f"{clean_title}.pdf")
                    with open(pdf_path, 'wb') as f:
                        f.write(pdf_r.content)
                    downloads[download_id].update({
                        'status': 'complete', 'phase': 'ready', 'progress': '100',
                        'filename': f"{clean_title}.pdf", 'filepath': pdf_path,
                        'message': 'Paper downloaded!', 'has_pdf': True,
                    })
                else:
                    downloads[download_id].update({
                        'status': 'complete', 'phase': 'ready', 'progress': '100',
                        'message': 'Paper found — opening in browser', 'has_pdf': False,
                    })
                    if paper_info.get('doi'):
                        import webbrowser
                        webbrowser.open(f"https://doi.org/{paper_info['doi']}")
            except Exception as e:
                print(f"PDF download error: {e}")
                downloads[download_id].update({
                    'status': 'complete', 'phase': 'ready', 'progress': '100',
                    'message': 'Paper found — opening in browser', 'has_pdf': False,
                })
                if paper_info.get('doi'):
                    import webbrowser
                    webbrowser.open(f"https://doi.org/{paper_info['doi']}")
        else:
            downloads[download_id].update({
                'status': 'complete', 'phase': 'ready', 'progress': '100',
                'message': 'Paper found — opening in browser', 'has_pdf': False,
            })
            if paper_info.get('doi'):
                import webbrowser
                webbrowser.open(f"https://doi.org/{paper_info['doi']}")

        download_history.append({
            'id': download_id, 'type': 'article', 'title': title, 'url': url,
            'timestamp': datetime.now().isoformat(),
        })

    except Exception as e:
        downloads[download_id].update({'status': 'error', 'error': str(e), 'message': f'Error: {str(e)}'})


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/detect', methods=['POST'])
def detect_content():
    url = request.json.get('url', '')
    url_type = detect_url_type(url)
    info = {
        'video': {'label': 'Video', 'icon': '🎬'},
        'doi': {'label': 'Paper (DOI)', 'icon': '📄'},
        'arxiv': {'label': 'arXiv Paper', 'icon': '📑'},
        'pubmed': {'label': 'PubMed', 'icon': '🏥'},
        'academic': {'label': 'Article', 'icon': '📚'},
    }.get(url_type, {'label': 'Video', 'icon': '🎬'})
    return jsonify({'type': url_type, 'info': info})


@app.route('/download', methods=['POST'])
def start_download():
    data = request.json
    url = data.get('url')
    download_type = data.get('type', 'auto')
    quality = data.get('quality', '1080p')
    format_type = data.get('format', 'mp4')
    subtitles = data.get('subtitles', False)

    if not url:
        return jsonify({'error': 'No URL provided'}), 400

    download_id = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    url_type = detect_url_type(url) if download_type == 'auto' else download_type

    if url_type == 'video':
        t = threading.Thread(target=download_video, args=(url, download_id, quality, subtitles, format_type))
    else:
        t = threading.Thread(target=download_article, args=(url, download_id))
    t.start()

    return jsonify({'download_id': download_id, 'type': url_type})


@app.route('/status/<download_id>')
def check_status(download_id):
    return jsonify(downloads.get(download_id, {'status': 'not_found'}))


@app.route('/stream/<download_id>')
def stream_file(download_id):
    download = downloads.get(download_id)
    if not download or download['status'] != 'complete':
        return jsonify({'error': 'File not ready'}), 404

    filepath = download.get('filepath')
    if not filepath or not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404

    filename = download.get('filename', 'download')
    mimetype = 'application/pdf' if filename.endswith('.pdf') else 'audio/mpeg' if filename.endswith('.mp3') else 'video/mp4'

    def cleanup():
        try:
            temp_dir = download.get('temp_dir')
            if temp_dir and os.path.exists(temp_dir):
                import shutil
                shutil.rmtree(temp_dir, ignore_errors=True)
            downloads.pop(download_id, None)
        except: pass

    response = send_file(filepath, mimetype=mimetype, as_attachment=True, download_name=filename)
    response.call_on_close(cleanup)
    return response


@app.route('/supported-sites')
def supported_sites():
    return jsonify([
        {'name': 'YouTube', 'icon': '📺', 'type': 'video'},
        {'name': 'Vimeo', 'icon': '🎬', 'type': 'video'},
        {'name': 'TikTok', 'icon': '🎵', 'type': 'video'},
        {'name': 'Twitter/X', 'icon': '🐦', 'type': 'video'},
        {'name': 'Instagram', 'icon': '📸', 'type': 'video'},
        {'name': 'Reddit', 'icon': '🔴', 'type': 'video'},
        {'name': 'Twitch', 'icon': '🎮', 'type': 'video'},
        {'name': 'Bilibili', 'icon': '📺', 'type': 'video'},
        {'name': 'arXiv', 'icon': '📑', 'type': 'article'},
        {'name': 'DOI', 'icon': '📄', 'type': 'article'},
        {'name': 'PubMed', 'icon': '🏥', 'type': 'article'},
        {'name': 'Sci-Hub', 'icon': '📚', 'type': 'article'},
    ])


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    debug = os.environ.get('FLASK_ENV') != 'production'
    app.run(debug=debug, host='0.0.0.0', port=port)
