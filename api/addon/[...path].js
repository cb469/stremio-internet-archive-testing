const { addonBuilder } = require('stremio-addon-sdk');

// Config
const USER_AGENT = 'stremio-ia-scraper/1.2';
const MAX_STREAMS_PER_TITLE = Number(process.env.MAX_STREAMS || 5);
const REQUIRE_PD_OR_CC = String(process.env.REQUIRE_PD_OR_CC ?? 'false') === 'true';
const TMDB_KEY = process.env.TMDB_KEY || null;

// Endpoints
const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_META = (id) => https://archive.org/metadata/${encodeURIComponent(id)};
const CINEMETA = (type, id) => https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json;
const TMDB_FIND = (imdbId) => https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_KEY}&external_source=imdb_id;
const TMDB_MOVIE = (id) => https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&append_to_response=alternative_titles,translations;
const TMDB_TV = (id) => https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}&append_to_response=alternative_titles,translations;

// TTL cache (in-memory per instance)
const cache = new Map();
const cached = async (key, fn, ttlMs = 6 * 60 * 60 * 1000) => {
const now = Date.now();
const hit = cache.get(key);
if (hit && hit.exp > now) return hit.val;
const val = await fn();
cache.set(key, { exp: now + ttlMs, val });
return val;
};

// Helpers
const normalize = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

const tokenSetSim = (a, b) => {
a = normalize(a); b = normalize(b);
if (!a || !b) return 0;
const A = new Set(a.split(' '));
const B = new Set(b.split(' '));
const inter = [...A].filter((x) => B.has(x)).length;
const union = new Set([...A, ...B]).size;
return inter / union;
};

const looksLikeJunk = (doc) => /trailer|teaser|clip|sample|test|promo|announcement|music video|fan edit|mashup/i.test(doc?.title || '');

const isVideoFile = (f) => {
const name = (f.name || '').toLowerCase();
const ext = name.split('.').pop();
const fmt = (f.format || '').toLowerCase();
const isVid = ['mp4', 'mkv', 'webm', 'mpg', 'mpeg', 'mov', 'avi', 'm4v'].includes(ext) ||
/h.?264|mpeg4|matroska|webm|quicktime|mpeg video|mp4|xvid|h.?265|hevc/.test(fmt);
const isSample = /sample|trailer|clip|preview/i.test(f.name || '') || /trailer|clip/i.test(f.format || '');
return isVid && !isSample && (f.size || 0) > 5_000_000;
};

const guessResolution = (f) => {
const s = ((f.name || '') + ' ' + (f.format || '')).toLowerCase();
if (/\b2160p|\b4k|\b3840x2160\b/.test(s)) return '2160p';
if (/\b1440p|\b2560x1440\b/.test(s)) return '1440p';
if (/\b1080p|\b1920x1080\b/.test(s)) return '1080p';
if (/\b720p|\b1280x720\b/.test(s)) return '720p';
if (/\b480p|\b640x480\b|\b854x480\b/.test(s)) return '480p';
if (/\b360p|\b640x360\b|\b480x360\b/.test(s)) return '360p';
return 'SD';
};
const guessVideoCodec = (f) => {
const s = ((f.name || '') + ' ' + (f.format || '')).toLowerCase();
if (/hevc|h.?265|x265/.test(s)) return 'H.265/HEVC';
if (/h.?264|x264|avc/.test(s)) return 'H.264/AVC';
if (/mpeg-?2/.test(s)) return 'MPEG-2';
if (/mpeg-?4/.test(s)) return 'MPEG-4';
if (/vp9/.test(s)) return 'VP9';
if (/webm/.test(s)) return 'WebM';
return 'Video';
};
const guessAudio = (f) => {
const s = ((f.name || '') + ' ' + (f.format || '')).toLowerCase();
if (/dd+|eac-?3/.test(s)) return 'EAC3';
if (/dd|ac-?3/.test(s)) return 'AC3';
if (/aac/.test(s)) return 'AAC';
if (/opus/.test(s)) return 'Opus';
if (/mp3/.test(s)) return 'MP3';
return 'Audio';
};

const parseDurationToSeconds = (len) => {
if (!len) return null;
if (typeof len === 'number') return Math.round(len);
const s = String(len).trim();
if (/^\d+(.\d+)?$/.test(s)) return Math.round(Number(s));
if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
const p = s.split(':').map(Number);
return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
}
return null;
};

