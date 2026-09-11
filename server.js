'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { createStore, readJson, writeJson } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_NAME = (process.env.ADMIN_NAME || 'kawaiifreak97').trim().toLowerCase();
// STORAGE_DIR moves the local data + photo folders (only used when Firebase isn't configured)
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || __dirname);
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const GAME_FILE = path.join(DATA_DIR, 'game.json');
const BUNDLED_SETTINGS = path.join(__dirname, 'data', 'settings.json');
const TEAM_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1', '#06b6d4', '#e11d48'];
const MISSING_GUESS_PENALTY = 20_000_000; // metres; only used as a leaderboard tie-breaker
const ROUND_GRACE_MS = 750; // lets last-second submissions arrive
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const PHOTO_ID = /^[a-f0-9]{20}\.(jpg|png|webp|gif)$/;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const isAdmin = name => String(name || '').trim().toLowerCase() === ADMIN_NAME;
const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const wrapLng = lng => ((((lng + 180) % 360) + 360) % 360) - 180;
const newId = () => crypto.randomBytes(6).toString('hex');
const photoUrl = round => `/photos/${round.photoId}`;
const cleanName = name => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
const reply = (ack, value) => { if (typeof ack === 'function') ack(value); };

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function lanUrls() {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
  }
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return addrs.sort((a, b) => rank(a) - rank(b)).map(ip => `http://${ip}:${PORT}`);
}

// ---------- templates, settings + photos (kept in memory, written through to the store) ----------
const store = createStore({ rootDir: __dirname, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR });
// Render's free tier wipes local files whenever it restarts; Firebase doesn't
const EPHEMERAL_STORAGE = store.kind === 'local' && !!process.env.RENDER && !process.env.STORAGE_DIR;

const templates = new Map(); // id -> { id, name, rounds: [{ id, photoId, lat, lng, label }], createdAt, updatedAt }
const settings = {
  timerSeconds: 30,
  showPhotoOnDevices: true,
  mapStart: { lat: 20, lng: 0, zoom: 2 },
  cartoKey: '',
  activeTemplateId: null,
};

const activeTemplate = () => templates.get(settings.activeTemplateId);
const sortedTemplates = () => [...templates.values()].sort((a, b) => a.createdAt - b.createdAt);
const templateSummary = t => ({ id: t.id, name: t.name, roundCount: t.rounds.length, updatedAt: t.updatedAt });
const saveSettings = () => store.saveSettings(settings);

async function saveTemplate(t) {
  t.updatedAt = Date.now();
  await store.saveTemplate(t);
}

async function createTemplate(name, rounds = [], id = newId()) {
  const t = { id, name, rounds, createdAt: Date.now(), updatedAt: Date.now() };
  templates.set(t.id, t);
  await store.saveTemplate(t);
  return t;
}

async function loadFromStore() {
  Object.assign(settings, readJson(BUNDLED_SETTINGS, {}), (await store.loadSettings()) || {});
  for (const t of await store.loadTemplates()) templates.set(t.id, t);
  // fixed id, so the laptop and the hosted site booting at once don't each create a default game
  if (!templates.size) await createTemplate('My game', [], 'default');
  if (!templates.has(settings.activeTemplateId)) {
    settings.activeTemplateId = sortedTemplates()[0].id;
    await saveSettings();
  }

  // Firebase only: pick up changes made by the other server (laptop <-> hosted site)
  store.watch?.({
    onTemplates(list) {
      if (!list.length) return;
      templates.clear();
      for (const t of list) templates.set(t.id, t);
      if (!templates.has(settings.activeTemplateId)) settings.activeTemplateId = sortedTemplates()[0].id;
      broadcastState();
    },
    onSettings(saved) {
      Object.assign(settings, saved);
      if (!templates.has(settings.activeTemplateId)) settings.activeTemplateId = sortedTemplates()[0]?.id ?? null;
      broadcastState();
    },
  });
}

