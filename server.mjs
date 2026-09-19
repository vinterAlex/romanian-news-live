import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;
const SRC_REFRESH_MS = 90 * 1000;
const VI = 'VISITOR_INFO1_LIVE=ok';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'SOCS=CAI; CONSENT=YES+1; PREF=f6=40000000; ' + VI,
  referer: 'https://www.youtube.com/',
};

// Fiecare post are fie o sursa YouTube (channelId/handle), fie una "de pe site"
// (site.kind = 'youtube' | 'hls', extrasa la fiecare refresh din pagina data).
const CHANNELS = [
  { id: 'digi24',     name: 'Digi24',           color: '#3b82f6', youtube: { channelId: 'UCBvKamSrJkwT6ed2BMMZXwg', handle: '@digi24hd56' } },
  { id: 'antena3',    name: 'Antena 3 CNN',     color: '#f59e0b', site: { kind: 'hls', page: 'https://www.antena3.ro/live' } },
  { id: 'euronews',   name: 'Euronews România', color: '#22c55e', youtube: { channelId: 'UCbATDExtWstHnwWELZnXNZA', handle: '@euronewsro' } },
  { id: 'protv',      name: 'Stirile ProTV',    color: '#6366f1', youtube: { channelId: 'UCEJf5cGtkBdZS8Jh2uSW9xw', handle: '@stirileprotv' } },
  { id: 'romaniatv',  name: 'Romania TV',       color: '#eab308', site: { kind: 'hls', page: 'https://www.romaniatv.net/live', fallback: 'https://livestream.romaniatv.net/clients/romaniatv/playlist.m3u8' } },
  { id: 'aleph',      name: 'Aleph News',       color: '#14b8a6', youtube: { channelId: 'UC9OlWHkFGBz08r7OXwqx3Sg', handle: '@alephnewsofficial' } },
  { id: 'realitatea', name: 'Realitatea Plus',  color: '#f97316', site: { kind: 'youtube', page: 'https://www.realitatea.net/live' } },
];

let lastRun = 0;
let inflight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    const text = await r.text();
    return { status: r.status, url: r.url, text };
  } finally {
    clearTimeout(timer);
  }
}

function pageTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1] : '';
}

function videoIds(html) {
  return [...new Set([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]))];
}

// Extract videoIds from the structured ytInitialData of a /live page.
function liveTabVideoIds(html, limit = 8) {
  const m = html.match(/var ytInitialData = ({[\s\S]*?});<\/script>/) || html.match(/ytInitialData = ({[\s\S]*?});\s*<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  const seen = new Set();
  const walk = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 16 || out.length >= limit) return;
    const vid = obj.videoId;
    const looksLikeVideo =
      typeof vid === 'string' && /^[A-Za-z0-9_-]{11}$/.test(vid) &&
      (obj.videoRenderer || obj.gridVideoRenderer || obj.compactVideoRenderer || obj.isLive !== undefined || obj.liveStreamDetail);
    if (looksLikeVideo && !seen.has(vid)) {
      seen.add(vid);
      out.push(vid);
    }
    for (const k in obj) walk(obj[k], depth + 1);
  };
  walk(data, 0);
  return out;
}

async function isLiveNow(videoId) {
  const { status, text } = await getText('https://www.youtube.com/watch?v=' + videoId + '&hl=en&gl=US');
  return status === 200 && /"isLive":true/.test(text);
}

async function candidatesFor(channel) {
  const yt = channel.youtube || {};
  const pages = [
    'https://www.youtube.com/channel/' + yt.channelId + '/live?hl=en&gl=US',
    'https://www.youtube.com/' + yt.handle + '/live?hl=en&gl=US',
  ];
  for (const url of pages) {
    try {
      const { status, text } = await getText(url);
      if (status !== 200) continue;
      const structured = liveTabVideoIds(text);
      if (structured.length) return structured.slice(0, 6);
      const title = pageTitle(text);
      if (title && /live/i.test(title)) {
        const ids = videoIds(text).slice(0, 6);
        if (ids.length) return ids;
      }
    } catch { /* try next */ }
  }
  return [];
}

