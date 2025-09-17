// Internet Archive x Stremio — Pure Stream Resolver (Vercel-ready)
// This version formats results with TRUE file info only:
// - Left: "Internet Archive — 1080p" if IA provides real height; else "Internet Archive"
// - Right: Series/Movie + original filename + real size (+ optional true duration, WxH, format)
// Matching logic includes acronyms, airdate fallback, collection fallback, optional index-guess,
// and strict anti-nonsense gates.

const { addonBuilder, getRouter } = require('stremio-addon-sdk');

// ---------------------------- Config (env) ----------------------------
const USER_AGENT = 'stremio-ia-scraper/1.3';

const MAX_STREAMS_PER_TITLE = Number(process.env.MAX_STREAMS || 5);

// Show everything by default (you asked to disable PD/CC-only filter)
const REQUIRE_PD_OR_CC = String(process.env.REQUIRE_PD_OR_CC ?? 'false') === 'true';

// Strictness and guards
const STRICT_MODE = String(process.env.STRICT_MODE ?? 'true') === 'true';
const MIN_FEATURE_SIZE_MB = Number(process.env.MIN_FEATURE_SIZE_MB || 200); // movie size gate
const TITLE_SCORE_STRICT = Number(process.env.TITLE_SCORE_STRICT || 0.95);
const TITLE_SCORE_RELAXED = Number(process.env.TITLE_SCORE_RELAXED || 0.85);

// Optional last-resort fallback for packs with zero S/E/title/date
const ALLOW_INDEX_GUESS = String(process.env.ALLOW_INDEX_GUESS || 'false') === 'true';
const INDEX_GUESS_MAX_VARIANCE_MIN = Number(process.env.INDEX_GUESS_MAX_VARIANCE_MIN || 12);

// Phase-A collections (helps reduce noise)
const IA_COLLECTIONS = (process.env.IA_COLLECTIONS || 'television,classic_tv,animationandcartoons,opensource_movies,feature_films')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// TMDB (optional for alt titles/translations)
const TMDB_KEY = process.env.TMDB_KEY || null;

// ---------------------------- Endpoints ----------------------------
const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_META = (id) => `https://archive.org/metadata/${encodeURIComponent(id)}`;
const CINEMETA = (type, id) => `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;
const TMDB_FIND = (imdbId) => `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_KEY}&external_source=imdb_id`;
const TMDB_MOVIE = (id) => `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&append_to_response=alternative_titles,translations`;
const TMDB_TV = (id) => `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}&append_to_response=alternative_titles,translations`;

// ---------------------------- Cache ----------------------------
const cache = new Map();
const cached = async (key, fn, ttlMs = 6 * 60 * 60 * 1000) => {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.val;
  const val = await fn();
  cache.set(key, { exp: now + ttlMs, val });
  return val;
};

// ---------------------------- Helpers ----------------------------
const normalize = (s) => (s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\w\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tokenSetSim = (a, b) => {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return inter / union;
};

const looksLikeJunk = (doc) => {
  const s = ((doc?.title || '') + ' ' + (doc?.subject || '') + ' ' + (doc?.description || '')).toLowerCase();
  return /\b(trailer|teaser|clip|preview|promo|review|reaction|commentary|fan.?edit|fan.?film|parody|mashup|amv|music video|behind the scenes|bts|b-roll|interview|audition)\b/.test(s);
};

const isVideoFile = (f) => {
  const name = (f.name || '').toLowerCase();
  const ext = name.split('.').pop();
  const fmt = (f.format || '').toLowerCase();
  const isVid = ['mp4','mkv','webm','mpg','mpeg','mov','avi','m4v'].includes(ext) ||
                /h\.?264|mpeg4|matroska|webm|quicktime|mpeg video|mp4|xvid|h\.?265|hevc/.test(fmt);
  const isSample = /sample|trailer|clip|preview/i.test(f.name || '') || /trailer|clip/i.test(f.format || '');
  return isVid && !isSample && (f.size || 0) > 5_000_000;
};

const parseDurationToSeconds = (len) => {
  if (!len) return null;
  if (typeof len === 'number') return Math.round(len);
  const s = String(len).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const p = s.split(':').map(Number);
    return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  }
  return null;
};

const prettyDuration = (sec) => {
  if (!sec && sec !== 0) return null;
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}h ${String(m).padStart(2,'0')}m`;
  return `${m}m ${String(ss).padStart(2,'0')}s`;
};

