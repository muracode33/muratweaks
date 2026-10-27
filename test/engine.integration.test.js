'use strict';

// These tests write to a throwaway HKCU key. They exist because apply/revert
// and the rollback path handle real user data and cannot be covered by pure
// helper tests alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../engine/registry');
const { BackupStore } = require('../engine/backups');
const { TweakEngine } = require('../engine/tweaks');
const { run } = require('../engine/exec');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muratweaks-test-'));
  return { dir, store: new BackupStore(dir) };
}

function engineFor(store, tweak) {
  return new TweakEngine({
    catalog: { categories: ['Test'], tweaks: [tweak] },
    store,
    env: {},
    adminCheck: async () => true
  });
}

async function cleanupKey(key, dir) {
  await run('reg', ['delete', `HKCU\\${key}`, '/f'], { timeoutMs: 15000 }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

const reg = (key, name, value) => ({ kind: 'reg', hive: 'HKCU', path: key, name, type: 'DWord', value });

test('aplica, guarda backup y revierte contra HKCU', async () => {
  const key = `Software\\MuraTweaksTest-${crypto.randomUUID()}`;
  const { dir, store } = tempStore();
  const tweak = {
    id: 'apply-test',
    name: 'Apply test',
    category: 'Test',
    risk: 'seguro',
    needsAdmin: false,
    apply: [reg(key, 'ValueA', 7), { kind: 'reg', hive: 'HKCU', path: key, name: 'ValueB', type: 'String', value: 'hola' }],
    revert: null
  };
  const engine = engineFor(store, tweak);

  try {
    const pending = engine.apply('apply-test');
    await assert.rejects(() => engine.apply('apply-test'), /ya se esta aplicando/);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.entries, 2);

    assert.deepEqual(await registry.queryValue(reg(key, 'ValueA', 0)), { exists: true, regType: 'DWord', value: 7 });
    assert.deepEqual(await registry.queryValue({ kind: 'reg', hive: 'HKCU', path: key, name: 'ValueB', type: 'String', value: '' }), { exists: true, regType: 'String', value: 'hola' });
    assert.equal(store.list()[0].status, 'applied');
    assert.deepEqual(Object.keys(store.getApplied()), ['apply-test']);

    await engine.revert('apply-test');
    assert.equal((await registry.queryValue(reg(key, 'ValueA', 0))).exists, false);
    assert.equal((await registry.queryValue({ kind: 'reg', hive: 'HKCU', path: key, name: 'ValueB', type: 'String', value: '' })).exists, false);
    assert.equal(store.list()[0].status, 'reverted');
    assert.deepEqual(store.getApplied(), {});
  } finally {
    await cleanupKey(key, dir);
  }
});

test('si un paso falla, restaura el registro y deja un backup fallido', async () => {
  const key = `Software\\MuraTweaksTest-${crypto.randomUUID()}`;
  const { dir, store } = tempStore();
  const tweak = {
    id: 'fail-test',
    name: 'Fail test',
    category: 'Test',
    risk: 'seguro',
    needsAdmin: false,
    apply: [reg(key, 'ValueA', 7), { kind: 'cmd', file: 'muratweaks-command-that-does-not-exist', args: [] }],
    revert: null
  };
  const engine = engineFor(store, tweak);

  try {
    await assert.rejects(() => engine.apply('fail-test'), /Fallo "Fail test"/);
    assert.equal((await registry.queryValue(reg(key, 'ValueA', 0))).exists, false);
    assert.deepEqual(store.getApplied(), {});
    const backups = store.list();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].status, 'failed');
    assert.equal(backups[0].entries, 1);
  } finally {
    await cleanupKey(key, dir);
  }
});
