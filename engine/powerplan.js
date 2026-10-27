'use strict';

const { run } = require('./exec');
const { writeValue, deleteValue, queryValue } = require('./registry');

// Hidden "Ultimate Performance" template shipped with Windows.
const ULTIMATE_PERFORMANCE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const THROTTLING = {
  kind: 'reg',
  hive: 'HKLM',
  path: 'SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling',
  name: 'PowerThrottlingOff',
  type: 'DWord',
  value: 1
};

// Basic gaming profile on top of the Ultimate Performance template: no USB
// selective suspend, max WiFi power, no sleep/hibernate while plugged in and
// video playback at performance quality.
const BASIC_SETTINGS = [
  ['2a737441-1930-4402-8d77-b2bebba308a3', '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', 0, 0],
  ['19cae1ab-6e8b-4ba5-9c5b-a1a8f2b2c7d8', '12bbebe6-58d6-4636-95bb-3217ef867c1a', 0, 0],
  ['238c9fa8-0aad-41ed-83f4-97be242c8f20', '29f6c1db-86da-48c5-9fdb-f2b67b1f44da', 0, null],
  ['238c9fa8-0aad-41ed-83f4-97be242c8f20', '9d7815a6-7ee4-497e-8888-515a05f02364', 0, null],
  ['9596fb26-9850-41fd-ac3e-f7c3c00afd4b', '10778347-1370-4ee0-8bbd-33bdacaade49', 1, 1]
];

function plansNamed(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...String(output).matchAll(new RegExp(`([0-9a-fA-F-]{36})\\s+\\(${escaped}\\)`, 'g'))].map((m) => m[1].toLowerCase());
}

async function getActiveScheme() {
  const output = await run('powercfg', ['/getactivescheme'], { timeoutMs: 60000 });
  const match = /([0-9a-fA-F-]{36})/.exec(output);
  if (!match) throw new Error('Windows no informo el plan de energia activo.');
  return match[1].toLowerCase();
}

// Captured before the backup is written and before anything changes, so a
// failed apply still has the data needed to restore the previous state.
async function capturePowerPlanState() {
  const previousPlan = await getActiveScheme();
  const throttling = await queryValue(THROTTLING);
  return {
    previousPlan,
    throttling: throttling.exists
      ? { exists: true, regType: throttling.regType, value: throttling.value }
      : { exists: false, regType: null, value: null }
  };
}

async function ensurePowerPlan(name) {
  const duplicated = await run('powercfg', ['-duplicatescheme', ULTIMATE_PERFORMANCE], { timeoutMs: 60000 });
  const guid = /([0-9a-fA-F-]{36})/.exec(duplicated);
  if (!guid) throw new Error('Windows no quiso crear el plan de energia.');
  const id = guid[1].toLowerCase();

  await run('powercfg', ['-changename', id, name, 'Basado en Maximo rendimiento de Windows, con ajustes de MuraTweaks.'], { timeoutMs: 60000 });
  await run('powercfg', ['-setactive', id], { timeoutMs: 60000 }).catch(() => {});

  const list = await run('powercfg', ['-list'], { timeoutMs: 60000 });
  for (const stale of plansNamed(list, name).filter((other) => other !== id)) {
    await run('powercfg', ['-delete', stale], { timeoutMs: 60000 }).catch(() => {});
  }

  await writeValue(THROTTLING).catch(() => {});
  for (const [sub, setting, ac, dc] of BASIC_SETTINGS) {
    await run('powercfg', ['-setacvalueindex', id, sub, setting, String(ac)], { timeoutMs: 60000 }).catch(() => {});
    if (dc !== null) await run('powercfg', ['-setdcvalueindex', id, sub, setting, String(dc)], { timeoutMs: 60000 }).catch(() => {});
  }
  await run('powercfg', ['-setactive', id], { timeoutMs: 60000 }).catch(() => {});
  return id;
}

async function revertPowerPlan(name, context = null) {
  const list = await run('powercfg', ['-list'], { timeoutMs: 60000 }).catch(() => '');
  const ours = plansNamed(list, name);

  const previousPlan = context && context.previousPlan;
  if (previousPlan && !ours.includes(previousPlan)) {
    await run('powercfg', ['-setactive', previousPlan], { timeoutMs: 60000 }).catch(() => {});
  } else {
    await run('powercfg', ['-setactive', BALANCED], { timeoutMs: 60000 }).catch(() => {});
  }
  for (const guid of ours) {
    await run('powercfg', ['-delete', guid], { timeoutMs: 60000 }).catch(() => {});
  }

  if (context && context.throttling) {
    if (context.throttling.exists) {
      await writeValue({
        kind: 'reg',
        hive: THROTTLING.hive,
        path: THROTTLING.path,
        name: THROTTLING.name,
        type: context.throttling.regType || 'DWord',
        value: context.throttling.value
      }).catch(() => {});
    } else {
      await deleteValue(THROTTLING).catch(() => {});
    }
  } else if (!context) {
    // Backups from older versions did not capture the previous throttling value.
    await deleteValue(THROTTLING).catch(() => {});
  }
}

module.exports = { ensurePowerPlan, revertPowerPlan, capturePowerPlanState, plansNamed };
