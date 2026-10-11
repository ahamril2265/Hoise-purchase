'use strict';

// Set to a currency code such as 'INR', 'AED' or 'USD' to show a symbol with prices.
const CURRENCY = '';
// Indian number system: 12,34,56,789 grouping, with lakh/crore labels for large amounts.
const NUMBER_LOCALE = 'en-IN';

// How much each preference counts towards the match score.
const IMPORTANCE = {
  must: { label: 'Must-have', weight: 3 },
  important: { label: 'Important', weight: 2 },
  nice: { label: 'Nice to have', weight: 1 },
};
// Missing any must-have caps the score here, however well everything else matches.
const MUST_HAVE_CAP = 4;
// How far outside the budget (as a fraction of it) a price can be before budget scores zero.
const BUDGET_TOLERANCE = 0.25;
const FEATURE_SUGGESTIONS = [
  'Parking', 'Garden', 'Balcony', 'Pool', '3+ bedrooms', '2+ bathrooms',
  'Near schools', 'Near transport', 'Move-in ready', 'Quiet street',
];

// Photos are resized in the browser before upload: a large JPEG for viewing and a small one for cards.
const MAX_PHOTOS = 12;
const PHOTO_MAX_SIDE = 1600;
const THUMB_MAX_SIDE = 480;

const TRASH_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';
const PIN_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8l2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.6l-4.3 2.3.9-4.8-3.5-3.3 4.8-.6z"/></svg>';

const $ = (selector) => document.querySelector(selector);

const state = {
  properties: [],
  types: [],
  preferences: emptyPreferences(),
  draftPrefs: null,
  editingId: null,
  deletingId: null,
  // Photo edits in the open property dialog; applied when it's saved.
  photoDraft: [], // { id } for saved photos, { full, thumb, url } for new ones
  photoOriginal: [],
  removedPhotoIds: [],
  photosProcessing: 0,
  viewer: { ids: [], index: 0, name: '' },
  formCoords: null, // { lat, lng } chosen in the open property dialog
};

function emptyPreferences() {
  return {
    types: { items: [], importance: 'important' },
    locations: { items: [], importance: 'important' },
    budget: { min: null, max: null, importance: 'must' },
    features: [],
  };
}

const priceFormatter = new Intl.NumberFormat(
  NUMBER_LOCALE,
  CURRENCY ? { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 },
);
const formatPrice = (value) => priceFormatter.format(value);
const shortNumber = new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 2 });

/** 12500000 → "1.25 crore", 450000 → "4.5 lakh"; '' below one lakh. */
function amountInWords(value) {
  if (!Number.isFinite(value) || value < 1e5) return '';
  return value >= 1e7 ? `${shortNumber.format(value / 1e7)} crore` : `${shortNumber.format(value / 1e5)} lakh`;
}

/** Live "12,34,567 · 12.35 lakh" hint under an amount input. */
function updateAmountHint(input) {
  const hint = document.getElementById(input.dataset.amountHint);
  const value = input.value === '' ? NaN : Number(input.value);
  hint.textContent = Number.isFinite(value) && value > 0
    ? [formatPrice(value), amountInWords(value)].filter(Boolean).join(' · ')
    : '';
}
const scoreLevel = (score) => (score === null ? 'none' : score >= 8 ? 'high' : score >= 5 ? 'mid' : 'low');

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function svg(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content.firstElementChild;
}

// ---------- Photos ----------

const photoUrl = (id, thumb = false) => `/api?route=${encodeURIComponent(`photos/${id}${thumb ? '/thumb' : ''}`)}`;

function toJpeg(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image.'))), 'image/jpeg', quality));
}

async function resizePhoto(file) {
  const bitmap = await createImageBitmap(file);
  try {
    return { full: await toJpeg(bitmap, PHOTO_MAX_SIDE, 0.82), thumb: await toJpeg(bitmap, THUMB_MAX_SIDE, 0.72) };
  } finally {
    bitmap.close();
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Maps ----------
// Leaflet with OpenStreetMap tiles (darkened with a CSS filter in dark mode). Both maps are created lazily.

const maps = { dashboard: null, markers: null, fittedKey: '', picker: null, pin: null };

const hasCoords = (p) => p.latitude !== null && p.latitude !== undefined && p.longitude !== null && p.longitude !== undefined;
const directionsUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}`;

function addTiles(map) {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);
}

function createMap(container) {
  // Scroll-wheel zoom only after the map is clicked, so scrolling the page doesn't get trapped.
  const map = L.map(container, { scrollWheelZoom: false, worldCopyJump: true });
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout blur', () => map.scrollWheelZoom.disable());
  addTiles(map);
  return map;
}

// Score is a number or null, so this markup never contains user text.
const pinIcon = (score, extraClass = '') => L.divIcon({
  className: `pin pin-${scoreLevel(score)} ${extraClass}`,
  html: `<span><b>${score ?? (extraClass ? '' : '–')}</b></span>`,
  iconSize: [34, 34],
  iconAnchor: [17, 34],
  popupAnchor: [0, -32],
});

function popupContent({ p, score }) {
  const box = el('div', { className: 'map-popup' });
  if (p.photo_ids?.length) box.append(el('img', { className: 'map-popup-img', src: photoUrl(p.photo_ids[0], true), alt: '' }));
  box.append(
    el('strong', { textContent: p.name }),
    el('span', { className: 'map-popup-location', textContent: p.location }),
    el('span', {
      className: 'map-popup-meta',
      textContent: [formatPrice(p.price), amountInWords(p.price) && `(${amountInWords(p.price)})`,
        '·', score === null ? 'no score' : `${score}/10`].filter(Boolean).join(' '),
    }),
  );

  const actions = el('div', { className: 'map-popup-actions' });
  const action = (label, onClick) => {
    const button = el('button', { type: 'button', className: 'link-btn', textContent: label });
    button.addEventListener('click', onClick);
    actions.append(button);
  };
  if (p.photo_ids?.length) action('Photos', () => openViewer(p));
  action('Edit', () => openPropertyDialog(p));
  action('Show card', () => {
    const card = document.querySelector(`.card[data-id="${p.id}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.classList.add('flash');
    setTimeout(() => card?.classList.remove('flash'), 1600);
  });
  actions.append(el('a', { className: 'link-btn', href: directionsUrl(p), target: '_blank', rel: 'noopener noreferrer', textContent: 'Directions' }));
  box.append(actions);
  return box;
}