const pickBestVideoFiles = (files = []) => {
  const video = files.filter(isVideoFile);
  const weight = (f) => {
    const name = (f.name || '') + ' ' + (f.format || '');
    let w = 0;
    // This is just for ordering, not for displaying; we still display only true info.
    if (/\.mp4$/i.test(f.name)) w += 3;
    else if (/\.mkv$/i.test(f.name)) w += 2;
    else if (/\.webm$/i.test(f.name)) w += 1;
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

const prettySize = (bytes = 0) => {
  const GB = 1024 ** 3, MB = 1024 ** 2;
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB';
  if (bytes >= MB) return (bytes / MB).toFixed(2) + ' MB';
  return Math.max(1, Math.round(bytes / MB)) + ' MB';
};

// TRUE dimension/quality from IA (no guessing)
const realHeight = (f) => {
  const h = Number(f.height ?? f.videoheight ?? f.originalheight ?? f['source_height']);
  return Number.isFinite(h) && h > 0 ? h : null;
};
const realWidth = (f) => {
  const w = Number(f.width ?? f.videowidth ?? f.originalwidth ?? f['source_width']);
  return Number.isFinite(w) && w > 0 ? w : null;
};
const qualityFromHeight = (h) => {
  if (!h) return null;
  if (h >= 2000) return '2160p';
  if (h >= 1300) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700)  return '720p';
  if (h >= 500)  return '480p';
  if (h >= 350)  return '360p';
  return `${h}p`;
};
const leftBadge = (file) => {
  const h = realHeight(file);
  const q = qualityFromHeight(h);
  return q ? `Internet Archive — ${q}` : 'Internet Archive';
};
const dimString = (file) => {
  const w = realWidth(file);
  const h = realHeight(file);
  if (w && h) return `${w}x${h}`;
  return null;
};

const makeSeriesRightTitle = ({ show, season, episode, file }) => {
  const parts = [
    `${show || 'Series'} - S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')} - ${file.name}`,
    prettySize(file.size || 0),
  ];
  const sec = parseDurationToSeconds(file.length);
  const dur = prettyDuration(sec);
  if (dur) parts.push(dur);
  const dims = dimString(file);
  if (dims) parts.push(dims);
  if (file.format) parts.push(String(file.format));
  return parts.join(' • ');
};

const makeMovieRightTitle = ({ title, year, file }) => {
  const parts = [
    `${title || 'Movie'}${year ? ` (${year})` : ''} - ${file.name}`,
    prettySize(file.size || 0),
  ];
  const sec = parseDurationToSeconds(file.length);
  const dur = prettyDuration(sec);
  if (dur) parts.push(dur);
  const dims = dimString(file);
  if (dims) parts.push(dims);
  if (file.format) parts.push(String(file.format));
  return parts.join(' • ');
};

// Build Stream object with TRUE-only labels
const buildStream = (identifier, file, ctx = {}) => {
  const name = leftBadge(file); // Left label: IA + real quality if present
  let title;                    // Right label: show/movie + filename + size (+ duration/WxH/format if present)

  if (ctx.kind === 'series') {
    title = makeSeriesRightTitle({ show: ctx.show, season: ctx.season, episode: ctx.episode, file });
  } else if (ctx.kind === 'movie') {
    title = makeMovieRightTitle({ title: ctx.title, year: ctx.year, file });
  } else {
    title = `${file.name} • ${prettySize(file.size || 0)}`;
  }

  return {
    name,
    title,
    url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeIAPath(file.name)}`,
    behaviorHints: { bingeGroup: identifier }
  };
};

// Acronyms
const STOP = new Set(['the','a','an','of','and','or','to','for','with','vs','versus','de','da','do','del','la','le','el','los','las']);
const acronymsFromTitle = (s = '') => {
  s = s.replace(/[^A-Za-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const words = s.split(' ').filter(w => !STOP.has(w.toLowerCase()));
  const initials = words.map(w => w[0]).join('').toUpperCase();
  const noVowels = initials.replace(/[AEIOU]/g, '');
  const capsOnly = (s.match(/\b[A-Z][A-Za-z0-9]*\b/g) || []).map(w => w[0]).join('').toUpperCase();
  const out = new Set([initials, noVowels, capsOnly]);
  return [...out].filter(x => x && x.length >= 2 && x.length <= 12);
};

// Airdate tokens
const dateTokensFromIso = (iso) => {
  if (!iso) return [];
  const d = new Date(iso);
  if (isNaN(d)) return [];
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return [
    `${y}-${m}-${dd}`, `${y}.${m}.${dd}`, `${y}${m}${dd}`,
    `${m}-${dd}-${y}`, `${dd}-${m}-${y}`, `${y}_${m}_${dd}`
  ].map(s => s.toLowerCase());
};

// ---------------------------- APIs ----------------------------
const queryIA = async ({ q, rows = 60, mediatype, collections = [] }) => {
  const url = new URL(IA_SEARCH);
  let fullQ = q || '';
  if (mediatype) fullQ += ` AND mediatype:(${mediatype})`;
  for (const c of collections) fullQ += ` AND collection:(${c})`;
  url.searchParams.set('q', fullQ.trim() || 'downloads:[1 TO *]');
  ['identifier','title','year','downloads','licenseurl','mediatype','creator','subject','date','description'].forEach(f => url.searchParams.append('fl[]', f));
  url.searchParams.append('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('output', 'json');

  return cached(`ia:${url.toString()}`, async () => {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error('IA search failed');
    const json = await res.json();
    return json?.response?.docs || [];
  }, 60 * 60 * 1000);
};

const getIAMetadata = async (identifier) => cached(`iameta:${identifier}`, async () => {
  const res = await fetch(IA_META(identifier), { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('IA metadata failed');
  return res.json();
}, 24 * 60 * 60 * 1000);

const isPermissible = (doc, meta) => {
  if (!REQUIRE_PD_OR_CC) return true;
  const rights = (meta?.metadata?.rights || doc?.rights || '').toLowerCase();
  const lic = (meta?.metadata?.licenseurl || doc?.licenseurl || '').toLowerCase();
  return rights.includes('public domain') ||
         lic.includes('creativecommons') ||
         lic.includes('/publicdomain') ||
         lic.includes('pdm');
};

// Cinemeta/TMDB
const getCinemeta = async (type, id) => cached(`cm:${type}:${id}`, async () => {
  const res = await fetch(CINEMETA(type, id), { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('Cinemeta failed');
  return res.json();
}, 12 * 60 * 60 * 1000);

const getTmdbFull = async (type, imdbId) => {
  if (!TMDB_KEY || !imdbId) return null;
  try {
    const found = await cached(`tmdb:find:${imdbId}`, async () => {
      const res = await fetch(TMDB_FIND(imdbId), { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) return null;
      return res.json();
    }, 24 * 60 * 60 * 1000);
    if (!found) return null;

    if (type === 'movie') {
      const m = found.movie_results?.[0];
      if (!m) return null;
      return cached(`tmdb:movie:${m.id}`, async () => {
        const res = await fetch(TMDB_MOVIE(m.id), { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) return null;
        return res.json();
      }, 24 * 60 * 60 * 1000);
    } else {
      const tv = found.tv_results?.[0];
      if (!tv) return null;
      return cached(`tmdb:tv:${tv.id}`, async () => {
        const res = await fetch(TMDB_TV(tv.id), { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) return null;
        return res.json();
      }, 24 * 60 * 60 * 1000);
    }
  } catch { return null; }
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
      (tmdb.alternative_titles?.titles || []).forEach(t => t?.title && titles.add(t.title));
      (tmdb.translations?.translations || []).forEach(tr => tr.data?.title && titles.add(tr.data.title));
    } else {
      const primary = tmdb.name || tmdb.original_name;
      if (primary) titles.add(primary);
      (tmdb.alternative_titles?.results || []).forEach(t => t?.title && titles.add(t.title));
      (tmdb.translations?.translations || []).forEach(tr => tr.data?.name && titles.add(tr.data.name));
    }
  }
  return [...titles].map(s => s.trim()).filter(Boolean);
};

// ---------------------------- Search & scoring ----------------------------
const buildMovieQueries = (terms, year) => {
  const phrases = terms.slice(0, 8).map(t => `title:("${t.replace(/"/g, '\\"')}")`);
  const yExact = year ? ` AND year:${year}` : '';
  const yRange = year ? ` AND year:[${year - 1} TO ${Number(year) + 2}]` : '';
  const out = [];
  phrases.forEach(p => out.push(p + yExact));
  phrases.forEach(p => out.push(p + yRange + ' AND downloads:[10 TO *]'));
  return [...new Set(out)];
};

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const buildEpisodeQueries = (terms, season, episode, year, epTitle) => {
  const s = Number(season), e = Number(episode);
  const pats = [
    `S${pad2(s)}E${pad2(e)}`, `${s}x${pad2(e)}`,
    `"Season ${s}" AND ("Episode ${e}" OR "Ep ${e}" OR "Ep. ${e}")`,
    `"Episode ${e}"`, `"Part ${e}"`, `"E${pad2(e)}"`
  ];
  const base = terms.slice(0, 8).map(t => `title:("${t.replace(/"/g, '\\"')}")`);
  const yTerm = year ? ` AND year:[${year - 1} TO ${Number(year) + 2}]` : '';
  const out = [];
  for (const b of base) for (const p of pats) out.push(`${b} AND (${p})${yTerm}`);
  if (epTitle) {
    const ept = `"${epTitle.replace(/"/g, '\\"')}"`;
    base.forEach(b => out.push(`${b} AND ${ept}${yTerm}`));
  }
  base.forEach(b => out.push(`${b}${yTerm} AND downloads:[10 TO *]`));
  return [...new Set(out)];
};

