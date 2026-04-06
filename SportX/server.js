const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 8082;
const ROOT = path.dirname(__filename);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

/* ─── Catches proxy ─────────────────────────────────────────────── */
let catchesCache = { data: null, fetchedAt: 0 };
const CACHE_TTL  = 60 * 60 * 1000; // refresh every hour

function fetchHtml(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    let done = false;
    const finish = (fn, val) => { if (!done) { done = true; fn(val); } };

    const req = mod.get(url, {
      headers: {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        return fetchHtml(res.headers.location, redirects + 1).then(v => finish(resolve, v)).catch(e => finish(reject, e));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => finish(resolve, body));
    });
    req.on('error', e => finish(reject, e));
    req.setTimeout(20000, () => { req.destroy(new Error('Timeout')); });
  });
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePage(html) {
  const results = [];
  const tbodyMatch = html.match(/<table[^>]*ms_catches_table[^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return results;

  const tbody = tbodyMatch[1];
  const rows  = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = [];
    const tdRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = tdRe.exec(row)) !== null) cells.push(m[1]);
    if (cells.length < 4) continue;

    // Columns: 0=Date  1=WON(img)  2=Play  3=Odds  4=Tip  5=Outcome
    const date  = stripTags(cells[0] || '');
    const isWon = /<img/i.test(cells[1] || '');
    const play  = stripTags(cells[2] || '');
    const odds  = stripTags(cells[3] || '');
    const tip   = stripTags(cells[4] || '');

    if (!play || !odds) continue;

    const parts    = play.split(/\s+vs\s+/i);
    const homeTeam = parts[0] ? parts[0].trim() : play;
    const awayTeam = parts[1] ? parts[1].trim() : '';
    const isNBA    = /NBA|points|rebounds|assists|\bbasketball\b/i.test(play + tip);

    results.push({
      date,
      homeTeam,
      homeFlag: isNBA ? '🏀' : '⚽',
      awayTeam,
      awayFlag: isNBA ? '🏀' : '⚽',
      matchEn: play,
      league: '',
      prediction: tip,
      odds,
      sport : isNBA ? 'basketball' : 'football',
      result: isWon ? 'won' : 'lost',
    });
  }
  return results;
}

async function loadCatches() {
  const now = Date.now();
  if (catchesCache.data && (now - catchesCache.fetchedAt) < CACHE_TTL) {
    return catchesCache.data;
  }

  try {
    const results = await Promise.allSettled([
      fetchHtml('https://hamamlitz.com/en/catches/'),
      fetchHtml('https://hamamlitz.com/en/catches/page/2/'),
    ]);
    const data = results.flatMap(r =>
      r.status === 'fulfilled' ? parsePage(r.value) : []
    );
    if (data.length > 0) catchesCache = { data, fetchedAt: now };
    const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    if (failed.length) console.warn('[catches] partial failures:', failed.join(', '));
    return data.length > 0 ? data : (catchesCache.data || []);
  } catch (err) {
    console.error('[catches] fetch error:', err.message);
    return catchesCache.data || [];
  }
}

/* ─── HTTP server ───────────────────────────────────────────────── */
http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  /* API: live catches data */
  if (urlPath === '/api/catches') {
    try {
      const data = await loadCatches();
      res.writeHead(200, {
        'Content-Type' : 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  /* Static files */
  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`SportX server running on http://localhost:${PORT}`);
});