function renderMap(items) {
  if (!window.L) return; // map library failed to load; the rest of the app still works
  maps.dashboard ??= createMap('map');
  maps.markers ??= L.layerGroup().addTo(maps.dashboard);
  maps.markers.clearLayers();

  const located = items.filter(({ p }) => hasCoords(p));
  for (const entry of located) {
    L.marker([entry.p.latitude, entry.p.longitude], { icon: pinIcon(entry.score), title: entry.p.name, riseOnHover: true })
      .bindPopup(() => popupContent(entry), { minWidth: 200, maxWidth: 240 })
      .addTo(maps.markers);
  }

  // Re-fit the view only when the set of pins changes, not on every keystroke.
  const key = located.map(({ p }) => `${p.id}:${p.latitude},${p.longitude}`).join('|');
  maps.dashboard.invalidateSize();
  if (key !== maps.fittedKey) {
    maps.fittedKey = key;
    if (located.length === 1) maps.dashboard.setView([located[0].p.latitude, located[0].p.longitude], 14);
    else if (located.length > 1) {
      maps.dashboard.fitBounds(located.map(({ p }) => [p.latitude, p.longitude]), { padding: [40, 40], maxZoom: 15 });
    } else maps.dashboard.setView([20, 0], 2);
  }

  const missing = items.length - located.length;
  const note = $('#map-note');
  if (!items.length) note.textContent = '';
  else if (!located.length) note.textContent = 'No pins yet. Edit a property and add its map location to see it here.';
  else note.textContent = missing
    ? `${located.length} of ${items.length} on the map. ${missing} ${missing === 1 ? 'has' : 'have'} no location yet.`
    : `All ${located.length} on the map.`;
}

/** Google Maps links and "lat, lng" text → { lat, lng }; null if empty; undefined if unreadable. */
function parseCoordinates(text) {
  const s = text.trim();
  if (!s) return null;
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const match = s.match(new RegExp(`!3d${num}!4d${num}`)) // exact pin in a Google Maps place link
    || s.match(new RegExp(`[?&](?:q|query|ll|destination)=${num},\\s*${num}`))
    || s.match(new RegExp(`@${num},\\s*${num}`)) // map centre in a Google Maps link
    || s.match(new RegExp(`^\\(?\\s*${num}\\s*[,;\\s]\\s*${num}\\s*\\)?$`));
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

const coordsStatus = (message, isError = false) => {
  const status = $('#coords-status');
  status.textContent = message;
  status.classList.toggle('form-error', isError);
};

function setFormCoords(coords, { pan = false } = {}) {
  state.formCoords = coords && { lat: Number(coords.lat.toFixed(6)), lng: Number(coords.lng.toFixed(6)) };
  $('#coords-input').value = state.formCoords ? `${state.formCoords.lat}, ${state.formCoords.lng}` : '';
  $('#coords-clear').hidden = !state.formCoords;
  if (!maps.picker) return;

  if (!state.formCoords) {
    maps.pin?.remove();
    maps.pin = null;
    return;
  }
  const latLng = [state.formCoords.lat, state.formCoords.lng];
  if (!maps.pin) {
    maps.pin = L.marker(latLng, { icon: pinIcon(null, 'pin-edit'), draggable: true, autoPan: true }).addTo(maps.picker);
    maps.pin.on('dragend', () => {
      const { lat, lng } = maps.pin.getLatLng();
      setFormCoords({ lat, lng });
      coordsStatus('Pin moved.');
    });
  } else {
    maps.pin.setLatLng(latLng);
  }
  if (pan) maps.picker.setView(latLng, Math.max(maps.picker.getZoom() || 0, 16));
}

function openPicker() {
  if (!window.L) return;
  if (!maps.picker) {
    maps.picker = createMap('picker-map');
    maps.picker.on('click', (e) => {
      setFormCoords(e.latlng);
      coordsStatus('Pin placed. Drag it to adjust.');
    });
  }
  maps.picker.invalidateSize();
  setFormCoords(state.formCoords);

  // Start on this property, else on the other properties, else the whole world.
  const others = state.properties.filter(hasCoords).map((p) => [p.latitude, p.longitude]);
  if (state.formCoords) maps.picker.setView([state.formCoords.lat, state.formCoords.lng], 16);
  else if (others.length) maps.picker.fitBounds(others, { padding: [30, 30], maxZoom: 14 });
  else maps.picker.setView([20, 0], 2);
}

async function findFromLocation() {
  const text = $('#property-form').elements.location.value.trim();
  if (!text) return coordsStatus('Type the location above first.', true);
  coordsStatus('Searching…');
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!res.ok) throw new Error();
    const [hit] = await res.json();
    if (!hit) return coordsStatus("Couldn't find that location. Try adding the city, or click the map.", true);
    setFormCoords({ lat: Number(hit.lat), lng: Number(hit.lon) }, { pan: true });
    coordsStatus(`Found “${hit.display_name}”. Check the pin and drag it onto the exact house.`);
  } catch {
    coordsStatus('Location search is unavailable right now. Click the map to drop a pin instead.', true);
  }
}