// photoId -> Promise<{ buffer, contentType } | null>; photos never change, so caching is safe
const photoCache = new Map();
function getPhoto(id) {
  if (!photoCache.has(id)) {
    const pending = store.loadPhoto(id).then(
      photo => { if (!photo) photoCache.delete(id); return photo; },
      err => { photoCache.delete(id); throw err; },
    );
    photoCache.set(id, pending);
    if (photoCache.size > 60) photoCache.delete(photoCache.keys().next().value);
  }
  return photoCache.get(id);
}

// deletes photos that no template (and not the game in progress) uses any more
async function deleteUnusedPhotos(photoIds) {
  const used = new Set([...templates.values()].flatMap(t => t.rounds.map(r => r.photoId)));
  for (const r of game.rounds) used.add(r.photoId);
  for (const id of photoIds) {
    if (used.has(id)) continue;
    photoCache.delete(id);
    await store.deletePhoto(id).catch(err => console.error(`Could not delete photo ${id}:`, err.message));
  }
}

// ---------- game state (local file; only needs to survive a quick restart) ----------
function freshGame(teams = {}) {
  return { phase: 'lobby', rounds: [], roundIndex: -1, endsAt: null, guesses: {}, results: [], teams };
}
let game = readJson(GAME_FILE, null) || freshGame();
if (!Array.isArray(game.rounds)) game = freshGame(game.teams || {}); // game file from an older version
const saveGame = () => writeJson(GAME_FILE, game);
const currentRound = () => game.rounds[game.roundIndex];
const gameRunning = () => game.phase === 'round' || game.phase === 'results';

// live socket connections per team (not persisted)
const connections = new Map(); // teamKey -> Set<socketId>
const isConnected = key => (connections.get(key)?.size || 0) > 0;

function nextColor() {
  const used = new Set(Object.values(game.teams).map(t => t.color));
  return TEAM_COLORS.find(c => !used.has(c)) || TEAM_COLORS[Object.keys(game.teams).length % TEAM_COLORS.length];
}

// ---------- state sent to clients ----------
function teamSummaries() {
  return Object.entries(game.teams)
    .map(([key, t]) => {
      let totalDistance = 0;
      for (const r of game.results) {
        const g = r?.guesses.find(x => x.teamKey === key);
        totalDistance += g ? g.distance : MISSING_GUESS_PENALTY;
      }
      return {
        key, name: t.name, color: t.color, score: t.score, totalDistance,
        connected: isConnected(key),
        hasPin: !!game.guesses[key],
        submitted: !!game.guesses[key]?.submitted,
      };
    })
    .sort((a, b) => b.score - a.score || a.totalDistance - b.totalDistance || a.name.localeCompare(b.name));
}

function buildState(role, teamKey) {
  const round = gameRunning() ? currentRound() : null;
  const state = {
    now: Date.now(),
    phase: game.phase,
    roundNumber: game.roundIndex + 1,
    totalRounds: game.phase === 'lobby' ? activeTemplate()?.rounds.length || 0 : game.rounds.length,
    endsAt: game.endsAt,
    timerSeconds: settings.timerSeconds,
    mapStart: settings.mapStart,
    teams: teamSummaries(),
    photo: null,
    result: game.phase === 'results' ? game.results[game.roundIndex] : null,
  };
  if (round && (role !== 'player' || settings.showPhotoOnDevices || game.phase === 'results')) state.photo = photoUrl(round);
  if (role === 'player') {
    const t = game.teams[teamKey];
    state.myTeam = t ? { key: teamKey, name: t.name, color: t.color, score: t.score } : null;
    state.myGuess = game.guesses[teamKey] || null;
  }
  if (role === 'admin') {
    state.roundsCount = activeTemplate()?.rounds.length || 0;
    state.activeTemplateId = settings.activeTemplateId;
    state.activeTemplateName = activeTemplate()?.name || '';
    state.storage = store.kind;
    state.ephemeralStorage = EPHEMERAL_STORAGE;
    state.answer = round ? { lat: round.lat, lng: round.lng, label: round.label } : null;
  }
  return state;
}

