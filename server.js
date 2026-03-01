const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const ROMS_DIR   = path.join(__dirname, 'roms');
const CACHE_DIR  = path.join(__dirname, '.artwork-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'index.json');

// ─────────────────────────────────────────────────────────────
//  ARTWORK CACHE  (persists across restarts)
// ─────────────────────────────────────────────────────────────
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let artworkCache = {};
try { artworkCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(artworkCache, null, 2)); } catch {}
}

// ─────────────────────────────────────────────────────────────
//  HTTP HELPER  (no external deps, uses Node built-in https)
// ─────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'RetroVault/2.0', ...headers } }, res => {
      // Follow up to 3 redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
//  ARTWORK RESOLVER  — 4 sources, smart name normalization
// ─────────────────────────────────────────────────────────────

// Normalize name for better API matching
// "Super Mario Bros 3 (USA)" -> "Super Mario Bros 3"
function normalizeForSearch(name) {
  return name
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')  // remove (USA), [!], etc
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Score how well a result title matches our query (0-100)
function matchScore(resultName, queryName) {
  const a = resultName.toLowerCase().trim();
  const b = queryName.toLowerCase().trim();
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 85;
  // word overlap
  const wa = new Set(a.split(/\s+/));
  const wb = new Set(b.split(/\s+/));
  const overlap = [...wa].filter(w => wb.has(w)).length;
  return Math.round((overlap / Math.max(wa.size, wb.size)) * 70);
}

const RAWG_PLATFORM = {
  nes:4, snes:10, gb:8, gbc:43, gba:24, n64:83, nds:77,
  genesis:167, sms:167, gamegear:null, sega32x:null, segacd:null,
  psx:27, pce:null, atari2600:28, atari7800:null, lynx:null,
  ngp:null, wonderswan:null, virtualboy:null, mame:null,
};

const RAWG_BASE = 'https://api.rawg.io/api';
const RAWG_KEY  = '';  // optional: get free key at rawg.io

// ─────────────────────────────────────────────────────────────
//  LOGO RESOLVER  — logos PNG con transparencia, sin key
//  Fuentes: SteamGridDB (si hay key) → Open Logo CDN → Wikipedia
// ─────────────────────────────────────────────────────────────
const SGDB_KEY = '';  // opcional: key gratis en steamgriddb.com/profile/preferences/api

async function resolveLogo(gameName, consoleId) {
  const name = normalizeForSearch(gameName);

  // ── A. SteamGridDB (mejor calidad, requiere key gratuita) ─
  if (SGDB_KEY) {
    try {
      const q = encodeURIComponent(name);
      const search = await httpGet(
        `https://www.steamgriddb.com/api/v2/search/autocomplete/${q}`,
        { Authorization: `Bearer ${SGDB_KEY}` }
      );
      const game = search?.data?.[0];
      if (game?.id) {
        const logos = await httpGet(
          `https://www.steamgriddb.com/api/v2/logos/game/${game.id}?styles=official,white&mime=png,webp`,
          { Authorization: `Bearer ${SGDB_KEY}` }
        );
        const logo = logos?.data?.[0];
        if (logo?.url) return logo.url;
      }
    } catch {}
  }

  // ── B. Wikipedia / Wikimedia Commons — logos oficiales SVG ─
  // Busca la página del juego y extrae la imagen del infobox
  try {
    const q = encodeURIComponent(name.replace(/\s+/g, '_'));
    const data = await httpGet(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${q}`
    );
    // Wikipedia thumbnails are screenshots/box art, not logos — skip if no good match
    if (data?.title && matchScore(data.title, name) >= 60) {
      // Try to get the logo from Wikimedia search
      const imgSearch = await httpGet(
        `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + ' logo video game')}&srnamespace=6&srlimit=3&format=json`
      );
      const results = imgSearch?.query?.search;
      if (results?.length) {
        // Get direct image URL for first result
        const title = results[0].title;
        const imgInfo = await httpGet(
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&format=json`
        );
        const pages = imgInfo?.query?.pages;
        if (pages) {
          const page = Object.values(pages)[0];
          const url  = page?.imageinfo?.[0]?.url;
          // Only accept PNG/SVG (transparent background likely)
          if (url && (url.endsWith('.png') || url.endsWith('.svg'))) {
            return url;
          }
        }
      }
    }
  } catch {}

  // ── C. Open Logo CDN (logos de marcas/franquicias conocidas) ─
  try {
    // Normalize: "Super Mario Bros" → "super-mario-bros"
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const url  = `https://logo.clearbit.com/${slug}.com`;
    // Clearbit works for companies/brands, not specific games — skip for game names
    // Better: use a direct check against known franchise slugs
    void url; // intentionally unused
  } catch {}

  return null;
}

