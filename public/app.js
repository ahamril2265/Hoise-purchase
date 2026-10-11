'use strict';

// Set to a currency code such as 'USD', 'GBP', 'EUR', 'AED' or 'INR' to show a symbol with prices.
const CURRENCY = '';

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
  undefined,
  CURRENCY ? { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 },
);
const formatPrice = (value) => priceFormatter.format(value);
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
    .filter(({ p }) => !query || [p.name, p.location, p.agent_number].some((v) => v.toLowerCase().includes(query)))
    .sort(sorters[sort]);

  $('#list').replaceChildren(...items.map(renderCard));

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
  field('type').textContent = p.type;
  field('name').textContent = p.name;
  field('location').textContent = p.location;
  field('price').textContent = formatPrice(p.price);

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
  $('#stat-avg').textContent = list.length
    ? formatPrice(list.reduce((sum, p) => sum + p.price, 0) / list.length)
    : '—';

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
  }
  renderFeatureChecks(property?.features ?? []);

  const override = property?.score_override ?? null;
  $('#override-toggle').checked = override !== null;
  $('#score-input').value = override ?? 5;
  updateScoreUI();
  $('#property-dialog').showModal();
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
  };
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
    if (button.dataset.action === 'edit') openPropertyDialog(property);
    if (button.dataset.action === 'delete') openConfirmDialog(property);
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
    setBusy(form, true);
    try {
      if (state.editingId) {
        const updated = await api(`properties/${state.editingId}`, { method: 'PUT', body });
        state.properties = state.properties.map((p) => (p.id === updated.id ? updated : p));
        toast('Changes saved');
      } else {
        const created = await api('properties', { method: 'POST', body });
        state.properties.unshift(created);
        toast('Property added');
      }
      $('#property-dialog').close();
      render();
    } catch (err) {
      $('#property-error').textContent = err.message;
    } finally {
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