let io;
const sendState = socket => socket.emit('state', buildState(socket.data.role, socket.data.teamKey));
function broadcastState() {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) if (socket.data.role) sendState(socket);
}

// ---------- game flow ----------
let roundTimer = null;
let allInTimer = null;

function startGame() {
  const tpl = activeTemplate();
  if (!tpl?.rounds.length) throw new Error('Add at least one round to the selected game first.');
  if (gameRunning()) throw new Error('A game is already running. Go back to the lobby first.');
  for (const t of Object.values(game.teams)) t.score = 0;
  // snapshot the rounds so editing the template mid-game can't break the game
  game.rounds = tpl.rounds.map(r => ({ ...r }));
  game.results = [];
  for (const r of game.rounds) getPhoto(r.photoId).catch(() => {}); // warm the cache
  startRound(0);
}

function startRound(index) {
  clearTimeout(allInTimer);
  game.phase = 'round';
  game.roundIndex = index;
  game.guesses = {};
  game.endsAt = Date.now() + settings.timerSeconds * 1000;
  scheduleRoundEnd();
  saveGame();
  broadcastState();
}

function scheduleRoundEnd() {
  clearTimeout(roundTimer);
  roundTimer = setTimeout(endRound, Math.max(0, game.endsAt - Date.now()) + ROUND_GRACE_MS);
}

function endRound() {
  if (game.phase !== 'round') return;
  clearTimeout(roundTimer);
  clearTimeout(allInTimer);
  const round = currentRound();
  // unsubmitted pins still count when time runs out
  const guesses = Object.entries(game.guesses)
    .filter(([key]) => game.teams[key])
    .map(([key, g]) => ({
      teamKey: key, name: game.teams[key].name, color: game.teams[key].color,
      lat: g.lat, lng: g.lng, submitted: g.submitted,
      distance: haversine(round.lat, round.lng, g.lat, g.lng),
    }))
    .sort((a, b) => a.distance - b.distance);
  // closest team wins the point; anyone within 1 m of the best shares it
  const winners = guesses.filter(g => g.distance - guesses[0].distance < 1).map(g => g.teamKey);
  for (const key of winners) game.teams[key].score += 1;
  game.results[game.roundIndex] = {
    roundNumber: game.roundIndex + 1,
    answer: { lat: round.lat, lng: round.lng, label: round.label, photo: photoUrl(round) },
    guesses,
    winners,
  };
  game.phase = 'results';
  game.endsAt = null;
  saveGame();
  broadcastState();
}

function nextRound() {
  if (game.phase !== 'results') throw new Error('Nothing to advance to right now.');
  if (game.roundIndex + 1 < game.rounds.length) return startRound(game.roundIndex + 1);
  game.phase = 'final';
  saveGame();
  broadcastState();
}

// end the round early once every team has locked in
function checkAllSubmitted() {
  const keys = Object.keys(game.teams);
  if (!keys.length || !keys.every(k => game.guesses[k]?.submitted)) return;
  const index = game.roundIndex;
  clearTimeout(allInTimer);
  allInTimer = setTimeout(() => { if (game.phase === 'round' && game.roundIndex === index) endRound(); }, 1500);
}

function kickSockets(key) {
  for (const id of connections.get(key) || []) {
    const socket = io.sockets.sockets.get(id);
    if (!socket) continue;
    socket.data.role = null;
    socket.data.teamKey = null;
    socket.emit('kicked');
  }
  connections.delete(key);
}

function removeTeam(key) {
  if (!game.teams[key]) throw new Error('Team not found.');
  kickSockets(key);
  delete game.teams[key];
  delete game.guesses[key];
  saveGame();
  broadcastState();
  if (game.phase === 'round') checkAllSubmitted();
}

