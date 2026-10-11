'use strict';

// Set to a currency code such as 'USD', 'GBP', 'EUR', 'AED' or 'INR' to show a symbol with prices.
const CURRENCY = '';

const $ = (selector) => document.querySelector(selector);

const state = {
  properties: [],
  types: [],
  editingId: null,
  deletingId: null,
};

const priceFormatter = new Intl.NumberFormat(
  undefined,
  CURRENCY ? { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 },
);
const formatPrice = (value) => priceFormatter.format(value);
const scoreLevel = (score) => (score >= 8 ? 'high' : score >= 5 ? 'mid' : 'low');

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
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
  $('#login-view').hidden = false;
  $('#password').focus();
}

async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  try {
    state.properties = await api('/api/properties');
    render();
  } catch (err) {
    toast(err.message);
  }
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const type = $('#filter-type').value;
  const sort = $('#sort').value;

  const sorters = {
    newest: (a, b) => b.id - a.id,
    'score-desc': (a, b) => b.match_score - a.match_score || a.price - b.price,
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    name: (a, b) => a.name.localeCompare(b.name),
  };

  const items = state.properties
    .filter((p) => !type || p.type === type)
    .filter((p) => !query || [p.name, p.location, p.agent_number].some((v) => v.toLowerCase().includes(query)))
    .sort(sorters[sort]);

  $('#list').replaceChildren(...items.map(renderCard));

  const hasAny = state.properties.length > 0;
  $('#empty').hidden = items.length > 0;
  $('#empty-title').textContent = hasAny ? 'No matches' : 'No properties yet';
  $('#empty-text').textContent = hasAny
    ? 'Try a different search or property type.'
    : "Add the first place you've viewed to start tracking.";
  $('#empty-add-btn').hidden = hasAny;

  renderStats();
}

function renderCard(p) {
  const card = $('#card-template').content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const level = scoreLevel(p.match_score);

  card.dataset.id = p.id;
  field('type').textContent = p.type;
  field('name').textContent = p.name;
  field('location').textContent = p.location;
  field('price').textContent = formatPrice(p.price);

  const score = field('score');
  score.textContent = `${p.match_score}/10`;
  score.classList.add(`score-${level}`);
  score.title = 'Match score';

  const meter = field('meter');
  meter.style.width = `${p.match_score * 10}%`;
  meter.classList.add(`meter-${level}`);

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

function renderStats() {
  const list = state.properties;
  $('#stat-count').textContent = list.length;
  $('#stat-avg').textContent = list.length
    ? formatPrice(list.reduce((sum, p) => sum + p.price, 0) / list.length)
    : '—';

  const best = list.reduce((top, p) => (!top || p.match_score > top.match_score ? p : top), null);
  $('#stat-best').textContent = best ? `${best.name} · ${best.match_score}/10` : '—';
  $('#stat-best').title = best ? best.name : '';
}

// ---------- Dialogs ----------

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
    form.elements.match_score.value = property.match_score;
    form.elements.agent_number.value = property.agent_number;
  }
  updateScoreOutput();
  $('#property-dialog').showModal();
}

function updateScoreOutput() {
  const value = Number($('#score-input').value);
  const output = $('#score-output');
  output.textContent = `${value} / 10`;
  output.className = `score-output score-${scoreLevel(value)}`;
}

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
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Events ----------

function wireEvents() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $('#login-error').textContent = '';
    setBusy(form, true);
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      await showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#password').select();
    } finally {
      setBusy(form, false);
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  $('#add-btn').addEventListener('click', () => openPropertyDialog(null));
  $('#empty-add-btn').addEventListener('click', () => openPropertyDialog(null));
  $('#change-password-btn').addEventListener('click', () => {
    $('#password-form').reset();
    $('#password-error').textContent = '';
    $('#password-dialog').showModal();
  });

  $('#search').addEventListener('input', render);
  $('#filter-type').addEventListener('change', render);
  $('#sort').addEventListener('change', render);
  $('#score-input').addEventListener('input', updateScoreOutput);

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

  $('#property-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const body = {
      name: data.get('name'),
      location: data.get('location'),
      type: data.get('type'),
      price: data.get('price') === '' ? null : Number(data.get('price')),
      match_score: Number(data.get('match_score')),
      agent_number: data.get('agent_number'),
    };

    $('#property-error').textContent = '';
    setBusy(form, true);
    try {
      if (state.editingId) {
        const updated = await api(`/api/properties/${state.editingId}`, { method: 'PUT', body });
        state.properties = state.properties.map((p) => (p.id === updated.id ? updated : p));
        toast('Changes saved');
      } else {
        const created = await api('/api/properties', { method: 'POST', body });
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

  $('#confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(form, true);
    try {
      await api(`/api/properties/${state.deletingId}`, { method: 'DELETE' });
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
      await api('/api/password', { method: 'POST', body: { current, next } });
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
    const { authenticated, propertyTypes } = await api('/api/session');
    state.types = propertyTypes;
    for (const select of [$('#filter-type'), $('#type-select')]) {
      select.append(...propertyTypes.map((t) => new Option(t, t)));
    }
    if (authenticated) await showApp();
    else showLogin();
  } catch {
    showLogin();
    $('#login-error').textContent = "Can't reach the server. Please refresh.";
  }
}

init();
