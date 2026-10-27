'use strict';

const fs = require('fs');

const KINDS = new Set(['reg', 'ps', 'cmd', 'raw', 'open', 'action', 'powerplan']);
const HIVES = new Set(['HKLM', 'HKCU', 'HKCR', 'HKU', 'HKCC']);
const REG_TYPES = new Set(['DWord', 'String', 'ExpandString', 'QWord', 'MultiString', 'Binary']);

function validateOps(ops, where) {
  if (!Array.isArray(ops) || !ops.length) throw new Error(`${where}: sin operaciones`);
  for (const op of ops) {
    if (!op || !KINDS.has(op.kind)) throw new Error(`${where}: operacion desconocida ${op && op.kind}`);
    if (op.kind === 'reg') {
      if (!HIVES.has(op.hive)) throw new Error(`${where}: hive invalido`);
      if (typeof op.path !== 'string' || !op.path || /^\s*$/.test(op.path)) throw new Error(`${where}: ruta invalida`);
      if (typeof op.name !== 'string') throw new Error(`${where}: nombre invalido`);
      if (!op.delete && !REG_TYPES.has(op.type)) throw new Error(`${where}: tipo invalido ${op.type}`);
    }
    if ((op.kind === 'ps' || op.kind === 'raw') && typeof op.script !== 'string' && typeof op.command !== 'string') {
      throw new Error(`${where}: script vacio`);
    }
    if (op.kind === 'cmd' && (typeof op.file !== 'string' || !Array.isArray(op.args))) throw new Error(`${where}: comando invalido`);
    if (op.kind === 'open' && typeof op.value !== 'string') throw new Error(`${where}: destino invalido`);
    if (op.kind === 'powerplan' && typeof op.name !== 'string') throw new Error(`${where}: plan invalido`);
  }
}

// Opening a settings page or a browser needs no elevation; scripts, services
// and machine-wide registry do.
function needsAdmin(tweak) {
  return tweak.apply.some((op) =>
    op.kind === 'ps' || op.kind === 'cmd' || op.kind === 'raw' || op.kind === 'powerplan' ||
    (op.kind === 'reg' && op.hive !== 'HKCU'));
}

function isUndoable(tweak) {
  return !!(tweak.revert && tweak.revert.length) || tweak.apply.some((op) => op.kind === 'reg' || op.kind === 'powerplan');
}

// Shortcuts such as "open HDR settings": they run once and leave no state, so
// they must not appear as applied.
function isTransient(tweak) {
  return tweak.apply.every((op) => op.kind === 'open' || op.kind === 'action');
}

function loadCatalog(file) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!catalog || !Array.isArray(catalog.tweaks) || !Array.isArray(catalog.categories)) {
    throw new Error('catalogo con formato invalido');
  }
  const ids = new Set();
  for (const tweak of catalog.tweaks) {
    if (!tweak || typeof tweak.id !== 'string' || !tweak.id) throw new Error('tweak sin id');
    if (ids.has(tweak.id)) throw new Error(`id duplicado: ${tweak.id}`);
    ids.add(tweak.id);
    if (typeof tweak.name !== 'string' || !tweak.name) throw new Error(`${tweak.id}: sin nombre`);
    if (!catalog.categories.includes(tweak.category)) throw new Error(`${tweak.id}: categoria fuera de la lista`);
    if (tweak.premium || tweak.remoteOnly) throw new Error(`${tweak.id}: tweak premium/remoto no permitido`);
    validateOps(tweak.apply, `${tweak.id}.apply`);
    if (tweak.revert != null) validateOps(tweak.revert, `${tweak.id}.revert`);
    tweak.needsAdmin = needsAdmin(tweak);
    tweak.undoable = isUndoable(tweak);
    tweak.transient = isTransient(tweak);
  }
  return catalog;
}

// The renderer only needs metadata; the operation bodies stay in the main process.
function publicCatalog(catalog) {
  return {
    catalogVersion: catalog.catalogVersion,
    categories: catalog.categories,
    tweaks: catalog.tweaks.map(({ apply, revert, ...meta }) => meta)
  };
}

module.exports = { loadCatalog, publicCatalog, validateOps, needsAdmin, isUndoable, isTransient };