const pickBestVideoFiles = (files = []) => {
const video = files.filter(isVideoFile);
const weight = (f) => {
const name = (f.name || '') + ' ' + (f.format || '');
let w = 0;
if (/.mp4$/i.test(f.name)) w += 3;
else if (/.mkv$/i.test(f.name)) w += 2;
else if (/.webm$/i.test(f.name)) w += 1;
if (/2160|4k|3840x2160/i.test(name)) w += 4;
if (/1440|2560x1440/i.test(name)) w += 3;
if (/1080|1920x1080/i.test(name)) w += 2;
if (/720|1280x720/i.test(name)) w += 1;
w += Math.log10((f.size || 1) + 1);
return w;
};
return video.sort((a, b) => weight(b) - weight(a));
};

const encodeIAPath = (name) => String(name).split('/').map(encodeURIComponent).join('/');
const buildLabel = (file) => ${guessResolution(file)} • ${guessVideoCodec(file)} • ${guessAudio(file)} • ${Math.round((file.size || 0) / 1e6)}MB;
const buildStream = (identifier, file, label = 'Internet Archive') => ({
name: label,
title: buildLabel(file),
url: https://archive.org/download/${encodeURIComponent(identifier)}/${encodeIAPath(file.name)},
behaviorHints: { bingeGroup: identifier }
});

// IA APIs
const queryIA = async ({ q, rows = 60, mediatype, collections = [] }) => {
const url = new URL(IA_SEARCH);
let fullQ = q || '';
if (mediatype) fullQ += AND mediatype:(${mediatype});
for (const c of collections) fullQ += AND collection:(${c});
url.searchParams.set('q', fullQ.trim() || 'downloads:[1 TO *]');
['identifier', 'title', 'year', 'downloads', 'licenseurl', 'mediatype', 'creator', 'subject', 'date'].forEach((f) =>
url.searchParams.append('fl[]', f)
);
url.searchParams.append('sort[]', 'downloads desc');
url.searchParams.set('rows', String(rows));
url.searchParams.set('output', 'json');

return cached(ia:${url.toString()}, async () => {
const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
if (!res.ok) throw new Error('IA search failed');
const json = await res.json();
return json?.response?.docs || [];
}, 60 * 60 * 1000);
};

const getIAMetadata = async (identifier) =>
cached(
iameta:${identifier},
async () => {
const res = await fetch(IA_META(identifier), { headers: { 'User-Agent': USER_AGENT } });
if (!res.ok) throw new Error('IA metadata failed');
return res.json();
},
24 * 60 * 60 * 1000
);

const isPermissible = (doc, meta) => {
if (!REQUIRE_PD_OR_CC) return true;
const rights = (meta?.metadata?.rights || doc?.rights || '').toLowerCase();
const lic = (meta?.metadata?.licenseurl || doc?.licenseurl || '').toLowerCase();
return rights.includes('public domain') || lic.includes('creativecommons') || lic.includes('/publicdomain') || lic.includes('pdm');
};

// Cinemeta/TMDB
const getCinemeta = async (type, id) =>
cached(
cm:${type}:${id},
async () => {
const res = await fetch(CINEMETA(type, id), { headers: { 'User-Agent': USER_AGENT } });
if (!res.ok) throw new Error('Cinemeta failed');
return res.json();
},
12 * 60 * 60 * 1000
);