const scoreDocAgainst = (doc, terms, year) => {
  const title = doc?.title || '';
  const best = Math.max(...terms.map(t => tokenSetSim(t, title)));
  const yWant = parseInt(year) || null;
  const yHave = parseInt(doc?.year) || null;
  const yd = yWant && yHave ? Math.abs(yHave - yWant) : null;
  const yScore = yd === 0 ? 0.25 : (yd !== null && yd <= 1 ? 0.15 : 0);
  const pop = Math.log10((doc.downloads || 1) + 1) / 50;
  return best + yScore + pop;
};

// ---------------------------- Episode matching ----------------------------
const epKeywords = ['episode','ep','ep.','episodio','episódio','capitulo','capítulo','cap','parte','part','pt','folge','kapitel','chapter'];

const fileMatchesEpisode = (f, season, episode, epTitleCandidates = [], epDateTokens = []) => {
  if (!isVideoFile(f)) return false;
  const n = (f.name || '').toLowerCase();
  const t = (f.title || '').toLowerCase();
  const s2 = String(season).padStart(2, '0');
  const e2 = String(episode).padStart(2, '0');
  const SEP = `[ ._\\-]`;

  const patterns = [
    new RegExp(`\\bs${s2}${SEP}?e${e2}\\b`, 'i'),
    new RegExp(`\\b${season}x0?${episode}\\b`, 'i'),
    new RegExp(`\\bseason${SEP}*${season}${SEP}*episode${SEP}*0?${episode}\\b`, 'i'),
    new RegExp(`\\b(?:ep|episode)${SEP}*0?${episode}\\b`, 'i'),
    new RegExp(`\\be${e2}\\b`, 'i'),
    new RegExp(`\\b(?:part|pt|parte)${SEP}*0?${episode}\\b`, 'i'),
  ];
  if (patterns.some(rx => rx.test(n))) return true;

  for (const kw of ['episodio','episódio','capitulo','capítulo','folge','kapitel','chapter']) {
    const rx = new RegExp(`\\b${kw}${SEP}*0?${episode}\\b`, 'i');
    if (rx.test(n)) return true;
  }

  for (const et of epTitleCandidates) {
    const clean = (et || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean && clean.length >= 3) {
      const prefix = clean.split(' ').slice(0, 6).join(' ');
      if (prefix && (n.includes(prefix) || t.includes(prefix))) return true;
    }
  }

  if (epDateTokens?.length) {
    const L = (n + ' ' + t);
    if (epDateTokens.some(tok => tok && L.includes(tok))) return true;
  }

  return false;
};

