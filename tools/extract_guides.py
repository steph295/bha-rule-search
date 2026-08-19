#!/usr/bin/env python3
"""
Build data/guides.json from the PDF library at
https://www.britishhorseracing.com/regulation/rules-guides/

Downloads every linked PDF (via curl — the system python has no CA bundle),
extracts its text layer and chunks it into searchable entries:

  * BHAGI sections split into individual instructions ("BHAGI 1.2"), which is
    how they are cited. Title comes from the instruction's Subject: line.
  * Every other document is chunked into readable blocks (~2.5k chars),
    titled by the first line of the block.

Usage:  python3 tools/extract_guides.py [--no-fetch]

Requires: pypdf  (pip install pypdf)
"""
import hashlib
import json
import os
import re
import subprocess
import sys

PAGE_URL = 'https://www.britishhorseracing.com/regulation/rules-guides/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data', 'guide-pdfs')
OUT = os.path.join(ROOT, 'data', 'guides.json')

# The pre-2019 rulebook is superseded by the live Rules of Racing that the app
# already indexes. Showing stewards withdrawn rules mid-inquiry is a hazard, so
# it is excluded; drop the entry here to include it.
SKIP_URL_PARTS = ['BHA_Rules_Of_Racing.pdf']

MAX_CHUNK = 2500          # chars per chunk for non-BHAGI documents
UA = 'Mozilla/5.0 (Macintosh) BHARulesSearch/1.0'


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def clean(s):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', s or '')).strip()


def fetch_page():
    r = sh(['curl', '-sL', '--max-time', '120', '-A', UA, PAGE_URL])
    if r.returncode != 0 or len(r.stdout) < 5000:
        sys.exit(f'could not fetch {PAGE_URL}')
    return r.stdout


def parse_links(html):
    m = re.search(r'<main.*?</main>', html, re.S)
    body = m.group(0) if m else html
    toks = re.findall(r'<h([1-4])[^>]*>(.*?)</h\1>|<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', body, re.S)
    items, cat = [], None
    seen = set()
    for lvl, htxt, href, atxt in toks:
        if lvl:
            cat = clean(htxt)
            continue
        if not href or '.pdf' not in href.lower():
            continue
        url = href.strip().replace(' ', '%20')
        if url.startswith('http://'):
            url = 'https://' + url[7:]
        if any(p in url for p in SKIP_URL_PARTS) or url in seen:
            continue
        seen.add(url)
        title = re.sub(r'\s*\d+(\.\d+)?\s*[KM]B$', '', clean(atxt))
        # some links read "here"/"click here" — fall back to the section heading
        if len(title) < 5 or title.lower().strip('. ') in ('here', 'click here', 'link', 'pdf'):
            title = cat or 'Guide'
        items.append({
            'cat': cat or 'Guides',
            'title': title,
            'url': url,
            'file': os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest()[:12] + '.pdf'),
        })
    return items


def download(items):
    os.makedirs(CACHE, exist_ok=True)
    for i, it in enumerate(items, 1):
        if os.path.exists(it['file']) and os.path.getsize(it['file']) > 1000:
            continue
        r = sh(['curl', '-sL', '--max-time', '180', '-A', UA, it['url'], '-o', it['file']])
        ok = os.path.exists(it['file']) and os.path.getsize(it['file']) > 1000
        print(f"  [{i}/{len(items)}] {'ok  ' if ok else 'FAIL'} {it['title'][:56]}")


def page_texts(path):
    from pypdf import PdfReader
    try:
        reader = PdfReader(path)
    except Exception as e:
        print('   ! unreadable:', path, e)
        return []
    out = []
    for p in reader.pages:
        try:
            out.append(p.extract_text() or '')
        except Exception:
            out.append('')
    return out


def tidy(text):
    """Normalise PDF text: join hard-wrapped lines, drop page furniture."""
    text = text.replace('\r', '')
    text = re.sub(r'[ \t]+', ' ', text)
    # pypdf sometimes splits words across a line break mid-token ("o f the")
    lines = [ln.strip() for ln in text.split('\n')]
    lines = [ln for ln in lines if not re.fullmatch(r'(page\s*)?\d{1,3}( of \d{1,3})?', ln, re.I)]
    return lines


def blocks_from_lines(lines):
    """Group lines into paragraphs on blank-line boundaries."""
    paras, cur = [], []
    for ln in lines:
        if not ln:
            if cur:
                paras.append(' '.join(cur))
                cur = []
        else:
            cur.append(ln)
    if cur:
        paras.append(' '.join(cur))
    return [re.sub(r'\s+', ' ', p).strip() for p in paras if p.strip()]


def esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


LEVEL_RE = re.compile(r'^(\d+\.\d+\.\d+|\d+\.\d+|\d+\.|\(?[a-z]\)|\(?[ivx]+\))\s+', re.I)


def render(paras):
    """Paragraphs -> the same html shape the rulebook parser emits."""
    html = []
    for p in paras:
        m = LEVEL_RE.match(p)
        if m:
            marker = m.group(1).rstrip('.')
            rest = p[m.end():]
            cls = 'l2' if re.match(r'^\(?[a-z]\)|\(?[ivx]+\)', m.group(1), re.I) else 'l1'
            html.append(f'<p class="{cls}"><span class="rn">{esc(marker)}</span>{esc(rest)}</p>')
        else:
            html.append(f'<p class="l0">{esc(p)}</p>')
    return ''.join(html)