function useCurrentLocation() {
  coordsStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setFormCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }, { pan: true });
      coordsStatus(`Using your current location (accurate to about ${Math.round(pos.coords.accuracy)} m).`);
    },
    (err) => coordsStatus(err.code === err.PERMISSION_DENIED
      ? 'Location access was blocked. Allow it in your browser settings, or click the map.'
      : "Couldn't get your location. Click the map to drop a pin instead.", true),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ---------- Match scoring ----------

function hasPreferences(prefs) {
  return prefs.types.items.length > 0
    || prefs.locations.items.length > 0
    || prefs.budget.min !== null
    || prefs.budget.max !== null
    || prefs.features.length > 0;
}

function budgetCheck(price, { min, max }) {
  if (max !== null && price > max) {
    const over = max > 0 ? (price - max) / max : Infinity;
    return {
      value: Math.max(0, 1 - over / BUDGET_TOLERANCE),
      detail: max > 0 ? `${Math.max(1, Math.round(over * 100))}% over budget` : 'Over budget',
    };
  }
  if (min !== null && price < min) {
    const under = (min - price) / min;
    return {
      value: Math.max(0, 1 - under / BUDGET_TOLERANCE),
      detail: `${Math.max(1, Math.round(under * 100))}% below your minimum`,
    };
  }
  return { value: 1, detail: 'Within budget' };
}

/**
 * Score a property 1–10 against the preferences.
 * Each preference is a check worth 0–1, weighted by importance; missing a must-have caps the score.
 */
function scoreProperty(property, prefs) {
  const checks = [];
  const add = (label, detail, importance, value) => checks.push({ label, detail, importance, value });

  if (prefs.types.items.length) {
    const ok = prefs.types.items.includes(property.type);
    add('Type', ok ? property.type : `${property.type || 'Unknown'} isn't a preferred type`, prefs.types.importance, ok ? 1 : 0);
  }

  if (prefs.locations.items.length) {
    const location = property.location.toLowerCase();
    const area = prefs.locations.items.find((a) => location.includes(a.toLowerCase()));
    add('Location', area ? `In ${area}` : 'Not in a preferred area', prefs.locations.importance, area ? 1 : 0);
  }

  if (prefs.budget.min !== null || prefs.budget.max !== null) {
    const { value, detail } = budgetCheck(property.price, prefs.budget);
    add('Budget', detail, prefs.budget.importance, value);
  }

  const owned = new Set((property.features || []).map((f) => f.toLowerCase()));
  for (const feature of prefs.features) {
    const has = owned.has(feature.name.toLowerCase());
    add(feature.name, has ? 'Has it' : 'Missing', feature.importance, has ? 1 : 0);
  }

  if (!checks.length) return { auto: null, checks, missedMust: false };

  let total = 0;
  let earned = 0;
  for (const check of checks) {
    const weight = IMPORTANCE[check.importance].weight;
    total += weight;
    earned += weight * check.value;
  }
  let auto = Math.round(1 + 9 * (earned / total));
  const missedMust = checks.some((c) => c.importance === 'must' && c.value === 0);
  if (missedMust) auto = Math.min(auto, MUST_HAVE_CAP);
  return { auto, checks, missedMust };
}

// ---------- API ----------