function resetGame(keepTeams) {
  clearTimeout(roundTimer);
  clearTimeout(allInTimer);
  if (!keepTeams) for (const key of Object.keys(game.teams)) kickSockets(key);
  const teams = keepTeams ? game.teams : {};
  for (const t of Object.values(teams)) t.score = 0;
  game = freshGame(teams);
  saveGame();
  broadcastState();
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use('/vendor/exifr', express.static(path.join(__dirname, 'node_modules/exifr/dist')));

function requireAdmin(req, res, next) {
  if (isAdmin(req.get('x-admin'))) return next();
  res.status(403).json({ error: 'Admin only.' });
}

function findTemplate(req, res) {
  const t = templates.get(req.params.id);
  if (!t) res.status(404).json({ error: 'Game not found. Reload the page.' });
  return t;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.get('/photos/:id', async (req, res) => {
  if (!PHOTO_ID.test(req.params.id)) return res.status(404).end();
  try {
    const photo = await getPhoto(req.params.id);
    if (!photo) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(photo.contentType).send(photo.buffer);
  } catch (err) {
    console.error(`Photo ${req.params.id} failed to load:`, err.message);
    res.status(502).end();
  }
});

// PUBLIC_URL optionally overrides the join link shown on the presenter screen
app.get('/api/info', (req, res) => res.json({ publicUrl: process.env.PUBLIC_URL || null, lanUrls: lanUrls() }));

// Street-map tile key for the browser. CARTO keys are public by design (they sit in every tile URL);
// restrict yours to your domains on dashboard.basemaps.carto.com. CARTO_KEY on the host overrides the admin setting.
app.get('/config.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.GG_CONFIG = ${JSON.stringify({ cartoKey: process.env.CARTO_KEY || settings.cartoKey || '' })};`);
});

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text) return res.status(400).end();
  res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1 }));
});

// ----- game templates -----
app.get('/api/templates', requireAdmin, (req, res) => {
  res.json({ activeTemplateId: settings.activeTemplateId, templates: sortedTemplates().map(templateSummary) });
});

app.post('/api/templates', requireAdmin, async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Give the game a name.' });
  const source = req.body?.copyFrom ? templates.get(req.body.copyFrom) : null;
  // a duplicate shares the original's photos; a photo is only deleted once nothing uses it
  const t = await createTemplate(name, source ? source.rounds.map(r => ({ ...r, id: newId() })) : []);
  res.json(templateSummary(t));
});

app.get('/api/templates/:id', requireAdmin, (req, res) => {
  const t = findTemplate(req, res);
  if (t) res.json(t);
});

app.put('/api/templates/:id', requireAdmin, async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Give the game a name.' });
  t.name = name;
  await saveTemplate(t);
  broadcastState();
  res.json(templateSummary(t));
});

app.delete('/api/templates/:id', requireAdmin, async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  if (templates.size === 1) return res.status(409).json({ error: "You can't delete your only game. Create another one first." });
  if (t.id === settings.activeTemplateId && gameRunning()) {
    return res.status(409).json({ error: 'This game is being played right now. Go back to the lobby first.' });
  }
  templates.delete(t.id);
  await store.deleteTemplate(t.id);
  if (settings.activeTemplateId === t.id) {
    settings.activeTemplateId = sortedTemplates()[0].id;
    await saveSettings();
  }
  await deleteUnusedPhotos(t.rounds.map(r => r.photoId));
  broadcastState();
  res.json({ ok: true, activeTemplateId: settings.activeTemplateId });
});

app.put('/api/templates/:id/activate', requireAdmin, async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  if (gameRunning() && t.id !== settings.activeTemplateId) {
    return res.status(409).json({ error: 'Finish the current game (or go back to the lobby) before switching games.' });
  }
  settings.activeTemplateId = t.id;
  await saveSettings();
  broadcastState();
  res.json({ ok: true });
});

