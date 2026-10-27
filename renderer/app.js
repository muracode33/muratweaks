'use strict';

const state = {
  catalog: null,
  applied: new Map(),
  backups: [],
  admin: false,
  version: '',
  category: '__all__',
  search: '',
  risk: 'all',
  view: 'optimize'
};

const RISK_LABEL = { seguro: 'Seguro', moderado: 'Moderado', riesgoso: 'Riesgoso' };
const CATEGORY_ICONS = {
  'Rendimiento FPS': 'bolt',
  'Gráfica (GPU)': 'gpu',
  'Red y WiFi': 'wifi',
  'CPU y memoria': 'cpu',
  'Energía': 'battery',
  'Windows': 'windows',
  'Personalizar Windows': 'sliders',
  'Segundo plano': 'layers',
  'Privacidad': 'shield',
  'Almacenamiento': 'disk',
  'Periféricos': 'mouse',
  'BIOS y drivers': 'circuit',
  'Priorizar juegos': 'gamepad'
};
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const empty = $('empty');
const count = $('count');
const nav = $('nav');
const searchInput = $('search');
const riskFilter = $('risk-filter');
const appliedList = $('applied-list');
const backupList = $('backup-list');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('es');
}

function toast(message, type = 'info', ttl = 8000) {
  const node = el('div', `toast${type === 'error' ? ' toast-error' : type === 'info' ? ' toast-info' : ''}`, message);
  $('toasts').append(node);
  setTimeout(() => node.remove(), ttl);
}

let modalResolve = null;
let lastFocus = null;

function confirmModal({ title, text, warning, confirmLabel = 'Continuar', danger = false }) {
  return new Promise((resolve) => {
    lastFocus = document.activeElement;
    modalResolve = resolve;
    $('modal-title').textContent = title;
    const body = $('modal-body');
    body.replaceChildren();
    if (text) body.append(el('p', null, text));
    if (warning) body.append(el('p', 'modal-warning', warning));
    const confirm = $('modal-confirm');
    confirm.textContent = confirmLabel;
    confirm.className = `btn${danger ? ' btn-danger' : ''}`;
    $('modal').hidden = false;
    confirm.focus();
  });
}

function closeModal(value) {
  $('modal').hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(value);
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  lastFocus = null;
}