// Index guess (optional)
const naturalKey = (name) =>
  String(name || '').toLowerCase().split(/(\d+)/).map(p => (/\d+/.test(p) ? Number(p) : p));
const naturalSort = (a, b) => {
  const A = naturalKey(a), B = naturalKey(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    if (A[i] === undefined) return -1;
    if (B[i] === undefined) return 1;
    if (A[i] === B[i]) continue;
    if (typeof A[i] === 'number' && typeof B[i] === 'number') return A[i] - B[i];
    return A[i] < B[i] ? -1 : 1;
  }
  return 0;
};
const tryIndexGuess = (files, season, episode, expectedRuntimeMin) => {
  let candidates = files.filter(isVideoFile);
  const seasonRegexes = [
    new RegExp(`\\bseason[ ._\\-]*${season}\\b`, 'i'),
    new RegExp(`\\bs0?${season}\\b`, 'i'),
  ];
  const seasonSubset = candidates.filter(f => seasonRegexes.some(rx => rx.test(f.name || '')));
  if (seasonSubset.length >= 2) candidates = seasonSubset;

  candidates.sort((a, b) => naturalSort(a.name || '', b.name || ''));
  const idx = Math.max(episode - 1, 0);
  const chosen = candidates[idx];
  if (!chosen) return null;

  const sec = parseDurationToSeconds(chosen.length);
  if (expectedRuntimeMin && sec) {
    const diff = Math.abs(sec / 60 - expectedRuntimeMin);
    if (diff > INDEX_GUESS_MAX_VARIANCE_MIN) return null;
  }
  return chosen;
};

