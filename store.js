// Where game templates, settings and photos live: Firestore when a Firebase service account is
// configured, otherwise plain files on disk (fine locally, but wiped on Render's free plan).
'use strict';
const fs = require('fs');
const path = require('path');

const CHUNK_BYTES = 900 * 1024; // Firestore documents max out at 1 MiB
const CHUNKS_PER_BATCH = 8; // keeps each write well under Firestore's 10 MiB request limit
const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const contentTypeFor = id => CONTENT_TYPES[id.split('.').pop()] || 'application/octet-stream';
const plain = value => JSON.parse(JSON.stringify(value));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// FIREBASE_SERVICE_ACCOUNT env (JSON or base64), or a firebase-service-account.json file
// in the project folder / a Render secret file.
function findServiceAccount(rootDir) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  for (const file of [path.join(rootDir, 'firebase-service-account.json'), '/etc/secrets/firebase-service-account.json']) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

function createLocalStore(dataDir, uploadDir) {
  const templatesFile = path.join(dataDir, 'templates.json');
  const settingsFile = path.join(dataDir, 'settings.json');
  let templates = readJson(templatesFile, []);
  return {
    kind: 'local',
    label: `local files (${dataDir})`,
    async loadTemplates() { return plain(templates); },
    async saveTemplate(t) {
      templates = templates.filter(x => x.id !== t.id).concat(plain(t));
      writeJson(templatesFile, templates);
    },
    async deleteTemplate(id) {
      templates = templates.filter(x => x.id !== id);
      writeJson(templatesFile, templates);
    },
    async loadSettings() { return readJson(settingsFile, null); },
    async saveSettings(s) { writeJson(settingsFile, s); },
    async savePhoto(id, buffer) { await fs.promises.writeFile(path.join(uploadDir, id), buffer); },
    async loadPhoto(id) {
      try {
        return { buffer: await fs.promises.readFile(path.join(uploadDir, id)), contentType: contentTypeFor(id) };
      } catch {
        return null;
      }
    },
    async deletePhoto(id) { await fs.promises.unlink(path.join(uploadDir, id)).catch(() => {}); },
  };
}

// Photos are stored as photos/{id} (metadata) + photos/{id}/chunks/{0000..} (raw bytes),
// so everything fits in Firestore on the free Spark plan without Cloud Storage.
function createFirebaseStore(serviceAccount) {
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const db = getFirestore(initializeApp({ credential: cert(serviceAccount) }));
  return firestoreStore(db, `Firebase (project ${serviceAccount.project_id})`);
}

function firestoreStore(db, label) {
  const photoDoc = id => db.collection('photos').doc(id);
  const settingsDoc = db.collection('config').doc('settings');

  return {
    kind: 'firebase',
    label,
    async loadTemplates() { return (await db.collection('templates').get()).docs.map(d => d.data()); },
    async saveTemplate(t) { await db.collection('templates').doc(t.id).set(plain(t)); },
    async deleteTemplate(id) { await db.collection('templates').doc(id).delete(); },
    async loadSettings() {
      const doc = await settingsDoc.get();
      return doc.exists ? doc.data() : null;
    },
    async saveSettings(s) { await settingsDoc.set(plain(s)); },
    // live updates, so the laptop and the hosted site see each other's changes
    watch({ onTemplates, onSettings }) {
      const logError = what => err => console.error(`Firestore ${what} listener error:`, err.message);
      db.collection('templates').onSnapshot(snap => onTemplates(snap.docs.map(d => d.data())), logError('templates'));
      settingsDoc.onSnapshot(doc => { if (doc.exists) onSettings(doc.data()); }, logError('settings'));
    },
    async savePhoto(id, buffer, contentType) {
      const count = Math.ceil(buffer.length / CHUNK_BYTES);
      for (let start = 0; start < count; start += CHUNKS_PER_BATCH) {
        const batch = db.batch();
        for (let i = start; i < Math.min(count, start + CHUNKS_PER_BATCH); i++) {
          const chunk = buffer.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
          batch.set(photoDoc(id).collection('chunks').doc(String(i).padStart(4, '0')), { data: chunk });
        }
        await batch.commit();
      }
      // metadata goes last, so a photo only "exists" once all its chunks are written
      await photoDoc(id).set({ contentType, size: buffer.length, chunks: count, createdAt: Date.now() });
    },
    async loadPhoto(id) {
      const meta = await photoDoc(id).get();
      if (!meta.exists) return null;
      const chunks = (await photoDoc(id).collection('chunks').get()).docs.sort((a, b) => a.id.localeCompare(b.id));
      return { buffer: Buffer.concat(chunks.map(d => d.get('data'))), contentType: meta.get('contentType') };
    },
    async deletePhoto(id) {
      const batch = db.batch();
      for (const ref of await photoDoc(id).collection('chunks').listDocuments()) batch.delete(ref);
      batch.delete(photoDoc(id));
      await batch.commit();
    },
  };
}

function createStore({ rootDir, dataDir, uploadDir }) {
  const serviceAccount = findServiceAccount(rootDir);
  return serviceAccount ? createFirebaseStore(serviceAccount) : createLocalStore(dataDir, uploadDir);
}

module.exports = { createStore, firestoreStore, readJson, writeJson };