$('modal-cancel').addEventListener('click', () => closeModal(false));
$('modal-confirm').addEventListener('click', () => closeModal(true));
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal(false);
});
document.addEventListener('keydown', (event) => {
  if ($('modal').hidden) return;
  if (event.key === 'Escape') {
    closeModal(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = [...$('modal').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function setView(view) {
  state.view = view;
  $('view-optimize').hidden = view !== 'optimize';
  $('view-backups').hidden = view !== 'backups';
  if (view === 'backups') refreshBackupsView();
  renderNav();
}

function renderNav() {
  nav.replaceChildren();
  if (!state.catalog) return;

  const allActive = state.view === 'optimize' && state.category === '__all__';
  const all = el('button', `nav-item${allActive ? ' active' : ''}`);
  all.append(icon('grid', 'icon nav-icon'), el('span', 'nav-text', 'Todos los ajustes'), el('span', 'nav-count', String(state.catalog.tweaks.length)));
  if (allActive) all.setAttribute('aria-current', 'page');
  all.addEventListener('click', () => {
    state.category = '__all__';
    setView('optimize');
    renderGrid({ animate: true });
    focusActiveNav();
  });
  nav.append(all);

  nav.append(el('div', 'nav-label', 'Optimizar'));
  state.catalog.categories.forEach((category) => {
    const total = state.catalog.tweaks.filter((tweak) => tweak.category === category).length;
    const active = state.view === 'optimize' && state.category === category;
    const item = el('button', `nav-item${active ? ' active' : ''}`);
    item.append(
      icon(CATEGORY_ICONS[category] || 'grid', 'icon nav-icon'),
      el('span', 'nav-text', category),
      el('span', 'nav-count', String(total))
    );
    if (active) item.setAttribute('aria-current', 'page');
    item.addEventListener('click', () => {
      state.category = category;
      state.search = '';
      searchInput.value = '';
      setView('optimize');
      renderGrid({ animate: true });
      focusActiveNav();
    });
    nav.append(item);
  });

  nav.append(el('div', 'nav-label', 'Sistema'));
  const backups = el('button', `nav-item${state.view === 'backups' ? ' active' : ''}`);
  backups.append(icon('archive', 'icon nav-icon'), el('span', 'nav-text', 'Backups'), el('span', 'nav-count', String(state.backups.length)));
  if (state.view === 'backups') backups.setAttribute('aria-current', 'page');
  backups.addEventListener('click', () => {
    setView('backups');
    focusActiveNav();
  });
  nav.append(backups);
}

function focusActiveNav() {
  nav.querySelector('[aria-current="page"]')?.focus();
}

function visibleTweaks() {
  const term = normalize(state.search);
  return state.catalog.tweaks.filter((tweak) => {
    if (state.category !== '__all__' && tweak.category !== state.category) return false;
    if (state.risk !== 'all' && tweak.risk !== state.risk) return false;
    if (!term) return true;
    return normalize(`${tweak.name} ${tweak.description} ${tweak.category} ${tweak.subcategory || ''}`).includes(term);
  });
}

function renderGrid({ animate = false, focusTweakId = null } = {}) {
  if (state.view !== 'optimize' || !state.catalog) return;
  const list = visibleTweaks();

  const title = state.category === '__all__' ? 'Optimizar' : state.category;
  $('view-title').textContent = title;
  $('view-subtitle').textContent = state.category === '__all__'
    ? 'Ajustes de rendimiento, latencia, GPU, red y privacidad.'
    : 'Ajustes de esta categoria. Cada cambio guarda su estado anterior.';
  count.textContent = `// ${list.length} ${list.length === 1 ? 'ajuste' : 'ajustes'}`;
  empty.hidden = list.length > 0;

  grid.classList.toggle('grid-animate', animate);
  grid.replaceChildren(...list.map(renderCard));

  if (focusTweakId) {
    const card = grid.querySelector(`[data-id="${focusTweakId}"]`);
    const target = card ? (card.querySelector('.card-actions button:not(:disabled)') || card) : null;
    if (target) target.focus();
  }
}

function renderCard(tweak, index) {
  const applied = state.applied.has(tweak.id);
  const card = el('article', `card${applied ? ' applied' : ''}`);
  card.dataset.id = tweak.id;
  card.tabIndex = -1;
  card.style.setProperty('--i', String(Math.min(index, 12)));

  const top = el('div', 'card-top');
  top.append(el('h3', null, tweak.name));
  top.append(el('span', `risk risk-${tweak.risk || 'seguro'}`, RISK_LABEL[tweak.risk] || 'Seguro'));
  card.append(top);

  if (tweak.description) card.append(el('p', 'desc', tweak.description));

  const meta = el('div', 'meta');
  if (state.category === '__all__') meta.append(el('span', 'tag', tweak.category));
  if (tweak.subcategory) meta.append(el('span', 'tag', tweak.subcategory));
  if (tweak.warning) meta.append(el('span', 'tag tag-warn', 'Con aviso'));
  if (tweak.laptopWarning) meta.append(el('span', 'tag tag-warn', 'Portatiles'));
  if (!tweak.transient && tweak.undoable === false) meta.append(el('span', 'tag tag-warn', 'Sin deshacer'));
  card.append(meta);

  const actions = el('div', 'card-actions');
  const button = el('button', `btn btn-sm${applied ? ' btn-danger' : ' btn-quiet'}`);
  if (applied && tweak.undoable === false) {
    button.textContent = 'Aplicado (sin deshacer)';
    button.disabled = true;
  } else {
    button.textContent = applied
      ? 'Revertir'
      : tweak.transient
        ? (tweak.buttonLabel || 'Abrir')
        : (tweak.actionOnly && tweak.buttonLabel ? tweak.buttonLabel : 'Aplicar');
    button.addEventListener('click', () => (applied ? revertTweak(tweak, button) : applyTweak(tweak, button)));
  }
  actions.append(button);
  card.append(actions);

  return card;
}

async function applyTweak(tweak, button) {
  if (!state.admin && tweak.needsAdmin) {
    $('admin-banner').hidden = false;
    toast('Necesitas permisos de administrador para este ajuste. Usa "Reiniciar como administrador".', 'error');
    return;
  }

  const needsConfirm = tweak.risk === 'riesgoso' || tweak.warning || tweak.confirmMessage || tweak.undoable === false;
  if (needsConfirm) {
    const warning = [
      tweak.warning || tweak.laptopWarning,
      tweak.undoable === false ? 'Este ajuste no se puede deshacer automaticamente.' : null
    ].filter(Boolean).join('\n\n');
    const ok = await confirmModal({
      title: `Aplicar: ${tweak.name}`,
      text: tweak.confirmMessage || tweak.description,
      warning,
      confirmLabel: 'Aplicar',
      danger: tweak.risk === 'riesgoso'
    });
    if (!ok) return;
  }

  button.disabled = true;
  button.textContent = 'Aplicando...';
  const result = await window.mura.applyTweak(tweak.id);
  button.disabled = false;

  if (!result.ok) {
    toast(result.error || 'No se pudo aplicar el ajuste.', 'error', 14000);
    if (result.code === 'admin') $('admin-banner').hidden = false;
    renderGrid({ focusTweakId: tweak.id });
    return;
  }
  if (result.transient) {
    toast('Listo.', 'info', 3000);
    renderGrid({ focusTweakId: tweak.id });
    return;
  }
  toast(`"${tweak.name}" aplicado.`, 'info');
  await refreshState();
  renderNav();
  renderGrid({ focusTweakId: tweak.id });
}

async function revertTweak(tweak, button) {
  const ok = await confirmModal({
    title: `Revertir: ${tweak.name}`,
    text: 'Se restauran los valores guardados antes de aplicar el ajuste.',
    confirmLabel: 'Revertir',
    danger: true
  });
  if (!ok) return;

  button.disabled = true;
  button.textContent = 'Revirtiendo...';
  const result = await window.mura.revertTweak(tweak.id);
  button.disabled = false;

  if (!result.ok) {
    toast(result.error || 'No se pudo revertir el ajuste.', 'error', 14000);
    if (result.code === 'admin') $('admin-banner').hidden = false;
    renderGrid({ focusTweakId: tweak.id });
    return;
  }
  toast(`"${tweak.name}" revertido.`, 'info');
  await refreshState();
  renderNav();
  renderGrid({ focusTweakId: tweak.id });
}

async function refreshState() {
  const [applied, backups] = await Promise.all([window.mura.listApplied(), window.mura.listBackups()]);
  if (applied.ok) state.applied = new Map(applied.applied.map((item) => [item.id, item]));
  if (backups.ok) state.backups = backups.backups;
}

function renderBackupsView() {
  appliedList.replaceChildren();
  const applied = [...state.applied.values()];
  $('undo-all').disabled = applied.length === 0;

  if (!applied.length) {
    appliedList.append(el('p', 'list-empty', 'No hay cambios aplicados.'));
  } else {
    for (const item of applied) {
      const row = el('div', 'list-row');
      const grow = el('div', 'grow');
      grow.append(el('strong', null, item.name), el('small', null, `Aplicado el ${formatDate(item.at)}`));
      if (item.undoable === false) {
        row.append(grow, el('span', 'status status-reverted', 'sin deshacer'));
      } else {
        const button = el('button', 'btn btn-ghost btn-sm', 'Revertir');
        button.addEventListener('click', async () => {
          button.disabled = true;
          const result = await window.mura.revertTweak(item.id);
          if (!result.ok) toast(result.error || 'No se pudo revertir.', 'error', 14000);
          else toast(`"${item.name}" revertido.`, 'info');
          await refreshState();
          renderNav();
          renderBackupsView();
          renderGrid();
        });
        row.append(grow, button);
      }
      appliedList.append(row);
    }
  }

  backupList.replaceChildren();
  if (!state.backups.length) {
    backupList.append(el('p', 'list-empty', 'Todavia no hay backups guardados.'));
    return;
  }
  for (const backup of state.backups) {
    const row = el('div', 'list-row');
    const grow = el('div', 'grow');
    grow.append(
      el('strong', null, backup.tweakName),
      el('small', null, `${formatDate(backup.createdAt)} · ${backup.entries} ${backup.entries === 1 ? 'valor' : 'valores'} guardados`)
    );
    const statusLabels = { applied: 'aplicado', reverted: 'revertido', failed: 'fallido', pending: 'pendiente' };
    const statusClass = backup.status === 'applied' ? 'status-applied' : backup.status === 'failed' ? 'status-failed' : 'status-reverted';
    const status = el('span', `status ${statusClass}`, statusLabels[backup.status] || backup.status);
    const restorable = backup.restorable ?? backup.entries > 0;
    const button = el('button', 'btn btn-ghost btn-sm', 'Restaurar valores');
    button.disabled = !restorable;
    if (!restorable) button.title = 'Este backup no guardo valores de registro.';
    button.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Restaurar valores guardados',
        text: `Se devuelven los valores de registro anteriores a "${backup.tweakName}".`,
        confirmLabel: 'Restaurar'
      });
      if (!ok) return;
      const result = await window.mura.restoreBackup(backup.id);
      if (!result.ok) toast(result.error || 'No se pudo restaurar el backup.', 'error', 14000);
      else toast('Valores restaurados.', 'info');
      await refreshState();
      renderNav();
      renderBackupsView();
      renderGrid();
    });
    row.append(grow, status, button);
    backupList.append(row);
  }
}

async function refreshBackupsView() {
  await refreshState();
  renderBackupsView();
}

$('undo-all').addEventListener('click', async () => {
  const ok = await confirmModal({
    title: 'Deshacer todos los cambios',
    text: 'Se revierten todos los ajustes aplicados desde MuraTweaks. Los que tengan backup guardado vuelven a sus valores anteriores.',
    confirmLabel: 'Deshacer todo',
    danger: true
  });
  if (!ok) return;

  const button = $('undo-all');
  button.disabled = true;
  button.textContent = 'Deshaciendo...';
  try {
    const result = await window.mura.undoAll();
    if (!result.ok) {
      toast(result.error || 'No se pudo deshacer.', 'error', 14000);
      return;
    }
    const failed = result.results.filter((item) => !item.ok && !item.skipped);
    const skipped = result.results.filter((item) => item.skipped);
    const done = result.results.length - failed.length - skipped.length;
    const parts = [`Revertidos ${done}.`];
    if (skipped.length) parts.push(`Sin reversion automatica: ${skipped.map((item) => item.name).join(', ')}`);
    if (failed.length) parts.push(`Fallaron: ${failed.map((item) => `${item.name} (${item.error})`).join(', ')}`);
    toast(parts.join('\n'), failed.length ? 'error' : 'info', 16000);
    await refreshState();
    renderNav();
    renderBackupsView();
    renderGrid();
  } catch (error) {
    toast(error.message || 'No se pudo deshacer.', 'error', 14000);
  } finally {
    button.textContent = 'Deshacer todo';
    button.disabled = state.applied.size === 0;
  }
});

$('create-restore').addEventListener('click', async () => {
  const ok = await confirmModal({
    title: 'Crear punto de restauracion',
    text: 'Windows puede tardar varios minutos y limita cuantos puntos se crean por dia. Necesita permisos de administrador.',
    confirmLabel: 'Crear'
  });
  if (!ok) return;
  const button = $('create-restore');
  button.disabled = true;
  button.textContent = 'Creando punto de restauracion...';
  const result = await window.mura.createRestorePoint();
  button.disabled = false;
  button.textContent = 'Crear punto de restauracion';
  if (!result.ok) toast(result.error || 'No se pudo crear el punto de restauracion.', 'error', 14000);
  else toast('Punto de restauracion creado.', 'info');
});

$('open-restore').addEventListener('click', () => window.mura.openSystemRestore());

$('elevate-btn').addEventListener('click', () => window.mura.relaunchElevated());
$('win-min').addEventListener('click', () => window.mura.minimize());
$('win-max').addEventListener('click', () => window.mura.toggleMaximize());
$('win-close').addEventListener('click', () => window.mura.close());

searchInput.addEventListener('input', () => {
  state.search = searchInput.value;
  renderGrid();
});
riskFilter.addEventListener('change', () => {
  state.risk = riskFilter.value;
  renderGrid();
});

async function boot() {
  const result = await window.mura.boot();
  if (!result.ok) {
    grid.replaceChildren(el('p', 'list-empty', `No se pudo iniciar: ${result.error}`));
    return;
  }
  state.catalog = result.catalog;
  state.applied = new Map(result.applied.map((item) => [item.id, item]));
  state.backups = result.backups;
  state.admin = result.admin;
  state.version = result.version;

  $('version').textContent = `MuraTweaks v${result.version}`;
  const pill = $('admin-pill');
  $('admin-pill-text').textContent = result.admin ? 'Administrador' : 'Sin permisos';
  pill.className = `pill ${result.admin ? 'pill-ok' : 'pill-warn'}`;
  $('admin-banner').hidden = result.admin;

  renderNav();
  renderGrid({ animate: true });
}

boot().catch((error) => {
  grid.replaceChildren(el('p', 'list-empty', `No se pudo iniciar: ${error.message}`));
});