BHAGI_SPLIT = re.compile(r'BHA\s+GENERAL\s+INSTRUCTIONS\s*\n+\s*BHAGI\s*(\d+)\.(\d+)', re.I)


def parse_bhagi(item, pages):
    """Split a BHAGI section PDF into one entry per instruction."""
    entries = []
    # keep a page index so we can deep-link into the PDF
    offsets, joined = [], ''
    for pn, t in enumerate(pages, 1):
        offsets.append((len(joined), pn))
        joined += t + '\n'

    def page_of(pos):
        pg = 1
        for off, pn in offsets:
            if off <= pos:
                pg = pn
            else:
                break
        return pg

    marks = list(BHAGI_SPLIT.finditer(joined))
    if not marks:
        return None
    for i, m in enumerate(marks):
        start = m.start()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(joined)
        chunk = joined[start:end]
        code = f'BHAGI {m.group(1)}.{m.group(2)}'
        lines = tidy(chunk)
        paras = blocks_from_lines(lines)

        subject, dated, body = '', '', []
        for p in paras:
            # the header block usually arrives as one run-together paragraph:
            # "To: ... From: ... Subject: TITLE" — pull Subject out of it first
            ms = re.search(r'\bSubject\s*:\s*(.+?)(?:\s*(?:To|From|Circulation)\s*:|$)', p, re.I | re.S)
            if ms and not subject:
                subject = re.sub(r'\s+', ' ', ms.group(1)).strip()
            d = re.search(r'\bDtd\.?\s+([0-9].{0,24})', p, re.I)
            if d and not dated:
                dated = d.group(1).strip()
            if re.match(r'^BHA GENERAL INSTRUCTIONS', p, re.I):
                continue
            if re.match(r'^BHAGI\s*\d+\.\d+', p, re.I):
                continue
            if re.match(r'^Dtd\b', p, re.I):
                continue
            if re.match(r'^(To|From|Circulation|Subject)\s*:', p, re.I):
                continue
            body.append(p)

        title = subject.title() if subject.isupper() else subject
        title = title or f'Instruction {code}'
        title = re.sub(r'\bBha\b', 'BHA', title)
        entries.append({
            'code': code,
            'kind': 'bhagi',
            'doc': item['title'],
            'cat': item['cat'],
            'title': title,
            'dated': dated,
            'url': item['url'],
            'page': page_of(start),
            'html': render(body),
            'plain': ' '.join(body),
        })
    return entries


def heading_or(first, fallback):
    """Use a chunk's opening line as its title only when it reads like a heading."""
    h = re.sub(r'^[•\-•\s]+', '', re.sub(r'\s+', ' ', first)).strip(' .:;-')
    if (12 <= len(h) <= 90
            and not LEVEL_RE.match(h)
            and h[:1].isupper()
            and not re.search(r'[,;]$|\b(and|or|the|of|to|for|a|an|in|is|are|that|which)$', h, re.I)):
        return h.title() if h.isupper() else h
    return fallback


def parse_generic(item, pages):
    """Chunk any other document into ~MAX_CHUNK blocks, titled by first line."""
    entries = []
    buf, buf_pages = [], []
    doc_title = item['title']

    def flush():
        if not buf:
            return
        paras = list(buf)
        title = heading_or(paras[0], doc_title)
        entries.append({
            'code': None,
            'kind': 'guide',
            'doc': doc_title,
            'cat': item['cat'],
            'title': title or doc_title,
            'dated': '',
            'url': item['url'],
            'page': buf_pages[0],
            'html': render(paras),
            'plain': ' '.join(paras),
        })
        buf.clear()
        buf_pages.clear()

    for pn, t in enumerate(pages, 1):
        for p in blocks_from_lines(tidy(t)):
            buf.append(p)
            buf_pages.append(pn)
            if sum(len(x) for x in buf) >= MAX_CHUNK:
                flush()
    flush()
    return entries


def main():
    if '--no-fetch' not in sys.argv:
        print('Fetching guide index…')
        items = parse_links(fetch_page())
        json.dump(items, open(os.path.join(ROOT, 'data', 'guide-index.json'), 'w'), indent=1)
        print(f'  {len(items)} PDFs listed')
        download(items)
    else:
        items = json.load(open(os.path.join(ROOT, 'data', 'guide-index.json')))

    all_entries = []
    for it in items:
        if not (os.path.exists(it['file']) and os.path.getsize(it['file']) > 1000):
            continue
        pages = page_texts(it['file'])
        if not pages:
            continue
        ents = None
        if 'BHAGI' in it['cat'].upper() and 'index' not in it['title'].lower():
            ents = parse_bhagi(it, pages)
        if ents is None:
            ents = parse_generic(it, pages)
        # drop empty / boilerplate-only chunks
        ents = [e for e in ents if len(e['plain']) > 120]
        for e in ents:
            del e['plain']  # the browser derives it from html; storing both doubles the payload
        all_entries.extend(ents)
        print(f"  {len(ents):4d} entries  {it['title'][:55]}")

    payload = {
        'source': PAGE_URL,
        'documents': len({e['url'] for e in all_entries}),
        'entries': all_entries,
    }
    json.dump(payload, open(OUT, 'w'), separators=(',', ':'))
    kb = os.path.getsize(OUT) // 1024
    bh = sum(1 for e in all_entries if e['kind'] == 'bhagi')
    print(f'\n{len(all_entries)} entries ({bh} BHAGI instructions) from '
          f"{payload['documents']} documents -> data/guides.json ({kb} KB)")


if __name__ == '__main__':
    main()