// ----- rounds within a template -----
app.post('/api/templates/:id/rounds', requireAdmin, upload.single('photo'), async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  if (!req.file) return res.status(400).json({ error: 'Please choose an image file.' });
  const ext = IMAGE_EXT[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Please use a JPG, PNG or WebP photo.' });
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'Please set a valid latitude and longitude.' });

  const photoId = `${crypto.randomBytes(10).toString('hex')}.${ext}`;
  await store.savePhoto(photoId, req.file.buffer, req.file.mimetype);
  photoCache.set(photoId, Promise.resolve({ buffer: req.file.buffer, contentType: req.file.mimetype }));
  const round = { id: newId(), photoId, lat, lng, label: String(req.body.label || '').trim().slice(0, 100) };
  t.rounds.push(round);
  await saveTemplate(t);
  broadcastState();
  res.json(round);
});

app.put('/api/templates/:id/rounds/order', requireAdmin, async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Expected a list of round ids.' });
  const byId = new Map(t.rounds.map(r => [r.id, r]));
  const ordered = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
  for (const r of t.rounds) if (!ordered.includes(r)) ordered.push(r);
  t.rounds = ordered;
  await saveTemplate(t);
  res.json(t.rounds);
});

app.put('/api/templates/:id/rounds/:roundId', requireAdmin, async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  const round = t.rounds.find(r => r.id === req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  const b = req.body || {};
  if (b.lat !== undefined || b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'Invalid latitude/longitude.' });
    round.lat = lat;
    round.lng = lng;
  }
  if (b.label !== undefined) round.label = String(b.label).trim().slice(0, 100);
  await saveTemplate(t);
  res.json(round);
});

app.delete('/api/templates/:id/rounds/:roundId', requireAdmin, async (req, res) => {
  const t = findTemplate(req, res);
  if (!t) return;
  const index = t.rounds.findIndex(r => r.id === req.params.roundId);
  if (index === -1) return res.status(404).json({ error: 'Round not found.' });
  const [removed] = t.rounds.splice(index, 1);
  await saveTemplate(t);
  await deleteUnusedPhotos([removed.photoId]);
  broadcastState();
  res.json({ ok: true });
});

// ----- settings -----
app.get('/api/settings', requireAdmin, (req, res) => res.json(settings));

app.put('/api/settings', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.timerSeconds !== undefined) {
    const n = Math.round(Number(b.timerSeconds));
    if (!(n >= 5 && n <= 600)) return res.status(400).json({ error: 'Timer must be between 5 and 600 seconds.' });
    settings.timerSeconds = n;
  }
  if (b.showPhotoOnDevices !== undefined) settings.showPhotoOnDevices = !!b.showPhotoOnDevices;
  if (b.cartoKey !== undefined) {
    const key = String(b.cartoKey).trim();
    if (key.length > 200 || /[^\w.\-]/.test(key)) return res.status(400).json({ error: 'That map key looks wrong. Paste just the key itself.' });
    settings.cartoKey = key;
  }
  if (b.mapStart !== undefined) {
    const lat = Number(b.mapStart?.lat), lng = wrapLng(Number(b.mapStart?.lng)), zoom = Math.round(Number(b.mapStart?.zoom));
    if (!validLatLng(lat, lng) || !(zoom >= 1 && zoom <= 20)) return res.status(400).json({ error: 'Invalid map view.' });
    settings.mapStart = { lat, lng, zoom };
  }
  await saveSettings();
  broadcastState();
  res.json(settings);
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 15 MB).' : err.message });
});

// ---------- sockets ----------
const server = http.createServer(app);
io = new Server(server);

function detach(socket) {
  const key = socket.data.teamKey;
  socket.data.role = null;
  socket.data.teamKey = null;
  if (!key) return false;
  const set = connections.get(key);
  set?.delete(socket.id);
  if (set && !set.size) connections.delete(key);
  return true;
}