// All requests go to the single /api function, with the route in the query string (e.g. /api?route=properties/3).
async function api(route, { method = 'GET', body } = {}) {
  const res = await fetch(`/api?route=${encodeURIComponent(route)}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && route !== 'login') {
    showLogin();
    throw new Error(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- Views ----------

function showLogin() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  state.properties = [];
  $('#app-view').hidden = true;
  $('#register-view').hidden = true;
  $('#login-view').hidden = false;
  $('#password').focus();
}

function showRegister() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = true;
  $('#register-view').hidden = false;
  $('#register-password').focus();
}

async function showApp() {
  $('#login-view').hidden = true;
  $('#register-view').hidden = true;
  $('#app-view').hidden = false;
  try {
    const [properties, preferences] = await Promise.all([api('properties'), api('preferences')]);
    state.properties = properties;
    state.preferences = preferences;
    render();
  } catch (err) {
    toast(err.message);
  }
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const type = $('#filter-type').value;
  const sort = $('#sort').value;

  const scored = state.properties.map((p) => {
    const result = scoreProperty(p, state.preferences);
    return { p, result, score: p.score_override ?? result.auto };
  });

  const sorters = {
    newest: (a, b) => b.p.id - a.p.id,
    'score-desc': (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.p.price - b.p.price,
    'price-asc': (a, b) => a.p.price - b.p.price,
    'price-desc': (a, b) => b.p.price - a.p.price,
    name: (a, b) => a.p.name.localeCompare(b.p.name),
  };

  const items = scored
    .filter(({ p }) => !type || p.type === type)
    .filter(({ p }) => !query
      || [p.name, p.location, p.agent_number, p.description || ''].some((v) => v.toLowerCase().includes(query)))
    .sort(sorters[sort]);

  $('#list').replaceChildren(...items.map(renderCard));
  renderMap(items);
  // Offer "Show more" only on descriptions that are actually cut off.
  requestAnimationFrame(() => {
    for (const desc of document.querySelectorAll('.card-desc')) {
      desc.nextElementSibling.hidden = desc.scrollHeight <= desc.clientHeight + 1;
    }
  });

  const hasAny = state.properties.length > 0;
  $('#empty').hidden = items.length > 0;
  $('#empty-title').textContent = hasAny ? 'No matches' : 'No properties yet';
  $('#empty-text').textContent = hasAny
    ? 'Try a different search or property type.'
    : "Add the first place you've viewed to start tracking.";
  $('#empty-add-btn').hidden = hasAny;
  $('#prefs-banner').hidden = hasPreferences(state.preferences);

  renderStats(scored);
}

function renderCard({ p, result, score }) {
  const card = $('#card-template').content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const level = scoreLevel(score);

  card.dataset.id = p.id;

  const photoIds = p.photo_ids || [];
  const photoButton = card.querySelector('[data-action="photos"]');
  if (photoIds.length) {
    const cover = field('cover');
    cover.src = photoUrl(photoIds[0], true);
    cover.alt = `${p.name}, cover photo`;
    cover.hidden = false;
    field('no-photo').hidden = true;
    photoButton.setAttribute('aria-label', `View ${photoIds.length} photo${photoIds.length === 1 ? '' : 's'} of ${p.name}`);
    if (photoIds.length > 1) {
      field('photo-count').textContent = `${photoIds.length} photos`;
      field('photo-count').hidden = false;
    }
  } else {
    photoButton.classList.add('card-photo-none');
    photoButton.setAttribute('aria-label', `Add photos of ${p.name}`);
  }

  if (p.description) {
    field('description').textContent = p.description;
    field('desc-wrap').hidden = false;
  }

  field('type').textContent = p.type;
  field('name').textContent = p.name;
  field('location').textContent = p.location;
  field('price').textContent = formatPrice(p.price);
  field('price-words').textContent = amountInWords(p.price);

  const badge = field('score');
  badge.textContent = score === null ? '–/10' : `${score}/10`;
  badge.classList.add(`score-${level}`);
  if (p.score_override !== null) {
    badge.prepend(svg(PIN_SVG));
    badge.title = result.auto === null ? 'Your own score' : `Your own score (calculated: ${result.auto}/10)`;
  } else {
    badge.title = score === null ? 'Set your preferences to get a score' : 'Calculated match score';
  }

  const meter = field('meter');
  meter.style.width = `${(score ?? 0) * 10}%`;
  meter.classList.add(`meter-${level}`);

  if (result.checks.length) renderWhy(field('why'), p, result);

  const agent = field('agent');
  if (p.agent_number) {
    agent.href = `tel:${p.agent_number.replace(/[^\d+]/g, '')}`;
    agent.querySelector('span').textContent = p.agent_number;
    agent.title = 'Call agent';
  } else {
    agent.removeAttribute('href');
    agent.classList.add('agent-empty');
    agent.querySelector('span').textContent = 'No agent number';
  }

  if (hasCoords(p)) {
    const directions = field('directions');
    directions.href = directionsUrl(p);
    directions.title = 'Directions in Google Maps';
    directions.setAttribute('aria-label', `Directions to ${p.name}`);
    directions.hidden = false;
  }

  card.querySelector('[data-action="edit"]').setAttribute('aria-label', `Edit ${p.name}`);
  card.querySelector('[data-action="delete"]').setAttribute('aria-label', `Remove ${p.name}`);
  return card;
}

function renderWhy(details, property, result) {
  const icons = { yes: '✓', no: '✕', partial: '~' };
  const list = el('ul', { className: 'why-list' }, ...result.checks.map((check) => {
    const status = check.value === 1 ? 'yes' : check.value === 0 ? 'no' : 'partial';
    return el('li', { className: `why-${status}` },
      el('span', { className: 'why-icon', textContent: icons[status] }),
      el('span', { className: 'why-text' },
        el('span', { className: 'why-label', textContent: check.label }),
        el('span', { className: 'why-detail', textContent: check.detail })),
      el('span', { className: `why-importance imp-${check.importance}`, textContent: IMPORTANCE[check.importance].label }));
  }));

  const body = details.querySelector('.why-body');
  body.append(list);
  if (result.missedMust) {
    body.append(el('p', { className: 'why-note', textContent: `Capped at ${MUST_HAVE_CAP}/10 because a must-have is missing.` }));
  }
  if (property.score_override !== null) {
    body.append(el('p', {
      className: 'why-note',
      textContent: `You set this score yourself. Calculated score: ${result.auto}/10.`,
    }));
  }
  details.hidden = false;
}

function renderStats(scored) {
  const list = state.properties;
  $('#stat-count').textContent = list.length;
  const average = list.length ? list.reduce((sum, p) => sum + p.price, 0) / list.length : null;
  $('#stat-avg').textContent = average === null ? '—' : formatPrice(average);
  $('#stat-avg-words').textContent = average === null ? '' : amountInWords(average);

  const best = scored
    .filter((s) => s.score !== null)
    .reduce((top, s) => (!top || s.score > top.score ? s : top), null);
  $('#stat-best').textContent = best ? `${best.p.name} · ${best.score}/10` : '—';
  $('#stat-best').title = best ? best.p.name : '';
}

// ---------- Property dialog ----------

function openPropertyDialog(property) {
  const form = $('#property-form');
  form.reset();
  $('#property-error').textContent = '';
  state.editingId = property ? property.id : null;
  $('#property-dialog-title').textContent = property ? 'Edit property' : 'Add property';
  $('#property-submit').textContent = property ? 'Save changes' : 'Save property';

  if (property) {
    form.elements.name.value = property.name;
    form.elements.location.value = property.location;
    form.elements.type.value = property.type;
    form.elements.price.value = property.price;
    form.elements.agent_number.value = property.agent_number;
    form.elements.description.value = property.description || '';
  }
  renderFeatureChecks(property?.features ?? []);

  state.photoOriginal = [...(property?.photo_ids ?? [])];
  state.photoDraft = state.photoOriginal.map((id) => ({ id, url: photoUrl(id, true) }));
  state.removedPhotoIds = [];
  $('#photo-status').textContent = '';
  renderPhotoList();

  const override = property?.score_override ?? null;
  $('#override-toggle').checked = override !== null;
  $('#score-input').value = override ?? 5;
  updateScoreUI();

  state.formCoords = property && hasCoords(property) ? { lat: property.latitude, lng: property.longitude } : null;
  $('#coords-input').value = '';
  coordsStatus('Click the map to drop a pin, then drag it to adjust.');
  updateAmountHint(form.elements.price);
  $('#property-dialog').showModal();
  openPicker(); // after showModal, so the map can measure its size
  if (!window.L) setFormCoords(state.formCoords);
}

function renderFeatureChecks(selected) {
  const selectedKeys = new Set(selected.map((f) => f.toLowerCase()));
  const names = state.preferences.features.map((f) => f.name);
  // Keep features this property already has, even if they've since been removed from preferences.
  const known = new Set(names.map((n) => n.toLowerCase()));
  for (const feature of selected) if (!known.has(feature.toLowerCase())) names.push(feature);

  $('#feature-checks').replaceChildren(...names.map((name) => el('label', { className: 'check-chip' },
    el('input', { type: 'checkbox', name: 'features', value: name, checked: selectedKeys.has(name.toLowerCase()) }),
    el('span', { textContent: name }))));
  $('#features-empty').hidden = names.length > 0;
}

function readPropertyForm() {
  const data = new FormData($('#property-form'));
  return {
    name: data.get('name'),
    location: data.get('location'),
    type: data.get('type') ?? '',
    price: data.get('price') === '' ? null : Number(data.get('price')),
    agent_number: data.get('agent_number'),
    features: data.getAll('features'),
    score_override: $('#override-toggle').checked ? Number($('#score-input').value) : null,
    description: data.get('description'),
    latitude: state.formCoords?.lat ?? null,
    longitude: state.formCoords?.lng ?? null,
  };
}

function renderPhotoList() {
  const draft = state.photoDraft;
  $('#photo-list').replaceChildren(...draft.map((item, i) => {
    const tile = el('div', { className: 'photo-tile' }, el('img', { src: item.url, alt: `Photo ${i + 1}` }));

    if (i === 0) {
      tile.append(el('span', { className: 'cover-badge', textContent: 'Cover' }));
    } else {
      const makeCover = el('button', { type: 'button', className: 'tile-btn tile-cover', title: 'Make cover' }, svg(PIN_SVG));
      makeCover.setAttribute('aria-label', `Make photo ${i + 1} the cover`);
      makeCover.addEventListener('click', () => { draft.unshift(...draft.splice(i, 1)); renderPhotoList(); });
      tile.append(makeCover);
    }

    const remove = el('button', { type: 'button', className: 'tile-btn tile-remove', textContent: '×', title: 'Remove' });
    remove.setAttribute('aria-label', `Remove photo ${i + 1}`);
    remove.addEventListener('click', () => {
      const [removed] = draft.splice(i, 1);
      if (removed.id) state.removedPhotoIds.push(removed.id); // already on the server
      if (removed.full) URL.revokeObjectURL(removed.url); // a local preview
      renderPhotoList();
    });
    tile.append(remove);
    return tile;
  }));
  $('#photo-add').hidden = draft.length >= MAX_PHOTOS;
}

async function addPhotos(files) {
  const draft = state.photoDraft;
  const room = MAX_PHOTOS - draft.length;
  const accepted = files.slice(0, room);
  const failed = [];
  const status = $('#photo-status');

  state.photosProcessing += 1;
  status.textContent = `Preparing ${accepted.length} photo${accepted.length === 1 ? '' : 's'}…`;
  for (const file of accepted) {
    try {
      const { full, thumb } = await resizePhoto(file);
      if (state.photoDraft !== draft) return; // dialog was closed or reopened meanwhile
      draft.push({ full, thumb, url: URL.createObjectURL(thumb) });
      renderPhotoList();
    } catch {
      failed.push(file.name);
    }
  }
  state.photosProcessing -= 1;

  const notes = [];
  if (files.length > room) notes.push(`Only ${MAX_PHOTOS} photos per property, so ${files.length - room} weren't added.`);
  if (failed.length) notes.push(`Couldn't read ${failed.join(', ')}. Try JPEG or PNG.`);
  status.textContent = notes.join(' ');
}

const photosChanged = () =>
  state.removedPhotoIds.length > 0
  || state.photoDraft.some((item) => item.full && !item.id)
  || state.photoDraft.map((item) => item.id).join() !== state.photoOriginal.join();

/** Apply the dialog's photo edits to a saved property. Returns the final photo ids, cover first. */
async function syncPhotos(propertyId) {
  while (state.removedPhotoIds.length) {
    await api(`photos/${state.removedPhotoIds[0]}`, { method: 'DELETE' }).catch((err) => {
      if (!/not found/i.test(err.message)) throw err;
    });
    state.removedPhotoIds.shift();
  }

  const pending = state.photoDraft.filter((item) => !item.id);
  for (const [n, item] of pending.entries()) {
    $('#photo-status').textContent = `Uploading photo ${n + 1} of ${pending.length}…`;
    const body = { data: await blobToBase64(item.full), thumb: await blobToBase64(item.thumb) };
    item.id = (await api(`properties/${propertyId}/photos`, { method: 'POST', body })).id;
  }

  const order = state.photoDraft.map((item) => item.id);
  await api(`properties/${propertyId}/photos`, { method: 'PUT', body: { order } });
  state.photoOriginal = order;
  $('#photo-status').textContent = '';
  return order;
}

function upsertProperty(property) {
  const exists = state.properties.some((p) => p.id === property.id);
  state.properties = exists
    ? state.properties.map((p) => (p.id === property.id ? property : p))
    : [property, ...state.properties];
}

// ---------- Photo viewer ----------

function openViewer(property, index = 0) {
  state.viewer = { ids: property.photo_ids, index, name: property.name };
  showViewerPhoto();
  $('#viewer-dialog').showModal();
}

function showViewerPhoto() {
  const { ids, index, name } = state.viewer;
  const img = $('#viewer-img');
  img.src = photoUrl(ids[index]);
  img.alt = `${name}, photo ${index + 1} of ${ids.length}`;
  $('#viewer-caption').textContent = ids.length > 1 ? `${name} · ${index + 1} / ${ids.length}` : name;
  $('#viewer-prev').hidden = ids.length < 2;
  $('#viewer-next').hidden = ids.length < 2;
}

function stepViewer(delta) {
  const viewer = state.viewer;
  viewer.index = (viewer.index + delta + viewer.ids.length) % viewer.ids.length;
  showViewerPhoto();
}

function updateScoreUI() {
  const body = readPropertyForm();
  const { auto } = scoreProperty({ ...body, price: body.price ?? NaN }, state.preferences);
  const autoOutput = $('#auto-score');
  autoOutput.textContent = auto === null ? 'Set preferences first' : `${auto} / 10`;
  autoOutput.className = `score-output score-${scoreLevel(auto)}`;

  const overriding = $('#override-toggle').checked;
  $('#override-field').hidden = !overriding;
  const own = Number($('#score-input').value);
  const ownOutput = $('#score-output');
  ownOutput.textContent = `${own} / 10`;
  ownOutput.className = `score-output score-${scoreLevel(own)}`;
}

// ---------- Preferences dialog ----------

function importanceSelect(value, label) {
  const select = el('select', { className: 'importance' },
    ...Object.entries(IMPORTANCE).map(([key, { label: text }]) => new Option(text, key)));
  select.value = value;
  select.setAttribute('aria-label', label);
  return select;
}

function openPrefsDialog() {
  const prefs = structuredClone(state.preferences);
  state.draftPrefs = prefs;
  const form = $('#prefs-form');
  form.reset();
  $('#prefs-error').textContent = '';
  form.elements['types-importance'].value = prefs.types.importance;
  form.elements['locations-importance'].value = prefs.locations.importance;
  form.elements['budget-importance'].value = prefs.budget.importance;
  form.elements['budget-min'].value = prefs.budget.min ?? '';
  form.elements['budget-max'].value = prefs.budget.max ?? '';
  updateAmountHint(form.elements['budget-min']);
  updateAmountHint(form.elements['budget-max']);

  $('#pref-types').replaceChildren(...state.types.map((type) => el('label', { className: 'check-chip' },
    el('input', { type: 'checkbox', value: type, checked: prefs.types.items.includes(type) }),
    el('span', { textContent: type }))));
  renderPrefLocations();
  renderPrefFeatures();
  $('#prefs-dialog').showModal();
}

function renderPrefLocations() {
  const items = state.draftPrefs.locations.items;
  $('#pref-locations').replaceChildren(...items.map((area, i) => {
    const remove = el('button', { type: 'button', className: 'tag-remove', textContent: '×' });
    remove.setAttribute('aria-label', `Remove ${area}`);
    remove.addEventListener('click', () => { items.splice(i, 1); renderPrefLocations(); });
    return el('span', { className: 'tag' }, el('span', { textContent: area }), remove);
  }));
}

function addLocation() {
  const input = $('#location-input');
  const area = input.value.trim();
  const items = state.draftPrefs.locations.items;
  if (area && !items.some((a) => a.toLowerCase() === area.toLowerCase())) items.push(area);
  input.value = '';
  renderPrefLocations();
}

function renderPrefFeatures() {
  const features = state.draftPrefs.features;
  $('#pref-features').replaceChildren(...features.map((feature, i) => {
    const select = importanceSelect(feature.importance, `Importance of ${feature.name}`);
    select.addEventListener('change', () => { feature.importance = select.value; });
    const remove = el('button', { type: 'button', className: 'icon-btn icon-btn-danger' }, svg(TRASH_SVG));
    remove.setAttribute('aria-label', `Remove ${feature.name}`);
    remove.addEventListener('click', () => { features.splice(i, 1); renderPrefFeatures(); });
    return el('div', { className: 'feature-row' }, el('span', { className: 'feature-name', textContent: feature.name }), select, remove);
  }));
  $('#features-none').hidden = features.length > 0;

  const existing = new Set(features.map((f) => f.name.toLowerCase()));
  $('#feature-suggestions').replaceChildren(...FEATURE_SUGGESTIONS
    .filter((name) => !existing.has(name.toLowerCase()))
    .map((name) => {
      const button = el('button', { type: 'button', className: 'suggestion', textContent: `+ ${name}` });
      button.addEventListener('click', () => addFeature(name));
      return button;
    }));
}

function addFeature(name) {
  const trimmed = name.trim();
  const features = state.draftPrefs.features;
  if (trimmed && !features.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) {
    features.push({ name: trimmed, importance: 'important' });
  }
  renderPrefFeatures();
}

// ---------- Other dialogs ----------

function openConfirmDialog(property) {
  state.deletingId = property.id;
  $('#confirm-text').textContent = `“${property.name}” will be removed from your list. This can't be undone.`;
  $('#confirm-error').textContent = '';
  $('#confirm-dialog').showModal();
}

function setBusy(form, busy) {
  form.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

// ---------- Events ----------

function wireEvents() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $('#login-error').textContent = '';
    setBusy(form, true);
    try {
      await api('login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      await showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#password').select();
    } finally {
      setBusy(form, false);
    }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { password, confirm } = Object.fromEntries(new FormData(form));
    $('#register-error').textContent = '';
    if (password !== confirm) {
      $('#register-error').textContent = "Passwords don't match.";
      return;
    }
    setBusy(form, true);
    try {
      await api('register', { method: 'POST', body: { password } });
      form.reset();
      await showApp();
      toast('Password created');
    } catch (err) {
      $('#register-error').textContent = err.message;
      // Someone already set a password (e.g. from another tab): switch to sign-in.
      if (/already been set/.test(err.message)) setTimeout(showLogin, 1500);
    } finally {
      setBusy(form, false);
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  $('#add-btn').addEventListener('click', () => openPropertyDialog(null));
  $('#empty-add-btn').addEventListener('click', () => openPropertyDialog(null));
  $('#prefs-btn').addEventListener('click', openPrefsDialog);
  $('#banner-prefs-btn').addEventListener('click', openPrefsDialog);
  $('#change-password-btn').addEventListener('click', () => {
    $('#password-form').reset();
    $('#password-error').textContent = '';
    $('#password-dialog').showModal();
  });

  $('#search').addEventListener('input', render);
  $('#filter-type').addEventListener('change', render);
  $('#sort').addEventListener('change', render);

  $('#list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const id = Number(button.closest('.card').dataset.id);
    const property = state.properties.find((p) => p.id === id);
    if (!property) return;
    const action = button.dataset.action;
    if (action === 'edit') openPropertyDialog(property);
    if (action === 'delete') openConfirmDialog(property);
    if (action === 'photos') {
      if (property.photo_ids?.length) openViewer(property);
      else openPropertyDialog(property);
    }
    if (action === 'toggle-desc') {
      const expanded = button.previousElementSibling.classList.toggle('expanded');
      button.textContent = expanded ? 'Show less' : 'Show more';
    }
  });

  // Photo viewer
  $('#viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('#viewer-next').addEventListener('click', () => stepViewer(1));
  $('#viewer-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });
  $('#viewer-dialog .viewer-stage').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('#viewer-dialog').close();
  });
  // Swipe left/right on touch screens.
  let touchStartX = null;
  $('#viewer-dialog').addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
  $('#viewer-dialog').addEventListener('touchend', (e) => {
    if (touchStartX === null || state.viewer.ids.length < 2) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
  });

  // Amounts: show Indian grouping and lakh/crore while typing.
  document.querySelectorAll('[data-amount-hint]').forEach((input) =>
    input.addEventListener('input', () => updateAmountHint(input)));

  // Property map location
  const coordsInput = $('#coords-input');
  const applyTypedCoords = () => {
    const parsed = parseCoordinates(coordsInput.value);
    if (parsed === undefined) {
      coordsStatus(/goo\.gl|maps\.app/.test(coordsInput.value)
        ? "Short links can't be read. Open the link, then copy the full address-bar URL or the coordinates."
        : 'Couldn\'t read that. Use "25.2048, 55.2708" or a full Google Maps link.', true);
      return;
    }
    setFormCoords(parsed, { pan: true });
    coordsStatus(parsed ? 'Pin placed. Drag it to adjust.' : 'Pin removed.');
  };
  coordsInput.addEventListener('change', applyTypedCoords);
  coordsInput.addEventListener('paste', () => setTimeout(applyTypedCoords));
  coordsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyTypedCoords(); }
  });
  $('#coords-find').addEventListener('click', findFromLocation);
  $('#coords-here').hidden = !('geolocation' in navigator);
  $('#coords-here').addEventListener('click', useCurrentLocation);
  $('#coords-clear').addEventListener('click', () => {
    setFormCoords(null);
    coordsStatus('Pin removed.');
  });

  // Property photos
  $('#photo-add').addEventListener('click', () => $('#photo-input').click());
  $('#photo-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) addPhotos(files);
  });
  $('#property-dialog').addEventListener('close', () => {
    for (const item of state.photoDraft) if (item.full) URL.revokeObjectURL(item.url);
  });

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => btn.closest('dialog').close()));

  // Close a dialog when clicking the backdrop.
  document.querySelectorAll('dialog').forEach((dialog) =>
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }));

  // Property form: keep the score preview live as fields change.
  $('#property-form').addEventListener('input', updateScoreUI);
  $('#property-form').addEventListener('change', updateScoreUI);

  $('#property-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = readPropertyForm();
    $('#property-error').textContent = '';
    if (state.photosProcessing) {
      $('#property-error').textContent = 'Wait a moment for your photos to finish preparing.';
      return;
    }
    const isNew = !state.editingId;
    const submit = $('#property-submit');
    const submitLabel = submit.textContent;
    setBusy(form, true);
    try {
      const saved = isNew
        ? await api('properties', { method: 'POST', body })
        : await api(`properties/${state.editingId}`, { method: 'PUT', body });
      upsertProperty(saved);
      // From here on this dialog edits the saved property, so a retry after a failed upload can't create a duplicate.
      state.editingId = saved.id;

      if (photosChanged()) {
        submit.textContent = 'Uploading photos…';
        upsertProperty({ ...saved, photo_ids: await syncPhotos(saved.id) });
      }

      $('#property-dialog').close();
      render();
      toast(isNew ? 'Property added' : 'Changes saved');
    } catch (err) {
      $('#property-error').textContent = err.message;
      render();
    } finally {
      submit.textContent = submitLabel;
      setBusy(form, false);
    }
  });

  // Preferences form
  $('#location-add').addEventListener('click', addLocation);
  $('#location-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLocation(); }
  });
  $('#feature-add').addEventListener('click', () => { addFeature($('#feature-input').value); $('#feature-input').value = ''; });
  $('#feature-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFeature(e.target.value); e.target.value = ''; }
  });

  $('#prefs-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    // Include anything typed but not yet added.
    if ($('#location-input').value.trim()) addLocation();
    if ($('#feature-input').value.trim()) { addFeature($('#feature-input').value); $('#feature-input').value = ''; }

    const draft = state.draftPrefs;
    const money = (value) => (value === '' ? null : Number(value));
    const body = {
      types: {
        items: [...$('#pref-types').querySelectorAll('input:checked')].map((input) => input.value),
        importance: form.elements['types-importance'].value,
      },
      locations: { items: draft.locations.items, importance: form.elements['locations-importance'].value },
      budget: {
        min: money(form.elements['budget-min'].value),
        max: money(form.elements['budget-max'].value),
        importance: form.elements['budget-importance'].value,
      },
      features: draft.features,
    };

    $('#prefs-error').textContent = '';
    setBusy(form, true);
    try {
      state.preferences = await api('preferences', { method: 'PUT', body });
      $('#prefs-dialog').close();
      render();
      toast('Preferences saved, scores updated');
    } catch (err) {
      $('#prefs-error').textContent = err.message;
    } finally {
      setBusy(form, false);
    }
  });

  $('#confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(form, true);
    try {
      await api(`properties/${state.deletingId}`, { method: 'DELETE' });
      state.properties = state.properties.filter((p) => p.id !== state.deletingId);
      $('#confirm-dialog').close();
      render();
      toast('Property removed');
    } catch (err) {
      $('#confirm-error').textContent = err.message;
    } finally {
      setBusy(form, false);
    }
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { current, next, confirm } = Object.fromEntries(new FormData(form));
    if (next !== confirm) {
      $('#password-error').textContent = "New passwords don't match.";
      return;
    }
    setBusy(form, true);
    try {
      await api('password', { method: 'POST', body: { current, next } });
      $('#password-dialog').close();
      toast('Password updated');
    } catch (err) {
      $('#password-error').textContent = err.message;
    } finally {
      setBusy(form, false);
    }
  });
}

// ---------- Start ----------

async function init() {
  wireEvents();
  try {
    const { authenticated, registered, propertyTypes } = await api('session');
    state.types = propertyTypes;
    for (const select of [$('#filter-type'), $('#type-select')]) {
      select.append(...propertyTypes.map((t) => new Option(t, t)));
    }
    if (authenticated) await showApp();
    else if (!registered) showRegister();
    else showLogin();
  } catch (err) {
    showLogin();
    // fetch() throws a TypeError on network failure; anything else is a message from the server.
    $('#login-error').textContent = err instanceof TypeError ? "Can't reach the server. Please refresh." : err.message;
  }
}

init();