// ---------------------------- Collection fallback ----------------------------
const findCollectionsForTitles = async (terms) => {
  const out = [];
  const seen = new Set();
  for (const t of terms.slice(0, 5)) {
    const q = `title:("${t.replace(/"/g, '\\"')}") AND mediatype:(collection)`;
    const docs = await queryIA({ q, rows: 5 });
    for (const d of docs) {
      if (!seen.has(d.identifier)) {
        seen.add(d.identifier);
        out.push(d);
      }
    }
  }
  return out.slice(0, 3);
};

const buildCollectionChildQueries = (collectionId, season, episode, epTitle) => {
  const s = String(season).padStart(2,'0');
  const e = String(episode).padStart(2,'0');
  const base = `collection:(${collectionId}) AND mediatype:(movies)`;
  const qs = [
    `${base} AND (S${s}E${e})`,
    `${base} AND (${season}x${e})`,
    `${base} AND ("Season ${season}" AND ("Episode ${episode}" OR "Ep ${episode}" OR "Ep. ${episode}"))`,
    `${base} AND ("Episode ${episode}")`,
    `${base} AND ("Part ${episode}")`,
    `${base} AND ("E${e}")`,
    `${base} AND (title:(complete OR "full series" OR season OR pack OR collection OR batch))`
  ];
  if (epTitle) qs.push(`${base} AND ("${epTitle.replace(/"/g, '\\"')}")`);
  return [...new Set(qs)];
};

const findSeriesEpisodeViaCollections = async ({ terms, season, episode, year, epTitleCandidates, showTitle }) => {
  const collections = await findCollectionsForTitles(terms);
  const epTitle = epTitleCandidates?.[0];
  const streams = [];

  for (const col of collections) {
    const queries = buildCollectionChildQueries(col.identifier, season, episode, epTitle);
    const candidates = [];
    for (const q of queries) {
      try {
        const docs = await queryIA({ q, rows: 60 });
        candidates.push(...docs);
        if (candidates.length > 120) break;
      } catch {}
    }

    const seen = new Set();
    const uniq = candidates.filter(d => (seen.has(d.identifier) ? false : seen.add(d.identifier)));

    const scored = uniq.map(c => ({
      c,
      score: scoreDocAgainst(c, terms, year) +
             (/(s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2}|episode\s*\d+)/i.test(c.title || '') ? 0.25 : 0)
    })).sort((a, b) => b.score - a.score).slice(0, 24);

    for (const { c } of scored) {
      try {
        const meta = await getIAMetadata(c.identifier);
        if (!isPermissible(c, meta)) continue;
        const files = (meta?.files || []).filter(isVideoFile);

        let chosen = null;
        if (files.length === 1) {
          chosen = files[0];
        } else {
          const exact = files.filter(f => fileMatchesEpisode(f, season, episode, epTitleCandidates));
          if (exact.length) {
            exact.sort((a, b) => (b.size || 0) - (a.size || 0));
            chosen = exact[0];
          }
        }

        if (chosen) {
          streams.push(buildStream(c.identifier, chosen, { kind: 'series', show: showTitle, season, episode }));
          if (streams.length >= MAX_STREAMS_PER_TITLE) return streams;
        }
      } catch {}
    }
  }
  return streams;
};