async function resolveArtwork(gameName, consoleId) {
  const cacheKey = `${consoleId}::${gameName.toLowerCase()}`;
  if (cacheKey in artworkCache) return artworkCache[cacheKey];

  const searchName = normalizeForSearch(gameName);
  let coverUrl = null;
  let logoUrl  = null;

  // ── 1. RAWG with platform filter ──────────────────────────
  if (!coverUrl) {
    try {
      const platform = RAWG_PLATFORM[consoleId];
      const q        = encodeURIComponent(searchName);
      const platPart = platform ? `&platforms=${platform}` : '';
      const keyPart  = RAWG_KEY ? `&key=${RAWG_KEY}` : '';
      const data = await httpGet(`${RAWG_BASE}/games?search=${q}${platPart}&page_size=6&search_precise=true${keyPart}`);
      if (data.results?.length) {
        const scored = data.results
          .map(r => ({ r, score: matchScore(r.name, searchName) }))
          .sort((a,b) => b.score - a.score);
        const best = scored[0];
        if (best.score >= 50 && best.r.background_image) coverUrl = best.r.background_image;
      }
    } catch {}
  }

  // ── 2. RAWG without platform ──────────────────────────────
  if (!coverUrl) {
    try {
      const q = encodeURIComponent(searchName);
      const keyPart = RAWG_KEY ? `&key=${RAWG_KEY}` : '';
      const data = await httpGet(`${RAWG_BASE}/games?search=${q}&page_size=5${keyPart}`);
      if (data.results?.length) {
        const scored = data.results
          .map(r => ({ r, score: matchScore(r.name, searchName) }))
          .sort((a,b) => b.score - a.score);
        const best = scored[0];
        if (best.score >= 40 && best.r.background_image) coverUrl = best.r.background_image;
      }
    } catch {}
  }

  // ── 3. TheGamesDB ─────────────────────────────────────────
  if (!coverUrl) {
    try {
      const q = encodeURIComponent(searchName);
      const data = await httpGet(`https://api.thegamesdb.net/v1/Games/ByGameName?apikey=0&name=${q}&fields=boxart`);
      const games = data?.data?.games;
      if (Array.isArray(games) && games.length) {
        const scored = games.map(g=>({g, score: matchScore(g.game_title||'', searchName)})).sort((a,b)=>b.score-a.score);
        const best = scored[0];
        if (best.score >= 40 && data?.data?.boxart?.data) {
          const bd = data.data.boxart.data[best.g.id];
          if (Array.isArray(bd) && bd.length) {
            const front = bd.find(b=>b.side==='front')||bd[0];
            if (front?.filename) coverUrl = `https://cdn.thegamesdb.net/images/original/${front.filename}`;
          }
        }
      }
    } catch {}
  }

  // ── 4. Screenscraper ──────────────────────────────────────
  if (!coverUrl) {
    try {
      const q = encodeURIComponent(searchName);
      const data = await httpGet(`https://www.screenscraper.fr/api2/jeuRecherche.php?devid=&devpassword=&softname=retrovault&output=json&recherche=${q}`);
      const jeux = data?.response?.jeux;
      if (Array.isArray(jeux) && jeux.length) {
        const scored = jeux.map(j=>({j, score: matchScore(j.noms?.[0]?.text||'', searchName)})).sort((a,b)=>b.score-a.score);
        const best = scored[0];
        if (best.score >= 35 && best.j.medias) {
          const media = best.j.medias.find(m=>m.type==='box-2D'||m.type==='screenshot-gameplay');
          if (media?.url) coverUrl = media.url;
        }
      }
    } catch {}
  }

  // ── 5. Logo + remaining cover searches run in parallel ───
  logoUrl = await resolveLogo(gameName, consoleId);

  const result = { cover: coverUrl, logo: logoUrl };
  artworkCache[cacheKey] = result;
  saveCache();
  return result;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  CONSOLE DATABASE
//  Every known console: extensions, EmulatorJS core, metadata
// ─────────────────────────────────────────────────────────────
const CONSOLE_DB = {
  nes: {
    name: 'NES / Famicom',
    shortName: 'NES',
    icon: 'nes',
    color: '#FF4655',
    gradient: 'linear-gradient(135deg, #FF4655 0%, #c0392b 100%)',
    core: 'nes',
    ejsCore: 'fceumm',
    extensions: ['nes', 'fds', 'unf', 'unif'],
    year: '1983'
  },
  snes: {
    name: 'Super Nintendo',
    shortName: 'SNES',
    icon: 'snes',
    color: '#7B68EE',
    gradient: 'linear-gradient(135deg, #7B68EE 0%, #4834d4 100%)',
    core: 'snes',
    ejsCore: 'snes9x',
    extensions: ['snes', 'smc', 'sfc', 'fig', 'bs'],
    year: '1990'
  },
  gb: {
    name: 'Game Boy',
    shortName: 'GB',
    icon: 'gb',
    color: '#8BC34A',
    gradient: 'linear-gradient(135deg, #8BC34A 0%, #558b2f 100%)',
    core: 'gb',
    ejsCore: 'gambatte',
    extensions: ['gb', 'dmg'],
    year: '1989'
  },
  gbc: {
    name: 'Game Boy Color',
    shortName: 'GBC',
    icon: 'gbc',
    color: '#26C6DA',
    gradient: 'linear-gradient(135deg, #26C6DA 0%, #00838f 100%)',
    core: 'gbc',
    ejsCore: 'gambatte',
    extensions: ['gbc'],
    year: '1998'
  },
  gba: {
    name: 'Game Boy Advance',
    shortName: 'GBA',
    icon: 'gba',
    color: '#AB47BC',
    gradient: 'linear-gradient(135deg, #AB47BC 0%, #6a1b9a 100%)',
    core: 'gba',
    ejsCore: 'mgba',
    extensions: ['gba'],
    year: '2001'
  },
  n64: {
    name: 'Nintendo 64',
    shortName: 'N64',
    icon: 'n64',
    color: '#42A5F5',
    gradient: 'linear-gradient(135deg, #42A5F5 0%, #1565c0 100%)',
    core: 'n64',
    ejsCore: 'mupen64plus_next',
    extensions: ['n64', 'z64', 'v64'],
    year: '1996'
  },
  nds: {
    name: 'Nintendo DS',
    shortName: 'NDS',
    icon: 'nds',
    color: '#EF5350',
    gradient: 'linear-gradient(135deg, #EF5350 0%, #b71c1c 100%)',
    core: 'nds',
    ejsCore: 'melonds',
    extensions: ['nds'],
    year: '2004'
  },
  genesis: {
    name: 'Sega Genesis / Mega Drive',
    shortName: 'Genesis',
    icon: 'genesis',
    color: '#1E88E5',
    gradient: 'linear-gradient(135deg, #1E88E5 0%, #0d47a1 100%)',
    core: 'segaMD',
    ejsCore: 'genesis_plus_gx',
    extensions: ['md', 'gen', 'smd'],
    year: '1988'
  },
  sms: {
    name: 'Sega Master System',
    shortName: 'SMS',
    icon: 'sms',
    color: '#00ACC1',
    gradient: 'linear-gradient(135deg, #00ACC1 0%, #006064 100%)',
    core: 'segaMS',
    ejsCore: 'genesis_plus_gx',
    extensions: ['sms'],
    year: '1985'
  },
  gamegear: {
    name: 'Sega Game Gear',
    shortName: 'Game Gear',
    icon: 'gg',
    color: '#26A69A',
    gradient: 'linear-gradient(135deg, #26A69A 0%, #004d40 100%)',
    core: 'segaGG',
    ejsCore: 'genesis_plus_gx',
    extensions: ['gg'],
    year: '1990'
  },
  sega32x: {
    name: 'Sega 32X',
    shortName: '32X',
    icon: '32x',
    color: '#E53935',
    gradient: 'linear-gradient(135deg, #E53935 0%, #b71c1c 100%)',
    core: 'sega32x',
    ejsCore: 'picodrive',
    extensions: ['32x'],
    year: '1994'
  },
  segacd: {
    name: 'Sega CD / Mega CD',
    shortName: 'Sega CD',
    icon: 'segacd',
    color: '#5C6BC0',
    gradient: 'linear-gradient(135deg, #5C6BC0 0%, #283593 100%)',
    core: 'segaCD',
    ejsCore: 'genesis_plus_gx',
    extensions: ['cue', 'chd'],
    year: '1991'
  },
  psx: {
    name: 'PlayStation',
    shortName: 'PS1',
    icon: 'psx',
    color: '#3D5AF1',
    gradient: 'linear-gradient(135deg, #3D5AF1 0%, #1a237e 100%)',
    core: 'psx',
    ejsCore: 'pcsx_rearmed',
    extensions: ['iso', 'bin', 'img', 'pbp'],
    year: '1994'
  },
  pce: {
    name: 'PC Engine / TurboGrafx-16',
    shortName: 'PC Engine',
    icon: 'pce',
    color: '#FFA726',
    gradient: 'linear-gradient(135deg, #FFA726 0%, #e65100 100%)',
    core: 'pce',
    ejsCore: 'mednafen_pce',
    extensions: ['pce', 'tg16', 'sgx'],
    year: '1987'
  },
  atari2600: {
    name: 'Atari 2600',
    shortName: 'Atari 2600',
    icon: 'atari',
    color: '#FF7043',
    gradient: 'linear-gradient(135deg, #FF7043 0%, #bf360c 100%)',
    core: 'atari2600',
    ejsCore: 'stella2014',
    extensions: ['a26'],
    year: '1977'
  },
  atari7800: {
    name: 'Atari 7800',
    shortName: 'Atari 7800',
    icon: 'atari',
    color: '#FF8A65',
    gradient: 'linear-gradient(135deg, #FF8A65 0%, #bf360c 100%)',
    core: 'atari7800',
    ejsCore: 'prosystem',
    extensions: ['a78'],
    year: '1986'
  },
  lynx: {
    name: 'Atari Lynx',
    shortName: 'Lynx',
    icon: 'lynx',
    color: '#FFCA28',
    gradient: 'linear-gradient(135deg, #FFCA28 0%, #f57f17 100%)',
    core: 'lynx',
    ejsCore: 'mednafen_lynx',
    extensions: ['lnx'],
    year: '1989'
  },
  ngp: {
    name: 'Neo Geo Pocket',
    shortName: 'NGP',
    icon: 'ngp',
    color: '#9C27B0',
    gradient: 'linear-gradient(135deg, #9C27B0 0%, #4a148c 100%)',
    core: 'ngp',
    ejsCore: 'mednafen_ngp',
    extensions: ['ngp', 'ngc'],
    year: '1998'
  },
  wonderswan: {
    name: 'WonderSwan',
    shortName: 'WonderSwan',
    icon: 'ws',
    color: '#B0BEC5',
    gradient: 'linear-gradient(135deg, #B0BEC5 0%, #546e7a 100%)',
    core: 'wonderSwan',
    ejsCore: 'mednafen_wswan',
    extensions: ['ws', 'wsc'],
    year: '1999'
  },
  virtualboy: {
    name: 'Virtual Boy',
    shortName: 'Virtual Boy',
    icon: 'vb',
    color: '#F44336',
    gradient: 'linear-gradient(135deg, #F44336 0%, #b71c1c 100%)',
    core: 'vb',
    ejsCore: 'mednafen_vb',
    extensions: ['vb'],
    year: '1995'
  },
  mame: {
    name: 'Arcade / MAME',
    shortName: 'Arcade',
    icon: 'mame',
    color: '#FFD600',
    gradient: 'linear-gradient(135deg, #FFD600 0%, #f57f17 100%)',
    core: 'arcade',
    ejsCore: 'mame2003',
    extensions: ['zip'],
    year: '1978'
  }
};

// Build extension → consoleId map (zip last to not override others)
const EXT_MAP = {};
for (const [id, data] of Object.entries(CONSOLE_DB)) {
  for (const ext of data.extensions) {
    if (!EXT_MAP[ext]) EXT_MAP[ext] = id;
  }
}
// zip is ambiguous — MAME only if no other match in filename
EXT_MAP['zip'] = 'mame';

// ─────────────────────────────────────────────────────────────
//  ROM SCANNER
// ─────────────────────────────────────────────────────────────
function getExt(filename) {
  const m = filename.toLowerCase().match(/\.([^.]+)$/);
  return m ? m[1] : null;
}

function cleanName(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\(.*?\)/g, '')
    .replace(/\s*\[.*?\]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectRegion(filename) {
  const f = filename.toLowerCase();
  if (f.includes('(usa)') || f.includes('(u)')) return 'USA';
  if (f.includes('(europe)') || f.includes('(e)')) return 'EUR';
  if (f.includes('(japan)') || f.includes('(j)')) return 'JPN';
  if (f.includes('(world)') || f.includes('(w)')) return 'WLD';
  if (f.includes('(spain)') || f.includes('(s)')) return 'SPA';
  return null;
}

function scanRoms() {
  if (!fs.existsSync(ROMS_DIR)) {
    fs.mkdirSync(ROMS_DIR, { recursive: true });
    return {};
  }

  // Scan recursively up to 2 levels
  function scanDir(dir, depth = 0) {
    let results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 2) {
          results = results.concat(scanDir(fullPath, depth + 1));
        } else if (entry.isFile()) {
          const ext = getExt(entry.name);
          if (!ext) continue;
          const consoleId = EXT_MAP[ext] || null;
          const stats = fs.statSync(fullPath);
          results.push({
            filename: entry.name,
            cleanName: cleanName(entry.name),
            region: detectRegion(entry.name),
            ext,
            consoleId,
            size: stats.size,
            relativePath: path.relative(ROMS_DIR, fullPath),
            mtime: stats.mtimeMs
          });
        }
      }
    } catch (e) { /* skip unreadable */ }
    return results;
  }

  const allFiles = scanDir(ROMS_DIR);

  // Group by console → by game name (for multi-version detection)
  const grouped = {};
  const unknown = [];

  for (const rom of allFiles) {
    if (!rom.consoleId) {
      unknown.push(rom);
      continue;
    }
    if (!grouped[rom.consoleId]) grouped[rom.consoleId] = {};
    const key = rom.cleanName.toLowerCase();
    if (!grouped[rom.consoleId][key]) {
      grouped[rom.consoleId][key] = {
        displayName: rom.cleanName,
        versions: []
      };
    }
    grouped[rom.consoleId][key].versions.push(rom);
  }

  return { grouped, unknown, total: allFiles.length };
}