async function resolveYouTube(channel) {
  const cands = await candidatesFor(channel);
  for (const vid of cands) {
    try {
      if (await isLiveNow(vid)) return { live: true, type: 'youtube', videoId: vid };
    } catch { /* next */ }
    await sleep(80);
  }
  return { live: false };
}

function streamHeadersFor(urlStr) {
  const h = { 'user-agent': UA, accept: '*/*' };
  try {
    const host = new URL(urlStr).host;
    if (/antenaplay\.ro|antena3\.ro/.test(host)) { h.referer = 'https://www.antena3.ro/'; h.origin = 'https://www.antena3.ro'; }
    else if (/romaniatv\.net/.test(host)) { h.referer = 'https://www.romaniatv.net/'; h.origin = 'https://www.romaniatv.net'; }
    else h.referer = 'https://www.youtube.com/';
  } catch { /* ignore */ }
  return h;
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function httpsRequestOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, agent: insecureAgent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function httpsGetInsecure(url, headers, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await httpsRequestOnce(current, headers);
    if (r.status >= 300 && r.status < 400 && r.location) { current = new URL(r.location, current).href; continue; }
    return { status: r.status, headers: r.headers, body: r.body, url: current };
  }
  throw new Error('too many redirects');
}

async function checkHls(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: streamHeadersFor(url), signal: ctrl.signal, redirect: 'follow' });
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      if (/mpegurl/i.test(ct)) return true;
      const t = await r.text();
      if (t.trimStart().startsWith('#EXTM3U')) return true;
    }
  } catch { /* fallback mai jos */ } finally {
    clearTimeout(timer);
  }
  // Unele posturi au lanț de certificate incomplet → verificare fără validare TLS.
  try {
    const r = await httpsGetInsecure(url, streamHeadersFor(url));
    if (r.status !== 200) return false;
    if (/mpegurl/i.test(r.headers['content-type'] || '')) return true;
    return r.body.toString('utf8').trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

async function resolveSite(channel) {
  const site = channel.site;
  const { status, text } = await getText(site.page);
  if (status !== 200) return { live: false };
  if (site.kind === 'youtube') {
    const m = text.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
    if (!m) return { live: false };
    const videoId = m[1];
    const live = await isLiveNow(videoId).catch(() => false);
    return live ? { live: true, type: 'youtube', videoId } : { live: false };
  }
  // hls: caută un playlist .m3u8 în pagină
  const m = text.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/);
  const src = (m ? m[0] : site.fallback || '').replace(/&amp;/g, '&');
  if (!src) return { live: false };
  const ok = await checkHls(src).catch(() => false);
  return ok ? { live: true, type: 'hls', src } : { live: false };
}

async function resolveChannel(channel) {
  let res;
  try {
    res = channel.youtube ? await resolveYouTube(channel) : await resolveSite(channel);
  } catch {
    res = { live: false };
  }
  return {
    id: channel.id,
    name: channel.name,
    channelId: channel.youtube ? channel.youtube.channelId : null,
    handle: channel.youtube ? channel.youtube.handle : null,
    live: !!res.live,
    type: res.live ? res.type : null,
    videoId: res.videoId || null,
    src: res.src || null,
    proxy: res.type === 'hls' && channel.proxy !== false,
    external: channel.site ? channel.site.page : 'https://www.youtube.com/' + channel.youtube.handle + '/live',
  };
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    const startedAt = Date.now();
    const out = await Promise.all(CHANNELS.map(async (ch) => {
      const res = await resolveChannel(ch);
      const what = res.live ? (res.type + ' ' + (res.videoId || res.src)) : 'off';
      console.log('[sync]', new Date().toTimeString().slice(0, 8), (res.name + ':').padEnd(17), what.slice(0, 120));
      return res;
    }));
    lastRun = Date.now();
    try {
      fs.writeFileSync(path.join(ROOT, 'channels.baked.json'), JSON.stringify(out, null, 2));
    } catch { /* best effort */ }
    console.log('[sync] done in ' + Math.round((Date.now() - startedAt) / 1000) + 's — ' + out.filter((r) => r.live).length + '/' + out.length + ' live');
    return out;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// ---- HLS proxy (pentru surse cu CORS/token restrictionat) ----

function proxyUrl(abs) {
  return '/api/hls?u=' + encodeURIComponent(abs);
}

function rewritePlaylist(body, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return body; }
  const toProxy = (u) => { try { return proxyUrl(new URL(u, base).href); } catch { return u; } };
  return body.split(/\r?\n/).map((line) => {
    let out = line.replace(/URI="([^"]+)"/g, (_m, p1) => 'URI="' + toProxy(p1) + '"');
    const t = out.trim();
    if (t && t[0] !== '#') out = toProxy(t);
    return out;
  }).join('\n');
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

