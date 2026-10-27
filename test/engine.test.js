'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../engine/registry');
const { loadCatalog, publicCatalog, validateOps } = require('../engine/catalog');
const { BackupStore } = require('../engine/backups');
const { expandOps } = require('../engine/tweaks');
const { plansNamed } = require('../engine/powerplan');

test('restorePlan borra lo que no existia y recrea lo que existia, en orden inverso', () => {
  const entries = [
    {
      index: 0,
      op: { kind: 'reg', hive: 'HKCU', path: 'Software\\A', name: 'X' },
      before: { kind: 'reg', hive: 'HKCU', path: 'Software\\A', name: 'X', exists: true, regType: 'DWord', value: 7 }
    },
    {
      index: 1,
      op: { kind: 'reg', hive: 'HKCU', path: 'Software\\B', name: 'Y' },
      before: { kind: 'reg', hive: 'HKCU', path: 'Software\\B', name: 'Y', exists: false, regType: null, value: null }
    }
  ];
  const plan = registry.restorePlan(entries);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { kind: 'reg', hive: 'HKCU', path: 'Software\\B', name: 'Y', delete: true });
  assert.deepEqual(plan[1], { kind: 'reg', hive: 'HKCU', path: 'Software\\A', name: 'X', type: 'DWord', value: 7 });
});

test('el catalogo es valido y no tiene funciones premium ni telemetria de la app original', () => {
  const catalog = loadCatalog(path.join(__dirname, '..', 'data', 'catalog.json'));
  assert.ok(catalog.tweaks.length >= 300, `esperaba >=300 tweaks, hay ${catalog.tweaks.length}`);
  assert.equal(catalog.categories.length, 13);
  for (const tweak of catalog.tweaks) {
    assert.ok(!tweak.premium && !tweak.remoteOnly, `${tweak.id} deberia ser gratis`);
    assert.ok(tweak.apply.length > 0, `${tweak.id} sin operaciones`);
    assert.ok(['seguro', 'moderado', 'riesgoso'].includes(tweak.risk), `${tweak.id} sin riesgo`);
    assert.equal(typeof tweak.needsAdmin, 'boolean');
    assert.equal(typeof tweak.undoable, 'boolean');
    assert.equal(typeof tweak.transient, 'boolean');
  }
  const shortcut = catalog.tweaks.find((tweak) => tweak.id === 'download-drivers-nvidia');
  assert.equal(shortcut.transient, true);
  assert.equal(shortcut.needsAdmin, false);
  const hkcu = catalog.tweaks.find((tweak) => tweak.id === 'disable-notifications');
  assert.equal(hkcu.needsAdmin, false);
  const scripted = catalog.tweaks.find((tweak) => tweak.apply.some((op) => op.kind === 'ps'));
  assert.equal(scripted.needsAdmin, true);
  const json = JSON.stringify(catalog);
  assert.equal(json.includes('api.ceitotweaks.com'), false);
  assert.equal(json.includes('Ceito'), false);
  const pub = publicCatalog(catalog);
  assert.equal(JSON.stringify(pub).includes('"script"'), false, 'el renderer no debe recibir scripts');
});

test('validateOps rechaza operaciones con forma invalida', () => {
  assert.throws(() => validateOps([], 'x'), /sin operaciones/);
  assert.throws(() => validateOps([{ kind: 'reg', hive: 'NOPE', path: 'A', name: 'B', type: 'DWord', value: 1 }], 'x'), /hive/);
  assert.throws(() => validateOps([{ kind: 'reg', hive: 'HKCU', path: 'A', name: 'B', type: 'Nope', value: 1 }], 'x'), /tipo/);
  assert.throws(() => validateOps([{ kind: 'cmd', file: 'x' }], 'x'), /comando/);
});

test('BackupStore guarda, marca y lista backups con estado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muratweaks-test-'));
  try {
    const store = new BackupStore(dir);
    const record = store.save({
      tweakId: 'demo',
      tweakName: 'Demo',
      entries: [{ index: 0, op: { kind: 'reg', hive: 'HKCU', path: 'A', name: 'B' }, before: { exists: false } }]
    });
    assert.equal(store.get(record.id).tweakId, 'demo');
    store.markApplied('demo', record.id);
    assert.equal(store.getApplied().demo.backupId, record.id);

    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].entries, 1);
    assert.equal(listed[0].status, 'applied');

    assert.equal(store.updateStatus(record.id, 'reverted'), true);
    assert.equal(store.list()[0].status, 'reverted');
    store.markReverted('demo');
    assert.deepEqual(store.getApplied(), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expandOps aplana reg-import y plansNamed detecta planes por nombre', () => {
  const ops = expandOps([
    { kind: 'reg-import', ops: [{ kind: 'reg', hive: 'HKCU', path: 'A', name: 'B', type: 'DWord', value: 0 }] },
    { kind: 'ps', script: 'exit 0' }
  ]);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].kind, 'reg');

  const list = 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)\r\nPower Scheme GUID: 11111111-2222-3333-4444-555555555555  (Mura Rendimiento)\r\n';
  assert.deepEqual(plansNamed(list, 'Mura Rendimiento'), ['11111111-2222-3333-4444-555555555555']);
  assert.deepEqual(plansNamed(list, 'Otro'), []);
});