const getTmdbFull = async (type, imdbId) => {
if (!TMDB_KEY || !imdbId) return null;
try {
const found = await cached(
tmdb:find:${imdbId},
async () => {
const res = await fetch(TMDB_FIND(imdbId), { headers: { 'User-Agent': USER_AGENT } });
if (!res.ok) return null;
return res.json();
},
24 * 60 * 60 * 1000
);
if (!found) return null;
if (type === 'movie') {
  const m = found.movie_results?.[0];
  if (!m) return null;
  return cached(
    `tmdb:movie:${m.id}`,
    async () => {
      const res = await fetch(TMDB_MOVIE(m.id), { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) return null;
      return res.json();
    },
    24 * 60 * 60 * 1000
  );
} else {
  const tv = found.tv_results?.[0];
  if (!tv) return null;
  return cached(
    `tmdb:tv:${tv.id}`,
    async () => {
      const res = await fetch(TMDB_TV(tv.id), { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) return null;
      return res.json();
    },
    24 * 60 * 60 * 1000
  );
}
} catch {
return null;
}
};

const altTitlesFrom = (cm, tmdb, type) => {
const titles = new Set();
const cmTitle = cm?.meta?.name || cm?.meta?.title;
const cmOrig = cm?.meta?.originalTitle || cm?.meta?.original_name || cm?.meta?.original_title;
if (cmTitle) titles.add(cmTitle);
if (cmOrig) titles.add(cmOrig);
if (tmdb) {
if (type === 'movie') {
const primary = tmdb.title || tmdb.original_title;
if (primary) titles.add(primary);
(tmdb.alternative_titles?.titles || []).forEach((t) => t?.title && titles.add(t.title));
(tmdb.translations?.translations || []).forEach((tr) => tr.data?.title && titles.add(tr.data.title));
} else {
const primary = tmdb.name || tmdb.original_name;
if (primary) titles.add(primary);
(tmdb.alternative_titles?.results || []).forEach((t) => t?.title && titles.add(t.title));
(tmdb.translations?.translations || []).forEach((tr) => tr.data?.name && titles.add(tr.data.name));
}
}
return [...titles].map((s) => s.trim()).filter(Boolean);
};

const episodeTitleFromCinemeta = (cm, season, episode) => {
const list = Array.isArray(cm?.meta?.videos) ? cm.meta.videos : [];
const v = list.find((x) => Number(x.season) === Number(season) && Number(x.episode) === Number(episode));
return v?.title || v?.name || null;
};

// Queries and scoring
const buildMovieQueries = (titles, year) => {
const phrases = titles.slice(0, 6).map((t) => title:("${t.replace(/"/g, '\\"')}"));
const yExact = year ? AND year:${year} : '';
const yRange = year ? AND year:[${year - 1} TO ${Number(year) + 2}] : '';
const q = [];
phrases.forEach((p) => q.push(p + yExact));
phrases.forEach((p) => q.push(p + yRange + ' AND downloads:[10 TO *]'));
return [...new Set(q)];
};

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const buildEpisodeQueries = (titles, season, episode, year, epTitle) => {
const s = Number(season);
const e = Number(episode);
const pats = [
S${pad2(s)}E${pad2(e)},
${s}x${pad2(e)},
"Season ${s}" AND ("Episode ${e}" OR "Ep ${e}" OR "Ep. ${e}"),
"Episode ${e}",
"Part ${e}"
];
const base = titles.slice(0, 6).map((t) => title:("${t.replace(/"/g, '\\"')}"));
const yTerm = year ? AND year:[${year - 1} TO ${Number(year) + 2}] : '';
const out = [];
for (const b of base) for (const p of pats) out.push(${b} AND (${p})${yTerm});
if (epTitle) base.forEach((b) => out.push(${b} AND ("${epTitle.replace(/"/g, '\\"')}")${yTerm}));
base.forEach((b) => out.push(${b}${yTerm} AND downloads:[10 TO *]));
return [...new Set(out)];
};

const scoreDocAgainst = (doc, titles, year) => {
const best = Math.max(...titles.map((t) => tokenSetSim(t, doc?.title || '')));
const yWant = parseInt(year) || null;
const yHave = parseInt(doc?.year) || null;
const yd = yWant && yHave ? Math.abs(yHave - yWant) : null;
const yScore = yd === 0 ? 0.25 : yd !== null && yd <= 1 ? 0.15 : 0;
const pop = Math.log10((doc.downloads || 1) + 1) / 50;
return best + yScore + pop;
};

const epKeywords = ['episode', 'ep', 'ep.', 'episodio', 'episódio', 'capitulo', 'capítulo', 'cap', 'parte', 'part', 'pt', 'folge', 'kapitel', 'chapter'];

const fileMatchesEpisode = (f, season, episode, epTitles = []) => {
if (!isVideoFile(f)) return false;
const n = (f.name || '').toLowerCase();
if (new RegExp(\\bs0?${season}e0?${episode}\\b).test(n)) return true;
if (new RegExp(\\b${season}x0?${episode}\\b).test(n)) return true;
if (new RegExp(\\bs${season}[._ -]?e${episode}\\b).test(n)) return true;
for (const kw of epKeywords) if (new RegExp(\\b${kw}\\s*[._ -]*0?${episode}\\b).test(n)) return true;
for (const t of epTitles) {
const clean = t.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
if (clean && clean.length >= 3 && n.includes(clean.split(' ').slice(0, 6).join(' '))) return true;
}
return false;
};

// Movie resolver
const findMovieStreams = async ({ titles, year, expectedRuntimeMin }) => {
const queries = buildMovieQueries(titles, year);
const candidates = [];
for (const q of queries) {
try {
const docs = await queryIA({ q, mediatype: 'movies', rows: 60 });
for (const d of docs) if (!looksLikeJunk(d)) candidates.push(d);
if (candidates.length > 150) break;
} catch {}
}
const seen = new Set();
const uniq = candidates.filter((d) => (seen.has(d.identifier) ? false : seen.add(d.identifier)));
const scored = uniq
.map((c) => ({ c, score: scoreDocAgainst(c, titles, year) }))
.sort((a, b) => b.score - a.score)
.slice(0, 30);

const streams = [];
for (const { c } of scored) {
try {
const meta = await getIAMetadata(c.identifier);
if (!isPermissible(c, meta)) continue;
const files = meta?.files || [];
const sorted = pickBestVideoFiles(files);
if (!sorted.length) continue;
 for (const file of sorted) {
    const sec = parseDurationToSeconds(file.length);
    if (sec && sec < 40 * 60) continue; // avoid shorts
    if (expectedRuntimeMin && sec && Math.abs(sec / 60 - expectedRuntimeMin) > 25) {
      const tScore = scoreDocAgainst(c, titles, year);
      if (tScore < 0.9) continue;
    }
    streams.push(buildStream(c.identifier, file));
    if (streams.length >= MAX_STREAMS_PER_TITLE) break;
  }
  if (streams.length >= MAX_STREAMS_PER_TITLE) break;
} catch {}
}
return streams;
};

// Series resolver
const findSeriesEpisodeStreams = async ({ titles, season, episode, year, epTitleCandidates }) => {
const queries = buildEpisodeQueries(titles, season, episode, year, epTitleCandidates[0]);
const candidates = [];
for (const q of queries) {
try {
const docs = await queryIA({ q, mediatype: 'movies', rows: 80 });
for (const d of docs) if (!looksLikeJunk(d)) candidates.push(d);
if (candidates.length > 180) break;
} catch {}
}
const seen = new Set();
const uniq = candidates.filter((d) => (seen.has(d.identifier) ? false : seen.add(d.identifier)));
const scored = uniq
.map((c) => ({ c, score: scoreDocAgainst(c, titles, year) }))
.sort((a, b) => b.score - a.score)
.slice(0, 40);

const streams = [];
for (const { c } of scored) {
try {
const meta = await getIAMetadata(c.identifier);
if (!isPermissible(c, meta)) continue;
const files = (meta?.files || []).filter(isVideoFile);
 const exact = files.filter((f) => fileMatchesEpisode(f, season, episode, epTitleCandidates));
  if (exact.length) {
    exact.sort((a, b) => (b.size || 0) - (a.size || 0));
    for (const f of exact) {
      streams.push(buildStream(c.identifier, f, 'Internet Archive (Episode)'));
      if (streams.length >= MAX_STREAMS_PER_TITLE) break;
    }
  } else if (files.length === 1) {
    const tScore = scoreDocAgainst(c, titles, year);
    if (tScore > 0.8) streams.push(buildStream(c.identifier, files[0], 'Internet Archive (Episode)'));
  }
  if (streams.length >= MAX_STREAMS_PER_TITLE) break;
} catch {}
}
return streams;
};

// Manifest (stream-only)
const manifest = {
id: 'org.archive.scraper',
version: '1.0.0',
name: 'Internet Archive Scraper',
description: 'Resolves Cinemeta/TMDB titles to archive.org streams',
resources: ['stream'],
types: ['movie', 'series'],
catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
try {
const type = args.type;
const cm = await getCinemeta(type, args.id);
const title = cm?.meta?.name || cm?.meta?.title;
const year = cm?.meta?.year;
const imdbId = cm?.meta?.imdb_id || cm?.meta?.imdbId || (args.id?.startsWith('tt') ? args.id : null);
if (!title) return { streams: [] };
const tmdb = await getTmdbFull(type, imdbId).catch(() => null);
const titles = altTitlesFrom(cm, tmdb, type);
if (!titles.includes(title)) titles.unshift(title);

if (type === 'movie') {
  const expectedRuntimeMin =
    (cm?.meta?.runtime && Number(cm.meta.runtime)) ||
    (tmdb?.runtime && Number(tmdb.runtime)) ||
    null;
  const streams = await findMovieStreams({ titles, year, expectedRuntimeMin });
  return { streams };
} else {
  const season = parseInt(args.seriesInfo?.season || args.extra?.season || 0, 10);
  const episode = parseInt(args.seriesInfo?.episode || args.extra?.episode || 0, 10);
  if (!season || !episode) return { streams: [] };

  const epTitle = episodeTitleFromCinemeta(cm, season, episode);
  const epTitles = new Set();
  if (epTitle) epTitles.add(epTitle);

  const streams = await findSeriesEpisodeStreams({
    titles,
    season,
    episode,
    year,
    epTitleCandidates: [...epTitles]
  });
  return { streams };
}
} catch (e) {
console.error('stream error', e);
return { streams: [] };
}
});

// Build interface once
const iface = builder.getInterface();

// Vercel entrypoint with URL normalization (important)
module.exports = async (req, res) => {
try {
const u = new URL(req.url, 'http://localhost');
let pathname = u.pathname;
if (pathname.startsWith('/api/addon')) {
pathname = pathname.slice('/api/addon'.length) || '/';
}
// Remove catch-all params Vercel adds
u.searchParams.delete('path');
u.searchParams.delete('slug');
req.url = pathname + (u.search || '');
return iface(req, res);
} catch (e) {
res.statusCode = 500;
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({ error: e.message }));
}
};