// ─────────────────────────────────────────────────────────────
//  API ENDPOINTS
// ─────────────────────────────────────────────────────────────

// GET /api/library — return full scanned library
app.get('/api/library', (req, res) => {
  try {
    const data = scanRoms();
    res.json({
      ok: true,
      consoles: CONSOLE_DB,
      ...data
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/rom?path=... — serve the actual ROM file
app.get('/api/rom', (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'Missing path' });

    // Security: prevent path traversal
    const abs = path.resolve(ROMS_DIR, rel);
    if (!abs.startsWith(path.resolve(ROMS_DIR))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });

    res.sendFile(abs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/artwork?game=...&console=... — fetch cover + logo (cached)
app.get('/api/artwork', async (req, res) => {
  const { game, console: cid } = req.query;
  if (!game) return res.status(400).json({ error: 'Missing game' });
  try {
    const result = await resolveArtwork(game, cid || '');
    // Support both old { url } format and new { cover, logo }
    res.json({ ok: true, cover: result?.cover || null, logo: result?.logo || null, url: result?.cover || null });
  } catch (e) {
    res.json({ ok: false, cover: null, logo: null, url: null, error: e.message });
  }
});

// POST /api/artwork/bulk — batch fetch [{ game, console }]
app.post('/api/artwork/bulk', async (req, res) => {
  const games = req.body?.games;
  if (!Array.isArray(games)) return res.status(400).json({ error: 'Expected games array' });

  const limit = 4;
  const results = {};
  const queue = [...games];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      const key = `${item.console}::${item.game}`;
      try { results[key] = await resolveArtwork(item.game, item.console || ''); }
      catch { results[key] = null; }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  res.json({ ok: true, results });
});

// GET / — serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Migrate old string-format cache entries to { cover, logo } objects
for (const [k, v] of Object.entries(artworkCache)) {
  if (typeof v === 'string') {
    artworkCache[k] = { cover: v, logo: null };
  }
}

module.exports = app;