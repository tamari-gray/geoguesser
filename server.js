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

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_NAME = (process.env.ADMIN_NAME || 'kawaiifreak97').trim().toLowerCase();
// STORAGE_DIR lets a cloud host point data + photos at a persistent volume
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || __dirname);
// Render's free tier wipes the disk on every restart, so uploads made on the live site don't last
const EPHEMERAL_STORAGE = !!process.env.RENDER && !process.env.STORAGE_DIR;
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const ROUNDS_FILE = path.join(DATA_DIR, 'rounds.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const GAME_FILE = path.join(DATA_DIR, 'game.json');
const TEAM_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1', '#06b6d4', '#e11d48'];
const MISSING_GUESS_PENALTY = 20_000_000; // metres; only used as a leaderboard tie-breaker
const ROUND_GRACE_MS = 750; // lets last-second submissions arrive

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// First boot on an empty volume: seed it with the rounds bundled in the repo (set up locally, then deployed)
const BUNDLED_ROUNDS = path.join(__dirname, 'data', 'rounds.json');
if (STORAGE_DIR !== __dirname && !fs.existsSync(ROUNDS_FILE) && fs.existsSync(BUNDLED_ROUNDS)) {
  for (const file of ['rounds.json', 'settings.json']) {
    const src = path.join(__dirname, 'data', file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA_DIR, file));
  }
  for (const file of fs.readdirSync(path.join(__dirname, 'uploads'))) {
    fs.copyFileSync(path.join(__dirname, 'uploads', file), path.join(UPLOAD_DIR, file));
  }
  console.log(`Seeded ${STORAGE_DIR} with the bundled rounds.`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

const isAdmin = name => String(name || '').trim().toLowerCase() === ADMIN_NAME;
const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const wrapLng = lng => ((((lng + 180) % 360) + 360) % 360) - 180;
const newId = () => crypto.randomBytes(6).toString('hex');
const photoUrl = round => '/uploads/' + round.file;
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

// ---------- persistent data ----------
let rounds = readJson(ROUNDS_FILE, []); // [{ id, file, lat, lng, label }]
const settings = Object.assign(
  { timerSeconds: 30, showPhotoOnDevices: true, mapStart: { lat: 20, lng: 0, zoom: 2 } },
  readJson(SETTINGS_FILE, {}),
);
const saveRounds = () => writeJson(ROUNDS_FILE, rounds);
const saveSettings = () => writeJson(SETTINGS_FILE, settings);

function freshGame(teams = {}) {
  return { phase: 'lobby', roundIds: [], roundIndex: -1, endsAt: null, guesses: {}, results: [], teams };
}
let game = readJson(GAME_FILE, null) || freshGame();
const saveGame = () => writeJson(GAME_FILE, game);
const currentRound = () => rounds.find(r => r.id === game.roundIds[game.roundIndex]);

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
  const inRound = game.phase === 'round' || game.phase === 'results';
  const round = inRound ? currentRound() : null;
  const state = {
    now: Date.now(),
    phase: game.phase,
    roundNumber: game.roundIndex + 1,
    totalRounds: game.phase === 'lobby' ? rounds.length : game.roundIds.length,
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
    state.roundsCount = rounds.length;
    state.ephemeralStorage = EPHEMERAL_STORAGE;
    state.answer = round ? { lat: round.lat, lng: round.lng, label: round.label } : null;
  }
  return state;
}

let io;
const sendState = socket => socket.emit('state', buildState(socket.data.role, socket.data.teamKey));
function broadcastState() {
  for (const socket of io.sockets.sockets.values()) if (socket.data.role) sendState(socket);
}

// ---------- game flow ----------
let roundTimer = null;
let allInTimer = null;

function startGame() {
  if (!rounds.length) throw new Error('Add at least one round before starting.');
  if (game.phase === 'round' || game.phase === 'results') throw new Error('A game is already running. Reset it first.');
  for (const t of Object.values(game.teams)) t.score = 0;
  game.roundIds = rounds.map(r => r.id);
  game.results = [];
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
  if (game.roundIndex + 1 < game.roundIds.length) return startRound(game.roundIndex + 1);
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
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use('/vendor/exifr', express.static(path.join(__dirname, 'node_modules/exifr/dist')));

function requireAdmin(req, res, next) {
  if (isAdmin(req.get('x-admin'))) return next();
  res.status(403).json({ error: 'Admin only.' });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(10).toString('hex') + (path.extname(file.originalname).toLowerCase() || '.jpg')),
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// PUBLIC_URL optionally overrides the join link shown on the presenter screen
app.get('/api/info', (req, res) => res.json({ publicUrl: process.env.PUBLIC_URL || null, lanUrls: lanUrls() }));

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text) return res.status(400).end();
  res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1 }));
});

