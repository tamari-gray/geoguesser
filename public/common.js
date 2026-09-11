/* Shared helpers for the player, admin and presenter pages */
window.GG = (() => {
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const first = w => Array.from(w)[0];
    return (words.length > 1 ? first(words[0]) + first(words[1]) : Array.from(words[0]).slice(0, 2).join('')).toUpperCase();
  }

  function formatDistance(m) {
    if (m == null || !Number.isFinite(m)) return '—';
    if (m < 1000) return `${Math.round(m)} m`;
    if (m < 100000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000).toLocaleString()} km`;
  }

  const medal = i => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;

  // keeps countdowns in sync with the server clock
  function createClock() {
    let offset = 0;
    return { sync(serverNow) { offset = serverNow - Date.now(); }, now: () => Date.now() + offset };
  }
  const msLeft = (state, clock) => (state?.endsAt ? Math.max(0, state.endsAt - clock.now()) : 0);

  function parseCoords(text) {
    const nums = String(text || '').match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    const lat = Number(nums[0]), lng = Number(nums[1]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }

  function createMap(el, options = {}) {
    const map = L.map(el, { worldCopyJump: true, ...options });
    const streets = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Imagery &copy; Esri',
      maxZoom: 19,
    });
    streets.addTo(map);
    L.control.layers({ Map: streets, Satellite: satellite }, null, { position: 'topright' }).addTo(map);
    return map;
  }

  function pinIcon(color, label, big = false) {
    const size = big ? 42 : 32;
    return L.divIcon({
      className: 'gg-pin-wrap',
      html: `<div class="gg-drop"><div class="gg-pin${big ? ' big' : ''}" style="--c:${color}"><span>${escapeHtml(label)}</span></div></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size * 1.207], // tip of the rotated teardrop
      tooltipAnchor: [0, -size * 1.15],
    });
  }
  const answerIcon = () => pinIcon('#111827', '🏁', true);

  const teamChip = (t, extra = '') =>
    `<li class="chip${t.connected === false ? ' offline' : ''}"><span class="dot" style="--c:${t.color}"></span>${escapeHtml(t.name)}${extra}</li>`;

  // Draws every team's guess, the real location and the lines between them.
  function drawResults(map, layer, result, { animate = false, permanentLabels = false } = {}) {
    const gen = (layer._ggGen = (layer._ggGen || 0) + 1);
    const alive = () => layer._ggGen === gen;
    layer.clearLayers();

    const answer = L.latLng(result.answer.lat, result.answer.lng);
    const bounds = L.latLngBounds([answer, answer]);
    for (const g of result.guesses) bounds.extend([g.lat, g.lng]);
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17, animate: false });

    const addGuess = g => {
      const won = result.winners.includes(g.teamKey);
      L.marker([g.lat, g.lng], { icon: pinIcon(g.color, initials(g.name)), zIndexOffset: won ? 500 : 0 })
        .bindTooltip(`<b>${escapeHtml(g.name)}</b> · ${formatDistance(g.distance)}${won ? ' 🏆' : ''}`, {
          permanent: permanentLabels, direction: 'top', className: 'gg-tip',
        })
        .addTo(layer);
    };
    const addAnswer = () => {
      for (const g of result.guesses) {
        L.polyline([[g.lat, g.lng], answer], { color: g.color, weight: 3, opacity: 0.9, dashArray: '6 8' }).addTo(layer);
      }
      L.marker(answer, { icon: answerIcon(), zIndexOffset: 1000 })
        .bindTooltip(`🏁 ${escapeHtml(result.answer.label || 'Actual location')}`, {
          permanent: permanentLabels, direction: 'top', className: 'gg-tip gg-tip-answer',
        })
        .addTo(layer);
    };

    if (!animate) {
      result.guesses.forEach(addGuess);
      addAnswer();
      return 0;
    }
    // drop pins furthest-first so the winner lands last, then reveal the answer
    let t = 500;
    for (const g of result.guesses.slice().reverse()) {
      setTimeout(() => alive() && addGuess(g), t);
      t += 450;
    }
    setTimeout(() => alive() && addAnswer(), t + 300);
    return t + 300;
  }

  // public tunnel link if running via `npm run share`, else a LAN address phones can reach
  async function joinUrl() {
    try {
      const info = await (await fetch('/api/info')).json();
      if (info.publicUrl) return info.publicUrl;
      const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
      return local ? info.lanUrls[0] || location.origin : location.origin;
    } catch {
      return location.origin;
    }
  }

  return {
    escapeHtml, initials, formatDistance, medal, createClock, msLeft, parseCoords,
    createMap, pinIcon, answerIcon, teamChip, drawResults, joinUrl,
  };
})();