// deschide un upstream; dacă fetch eșuează (lanț de certificate incomplet) → node:https fără validare TLS
async function openUpstream(target) {
  const headers = streamHeadersFor(target);
  try {
    const r = await fetch(target, { headers, redirect: 'follow' });
    return { status: r.status, ct: r.headers.get('content-type') || '', finalUrl: r.url, webStream: r.body, getText: () => r.text() };
  } catch {
    const r = await insecureOpen(target, headers);
    return { status: r.status, ct: r.ct, finalUrl: r.finalUrl, nodeStream: r.nodeStream, getText: () => streamToString(r.nodeStream) };
  }
}

function insecureOpen(url, headers, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      const req = https.get(u, { headers, agent: insecureAgent }, (up) => {
        const status = up.statusCode || 0;
        if (status >= 300 && status < 400 && up.headers.location && left > 0) {
          up.resume();
          go(new URL(up.headers.location, u).href, left - 1);
          return;
        }
        resolve({ status, ct: up.headers['content-type'] || '', finalUrl: u, nodeStream: up });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    };
    go(url, maxRedirects);
  });
}

async function handleHls(u, res) {
  const target = u.searchParams.get('u') || '';
  if (!/^https?:\/\//i.test(target)) { res.writeHead(400); res.end('bad url'); return; }
  let up;
  try {
    up = await openUpstream(target);
  } catch {
    res.writeHead(502); res.end('upstream error');
    return;
  }
  const pipe = () => {
    if (up.webStream) Readable.fromWeb(up.webStream).pipe(res);
    else if (up.nodeStream) up.nodeStream.pipe(res);
    else res.end();
  };
  if (up.status >= 400) {
    res.writeHead(up.status, { 'content-type': up.ct || 'text/plain' });
    pipe();
    return;
  }
  const isPlaylist = /mpegurl/i.test(up.ct) || /\.m3u8(\?|$)/i.test(target);
  if (isPlaylist) {
    const text = await up.getText();
    const body = text.trimStart().startsWith('#EXTM3U') ? rewritePlaylist(text, up.finalUrl || target) : text;
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': up.ct || 'video/mp2t', 'cache-control': 'no-store' });
  pipe();
}

setInterval(() => { refresh().catch(() => {}); }, SRC_REFRESH_MS);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (u.pathname === '/api/live') {
    try {
      const data = await refresh();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500);
      res.end('sync failed');
    }
    return;
  }

  if (u.pathname === '/api/hls') {
    handleHls(u, res).catch(() => { try { res.writeHead(502); res.end(); } catch { /* ignore */ } });
    return;
  }

  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  p = path.normalize(p).replace(/^([\\/])+/, '');
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(ROOT, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(fs.readFileSync(idx));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

refresh().catch(() => {});
server.listen(PORT, () => {
  console.log('Stiri Live RO  ->  http://localhost:' + PORT);
});