// ---------------------------- Resolvers ----------------------------
const findMovieStreams = async ({ terms, year, expectedRuntimeMin, displayTitle }) => {
  const phases = [
    { collections: IA_COLLECTIONS, titleScoreMin: TITLE_SCORE_STRICT },
    { collections: [],            titleScoreMin: TITLE_SCORE_RELAXED }
  ];

  const streams = [];

  for (const phase of phases) {
    const queries = buildMovieQueries(terms, year);
    const candidates = [];
    for (const q of queries) {
      try {
        const docs = await queryIA({ q, mediatype: 'movies', collections: phase.collections, rows: 60 });
        for (const d of docs) if (!looksLikeJunk(d)) candidates.push(d);
        if (candidates.length > 150) break;
      } catch {}
    }

    const seen = new Set();
    const uniq = candidates.filter(d => (seen.has(d.identifier) ? false : seen.add(d.identifier)));

    const scored = uniq.map(c => ({ c, score: scoreDocAgainst(c, terms, year) }))
                       .sort((a, b) => b.score - a.score)
                       .slice(0, 30);

    for (const { c } of scored) {
      try {
        const meta = await getIAMetadata(c.identifier);
        if (!isPermissible(c, meta)) continue;

        const files = meta?.files || [];
        const sorted = pickBestVideoFiles(files);
        if (!sorted.length) continue;

        for (const file of sorted) {
          const sizeMB = Math.round((file.size || 0) / 1e6);
          if (sizeMB && sizeMB < MIN_FEATURE_SIZE_MB) continue;

          const sec = parseDurationToSeconds(file.length);
          if (sec) {
            if (sec < 40 * 60) continue; // avoid shorts
            if (expectedRuntimeMin && Math.abs(sec/60 - expectedRuntimeMin) > 20) {
              const tScore = scoreDocAgainst(c, terms, year);
              if (tScore < phase.titleScoreMin) continue;
            }
          }

          const tScore = scoreDocAgainst(c, terms, year);
          if (STRICT_MODE && tScore < phase.titleScoreMin) continue;

          streams.push(buildStream(c.identifier, file, { kind: 'movie', title: displayTitle, year }));
          if (streams.length >= MAX_STREAMS_PER_TITLE) break;
        }
        if (streams.length >= MAX_STREAMS_PER_TITLE) break;
      } catch {}
    }

    if (streams.length) break; // stop after first successful phase
  }

  return streams;
};

const findSeriesEpisodeStreams = async ({ terms, season, episode, year, epTitleCandidates, epDateTokens, expectedRuntimeMin, showTitle }) => {
  const phases = [
    { collections: IA_COLLECTIONS },
    { collections: [] }
  ];
  const streams = [];

  for (const phase of phases) {
    const queries = buildEpisodeQueries(terms, season, episode, year, epTitleCandidates[0]);
    const candidates = [];
    for (const q of queries) {
      try {
        const docs = await queryIA({ q, mediatype: 'movies', collections: phase.collections, rows: 80 });
        for (const d of docs) if (!looksLikeJunk(d)) candidates.push(d);
        if (candidates.length > 180) break;
      } catch {}
    }

    const seen = new Set();
    const uniq = candidates.filter(d => (seen.has(d.identifier) ? false : seen.add(d.identifier)));

    const scored = uniq.map(c => ({ c, score: scoreDocAgainst(c, terms, year) }))
                       .sort((a, b) => b.score - a.score)
                       .slice(0, 40);

    for (const { c } of scored) {
      try {
        const meta = await getIAMetadata(c.identifier);
        if (!isPermissible(c, meta)) continue;

        const files = (meta?.files || []).filter(isVideoFile);

        const exact = files.filter(f => fileMatchesEpisode(f, season, episode, epTitleCandidates, epDateTokens));
        if (exact.length) {
          exact.sort((a, b) => (b.size || 0) - (a.size || 0));
          for (const f of exact) {
            streams.push(buildStream(c.identifier, f, { kind: 'series', show: showTitle, season, episode }));
            if (streams.length >= MAX_STREAMS_PER_TITLE) break;
          }
        } else if (files.length === 1) {
          const tScore = scoreDocAgainst(c, terms, year);
          if (tScore > 0.85) streams.push(buildStream(c.identifier, files[0], { kind: 'series', show: showTitle, season, episode }));
        }
        if (streams.length >= MAX_STREAMS_PER_TITLE) break;
      } catch {}
    }

    if (streams.length) break; // stop after first successful phase
  }

  // Fallback: search inside true IA collections
  if (!streams.length) {
    const extra = await findSeriesEpisodeViaCollections({ terms, season, episode, year, epTitleCandidates, showTitle });
    streams.push(...extra);
  }

  // Optional last-resort: index-guess in packs
  if (!streams.length && ALLOW_INDEX_GUESS) {
    const queries = buildEpisodeQueries(terms, season, episode, year, epTitleCandidates[0]);
    const candidates = [];
    for (const q of queries.slice(0, 6)) {
      try {
        const docs = await queryIA({ q, mediatype: 'movies', rows: 50 });
        candidates.push(...docs);
        if (candidates.length > 100) break;
      } catch {}
    }
    const seen = new Set();
    const uniq = candidates.filter(d => (seen.has(d.identifier) ? false : seen.add(d.identifier)));
    const scored = uniq.map(c => ({ c, score: scoreDocAgainst(c, terms, year) }))
                       .sort((a, b) => b.score - a.score)
                       .slice(0, 10);

    for (const { c } of scored) {
      try {
        const meta = await getIAMetadata(c.identifier);
        if (!isPermissible(c, meta)) continue;
        const files = (meta?.files || []).filter(isVideoFile);
        const guess = tryIndexGuess(files, season, episode, expectedRuntimeMin);
        if (guess) {
          streams.push(buildStream(c.identifier, guess, { kind: 'series', show: showTitle, season, episode }));
          break;
        }
      } catch {}
    }
  }

  return streams;
};