app.get('/api/rounds', requireAdmin, (req, res) => res.json(rounds));

app.post('/api/rounds', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image file.' });
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!validLatLng(lat, lng)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Please set a valid latitude and longitude.' });
  }
  const round = { id: newId(), file: req.file.filename, lat, lng, label: String(req.body.label || '').trim().slice(0, 100) };
  rounds.push(round);
  saveRounds();
  broadcastState();
  res.json(round);
});

app.put('/api/rounds/order', requireAdmin, (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Expected a list of round ids.' });
  const byId = new Map(rounds.map(r => [r.id, r]));
  const ordered = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
  for (const r of rounds) if (!ordered.includes(r)) ordered.push(r);
  rounds = ordered;
  saveRounds();
  res.json(rounds);
});

app.put('/api/rounds/:id', requireAdmin, (req, res) => {
  const round = rounds.find(r => r.id === req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  const b = req.body || {};
  if (b.lat !== undefined || b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'Invalid latitude/longitude.' });
    round.lat = lat;
    round.lng = lng;
  }
  if (b.label !== undefined) round.label = String(b.label).trim().slice(0, 100);
  saveRounds();
  res.json(round);
});

app.delete('/api/rounds/:id', requireAdmin, (req, res) => {
  if (game.phase === 'round' || game.phase === 'results') {
    return res.status(409).json({ error: "Can't delete rounds while a game is running. Go back to the lobby first." });
  }
  const index = rounds.findIndex(r => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Round not found.' });
  const [removed] = rounds.splice(index, 1);
  fs.unlink(path.join(UPLOAD_DIR, removed.file), () => {});
  saveRounds();
  broadcastState();
  res.json({ ok: true });
});

app.get('/api/settings', requireAdmin, (req, res) => res.json(settings));

app.put('/api/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.timerSeconds !== undefined) {
    const n = Math.round(Number(b.timerSeconds));
    if (!(n >= 5 && n <= 600)) return res.status(400).json({ error: 'Timer must be between 5 and 600 seconds.' });
    settings.timerSeconds = n;
  }
  if (b.showPhotoOnDevices !== undefined) settings.showPhotoOnDevices = !!b.showPhotoOnDevices;
  if (b.mapStart !== undefined) {
    const lat = Number(b.mapStart?.lat), lng = wrapLng(Number(b.mapStart?.lng)), zoom = Math.round(Number(b.mapStart?.zoom));
    if (!validLatLng(lat, lng) || !(zoom >= 1 && zoom <= 20)) return res.status(400).json({ error: 'Invalid map view.' });
    settings.mapStart = { lat, lng, zoom };
  }
  saveSettings();
  broadcastState();
  res.json(settings);
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 40 MB).' : err.message });
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

// resume a game that was interrupted by a server restart
if ((game.phase === 'round' || game.phase === 'results') && !currentRound()) game = freshGame(game.teams);
if (game.phase === 'round') {
  game.endsAt = Date.now() + settings.timerSeconds * 1000;
  scheduleRoundEnd();
}

server.listen(PORT, () => {
  console.log('\n📍 GeoGuesser is running!\n');
  console.log(`   This computer:    http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`   Same network:     ${url}`);
  console.log(`   Presenter screen: http://localhost:${PORT}/display.html`);
  console.log(`   Storage:          ${STORAGE_DIR}`);
  console.log(`\n   Admin username:   ${ADMIN_NAME}\n`);
});