io.on('connection', socket => {
  socket.on('join', (payload, ack) => {
    const role = payload?.role;
    const name = String(payload?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (detach(socket)) broadcastState();

    if (role === 'display') {
      socket.data.role = 'display';
      reply(ack, { ok: true, role });
      return sendState(socket);
    }
    if (!name) return reply(ack, { ok: false, error: 'Please enter a username.' });
    if (isAdmin(name)) {
      socket.data.role = 'admin';
      reply(ack, { ok: true, role: 'admin' });
      return sendState(socket);
    }
    if (role === 'admin') return reply(ack, { ok: false, error: 'Not an admin.' });

    // same name = same team, so a refresh or second phone rejoins the existing team
    const key = name.toLowerCase();
    if (!game.teams[key]) {
      game.teams[key] = { name, color: nextColor(), score: 0 };
      saveGame();
    }
    socket.data.role = 'player';
    socket.data.teamKey = key;
    if (!connections.has(key)) connections.set(key, new Set());
    connections.get(key).add(socket.id);
    reply(ack, { ok: true, role: 'player', team: { key, ...game.teams[key] } });
    broadcastState();
  });

  socket.on('leave', () => { if (detach(socket)) broadcastState(); });
  socket.on('disconnect', () => { if (detach(socket)) broadcastState(); });

  socket.on('guess', (payload, ack) => {
    const key = socket.data.teamKey;
    if (socket.data.role !== 'player' || !game.teams[key]) return reply(ack, { ok: false, error: 'Please rejoin the game.' });
    if (game.phase !== 'round') return reply(ack, { ok: false, error: "Time's up for this round." });
    const lat = Number(payload?.lat), lng = wrapLng(Number(payload?.lng));
    if (!validLatLng(lat, lng)) return reply(ack, { ok: false, error: 'Invalid location.' });
    if (game.guesses[key]?.submitted) return reply(ack, { ok: false, error: 'Your team already submitted.' });
    const final = !!payload.final;
    const firstPin = !game.guesses[key];
    game.guesses[key] = { lat, lng, submitted: final };
    if (final || firstPin) {
      saveGame();
      broadcastState();
    }
    reply(ack, { ok: true });
    if (final) checkAllSubmitted();
  });

  const onAdmin = (event, fn) => socket.on(event, (payload, ack) => {
    if (typeof payload === 'function') [ack, payload] = [payload, {}];
    if (socket.data.role !== 'admin') return reply(ack, { ok: false, error: 'Admin only.' });
    try {
      fn(payload || {});
      reply(ack, { ok: true });
    } catch (e) {
      reply(ack, { ok: false, error: e.message });
    }
  });

  onAdmin('admin:start', () => startGame());
  onAdmin('admin:endRound', () => {
    if (game.phase !== 'round') throw new Error('No round in progress.');
    endRound();
  });
  onAdmin('admin:addTime', () => {
    if (game.phase !== 'round') throw new Error('No round in progress.');
    game.endsAt += 15000;
    scheduleRoundEnd();
    saveGame();
    broadcastState();
  });
  onAdmin('admin:next', () => nextRound());
  onAdmin('admin:reset', p => resetGame(p.keepTeams !== false));
  onAdmin('admin:removeTeam', p => removeTeam(String(p.key)));
});

// ---------- start ----------
(async () => {
  try {
    await loadFromStore();
  } catch (err) {
    console.error(`\n❌ Could not load games from ${store.label}:\n   ${err.message}`);
    if (store.kind === 'firebase') {
      console.error('   Check that Firestore is enabled: Firebase console > Build > Firestore Database > Create database.');
    }
    process.exit(1);
  }

  // resume a game that was interrupted by a server restart
  if (gameRunning() && !currentRound()) game = freshGame(game.teams);
  if (game.phase === 'round') {
    game.endsAt = Date.now() + settings.timerSeconds * 1000;
    scheduleRoundEnd();
  }

  server.listen(PORT, () => {
    console.log('\n📍 GeoGuesser is running!\n');
    console.log(`   This computer:    http://localhost:${PORT}`);
    for (const url of lanUrls()) console.log(`   Same network:     ${url}`);
    console.log(`   Presenter screen: http://localhost:${PORT}/display.html`);
    console.log(`   Games + photos:   ${store.label}`);
    console.log(`\n   Admin username:   ${ADMIN_NAME}\n`);
  });
})();