// ---------------------------- Manifest & handler ----------------------------
const manifest = {
  id: 'org.archive.scraper',
  version: '1.3.0',
  name: 'Internet Archive Scraper',
  description: 'Resolves Cinemeta/TMDB titles to archive.org streams (strict anti-nonsense; true file info only)',
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

    // titles + acronyms
    const titles = altTitlesFrom(cm, tmdb, type);
    if (!titles.includes(title)) titles.unshift(title);
    const acr = titles.flatMap(t => acronymsFromTitle(t));
    const terms = [...new Set([...titles, ...acr])];

    if (type === 'movie') {
      const expectedRuntimeMin =
        (cm?.meta?.runtime && Number(cm.meta.runtime)) ||
        (tmdb?.runtime && Number(tmdb.runtime)) ||
        null;

      const streams = await findMovieStreams({ terms, year, expectedRuntimeMin, displayTitle: title });
      return { streams };
    } else {
      const season = parseInt(args.seriesInfo?.season || args.extra?.season || 0, 10);
      const episode = parseInt(args.seriesInfo?.episode || args.extra?.episode || 0, 10);
      if (!season || !episode) return { streams: [] };

      const videos = Array.isArray(cm?.meta?.videos) ? cm.meta.videos : [];
      const epMeta = videos.find(x => Number(x.season) === Number(season) && Number(x.episode) === Number(episode));
      const epTitle = epMeta?.title || epMeta?.name || null;
      const epDateTokens = dateTokensFromIso(epMeta?.released || epMeta?.firstAired || cm?.meta?.releaseDate) || [];

      const expectedRuntimeMin =
        (cm?.meta?.runtime && Number(cm.meta.runtime)) || null;

      const streams = await findSeriesEpisodeStreams({
        terms,
        season,
        episode,
        year,
        epTitleCandidates: epTitle ? [epTitle] : [],
        epDateTokens,
        expectedRuntimeMin,
        showTitle: title
      });
      return { streams };
    }
  } catch (e) {
    console.error('stream error', e);
    return { streams: [] };
  }
});

// Build once
const iface = builder.getInterface();
// Turn the interface into a Node req/res handler
const router = getRouter(iface);

// Vercel entrypoint with URL normalization
module.exports = (req, res) => {
try {
const u = new URL(req.url, 'http://localhost');
let pathname = u.pathname || '/';
   // strip /api/addon prefix
if (pathname.startsWith('/api/addon')) {
  pathname = pathname.slice('/api/addon'.length) || '/';
}

// remove Vercel catch‑all params
u.searchParams.delete('path');
u.searchParams.delete('slug');

// forward to Stremio router
req.url = pathname + (u.search || '');
router(req, res);
} catch (e) {
res.statusCode = 500;
res.setHeader('content-type', 'application/json');
res.end(JSON.stringify({ error: e.message }));
}
};
