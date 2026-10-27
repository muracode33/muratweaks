// Records the observable apply/revert operations of CeitoTweaks' free tweak
// modules by calling them with a fake registry/command helper. Nothing is
// executed: child_process and electron are mocked, runCommand only records.
//
// Usage: node tools/record-tweaks.js <extracted-app-dir> <out.json>
'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(process.argv[2] || '_extracted/ceitotweaks');
const OUT = path.resolve(process.argv[3] || '_analysis/catalog.raw.json');

const electronMock = {
  app: {
    isPackaged: false,
    getPath: () => path.join(process.env.APPDATA || '', 'MuraTweaks'),
    getName: () => 'MuraTweaks',
    getVersion: () => '0.0.0',
    quit: () => {},
    relaunch: () => {},
    on: () => {}
  },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {}
};

const cpMock = {
  exec: () => { throw new Error('child_process.exec blocked during recording'); },
  execFile: () => { throw new Error('child_process.execFile blocked during recording'); },
  spawn: () => { throw new Error('child_process.spawn blocked during recording'); }
};

// The app resolves bundled resources relative to its own install dir; point the
// recorder at the installed copy so .reg imports can be parsed.
const REAL_RESOURCES = 'C:\\Program Files\\CeitoTweaks\\resources\\resources';
const pathsMock = { resourcesRoot: () => REAL_RESOURCES };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  if (request === 'child_process' || request === 'node:child_process') return cpMock;
  if (request === './paths' && parent && /[\\/]tweaks[\\/]/.test(parent.filename)) return pathsMock;
  return origLoad.call(this, request, parent, isMain);
};

// --- .reg parser -----------------------------------------------------------

function parseRegFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8'))
    .replace(/^﻿/, '');
  const ops = [];
  let key = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('Windows Registry Editor')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) { key = section[1]; continue; }
    if (!key) continue;
    const kv = /^("(?:[^"\\]|\\.)*"|@)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const name = kv[1] === '@' ? '' : kv[1].slice(1, -1).replace(/\\(.)/g, '$1');
    const rhs = kv[2];
    let type = 'String';
    let value = '';
    const dword = /^dword:([0-9a-fA-F]{1,8})$/.exec(rhs);
    const qword = /^hex\(b\):([0-9a-fA-F,]+)$/.exec(rhs);
    const hexz = /^hex\([27]\):([0-9a-fA-F,]+)$/.exec(rhs);
    const hex1 = /^hex(?:\([0-9a-fA-F]+\))?:([0-9a-fA-F,]+)$/i.exec(rhs);
    if (dword) { type = 'DWord'; value = parseInt(dword[1], 16); }
    else if (qword) { type = 'QWord'; value = qword[1]; }
    else if (hexz) { type = 'MultiString'; value = hexz[1]; }
    else if (hex1) { type = 'Binary'; value = hex1[1]; }
    else if (/^"(?:[^"\\]|\\.)*"$/.test(rhs)) { type = 'String'; value = rhs.slice(1, -1).replace(/\\(.)/g, '$1'); }
    else if (rhs === '-') { type = 'String'; value = null; }
    const parsed = splitHive(key);
    if (!parsed) continue;
    ops.push({ kind: 'reg', hive: parsed.hive, path: parsed.path, name, type, value });
  }
  return ops;
}

function splitHive(full) {
  const m = /^(?:Registry::)?(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKLM|HKCU|HKEY_CLASSES_ROOT|HKCR|HKEY_USERS|HKU|HKEY_CURRENT_CONFIG|HKCC)\\(.*)$/i.exec(full);
  if (!m) return null;
  const map = {
    HKEY_LOCAL_MACHINE: 'HKLM', HKLM: 'HKLM',
    HKEY_CURRENT_USER: 'HKCU', HKCU: 'HKCU',
    HKEY_CLASSES_ROOT: 'HKCR', HKCR: 'HKCR',
    HKEY_USERS: 'HKU', HKU: 'HKU',
    HKEY_CURRENT_CONFIG: 'HKCC', HKCC: 'HKCC'
  };
  return { hive: map[m[1].toUpperCase()] || m[1], path: m[2] };
}

function psRegPath(p) {
  // 'HKLM:\SOFTWARE\X' / 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\X'
  const m = /^(?:Registry::)?(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKLM|HKCU|HKCR|HKEY_CLASSES_ROOT|HKU|HKEY_USERS)(.*)$/i.exec(String(p).trim());
  if (!m) return null;
  const rest = m[2].replace(/^:?\\+/, '');
  return splitHive(m[1] + '\\' + rest);
}

// --- recorder --------------------------------------------------------------

const FAKE_PLAN_GUID = '11111111-1111-1111-1111-111111111111';

function makeRecorder(ops) {
  const push = (op) => { ops.push(op); };

  const runCommand = (file, args = [], _timeout) => {
    file = String(file);
    if (/^reg(\.exe)?$/i.test(file) && /^(import|add)$/i.test(String(args[0]))) {
      const target = args.find((a) => /\.reg$/i.test(String(a)));
      if (target) {
        const abs = path.isAbsolute(target) ? target : path.join(APP, 'resources', 'resources', 'regs', target);
        if (fs.existsSync(abs)) {
          push({ kind: 'reg-import', file: path.basename(abs), ops: parseRegFile(abs) });
          return Promise.resolve('');
        }
      }
    }
    push({ kind: 'cmd', file, args: args.map(String) });
    let out = '';
    // Keep the power-plan builder from branching into "no plan created".
    if (/powercfg(\.exe)?$/i.test(file) && String(args[0]).toLowerCase() === '-duplicatescheme') {
      out = `Power Scheme GUID: ${FAKE_PLAN_GUID}  (Maximo rendimiento)\r\n`;
    }
    return Promise.resolve(out);
  };

  return {
    setRegValue: (regPath, name, type, value) => {
      const p = psRegPath(regPath);
      if (!p) { push({ kind: 'unparsed', api: 'setRegValue', args: [regPath, name, type, value] }); return Promise.resolve(); }
      push({ kind: 'reg', hive: p.hive, path: p.path, name, type, value });
      return Promise.resolve();
    },
    deleteRegValue: (regPath, name) => {
      const p = psRegPath(regPath);
      if (!p) { push({ kind: 'unparsed', api: 'deleteRegValue', args: [regPath, name] }); return Promise.resolve(); }
      push({ kind: 'reg', hive: p.hive, path: p.path, name, delete: true });
      return Promise.resolve();
    },
    runPowerShell: (script) => { push({ kind: 'ps', script: String(script) }); return Promise.resolve(''); },
    runScript: (script, timeoutMs) => { push({ kind: 'ps', script: String(script), timeoutMs: timeoutMs ?? null }); return Promise.resolve(''); },
    runDeElevatedScript: (script) => { push({ kind: 'ps', script: String(script), elevated: false }); return Promise.resolve(''); },
    runCommand,
    runRaw: (command) => { push({ kind: 'raw', command: String(command) }); return Promise.resolve(''); },
    openUrl: (url) => { push({ kind: 'open', target: 'url', value: String(url) }); return Promise.resolve(); },
    openApp: (file, args = []) => { push({ kind: 'open', target: 'app', value: String(file), args: args.map(String) }); return Promise.resolve(); },
    openPath: (p) => { push({ kind: 'open', target: 'path', value: String(p) }); return Promise.resolve(); },
    refreshAudioEndpoint: () => { push({ kind: 'action', name: 'refreshAudioEndpoint' }); return Promise.resolve(); }
  };
}

async function recordOne(tweak) {
  const applyOps = [];
  const revertOps = [];
  let applyError = null;
  let revertError = null;
  try {
    if (typeof tweak.apply !== 'function') throw new Error('no apply()');
    await tweak.apply(makeRecorder(applyOps));
  } catch (e) {
    applyError = e && e.message ? e.message : String(e);
  }
  if (typeof tweak.revert === 'function') {
    try {
      await tweak.revert(makeRecorder(revertOps));
    } catch (e) {
      revertError = e && e.message ? e.message : String(e);
    }
  }
  return { applyOps, revertOps, applyError, revertError };
}

const MODULES = [
  'catalog.js',
  'moreTweaks.js',
  'newTweaks.js',
  'extraTweaks.js',
  'tweaksV3.js',
  'tweaksLote9.js',
  'registryTweaks.js',
  'personalizarWindows.js',
  'scripts.js',
  'gpuPanel.js'
];

(async () => {
  const entries = [];
  const seen = new Set();
  for (const file of MODULES) {
    let mod;
    try {
      mod = require(path.join(APP, 'tweaks', file));
    } catch (e) {
      console.error(`skip ${file}: ${e.message}`);
      continue;
    }
    const list = Array.isArray(mod) ? mod : [];
    for (const t of list) {
      if (!t || !t.id || typeof t !== 'object') continue;
      if (seen.has(t.id)) { console.error(`duplicate id ${t.id} in ${file}`); continue; }
      seen.add(t.id);
      const rec = await recordOne(t);
      entries.push({
        id: t.id,
        name: t.name || t.id,
        description: t.description || '',
        warning: t.warning || null,
        laptopWarning: t.laptopWarning || null,
        risk: t.risk || null,
        category: t.category || null,
        subcategory: t.subcategory || null,
        actionOnly: !!t.actionOnly,
        buttonLabel: t.buttonLabel || null,
        confirmMessage: t.confirmMessage || null,
        perfImpact: t.perfImpact || null,
        vendor: t.vendor || null,
        premium: !!t.premium,
        remoteOnly: !!t.remoteOnly,
        sourceModule: file,
        apply: rec.applyOps,
        revert: typeof t.revert === 'function' ? rec.revertOps : null,
        applyError: rec.applyError,
        revertError: rec.revertError
      });
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: APP, tweaks: entries }, null, 2));

  const errors = entries.filter((t) => t.applyError);
  const noApply = entries.filter((t) => !t.apply.length && !t.applyError);
  const stats = {
    recorded: entries.length,
    applyErrors: errors.length,
    emptyApply: noApply.length,
    withRevert: entries.filter((t) => t.revert).length,
    premium: entries.filter((t) => t.premium).length,
    remoteOnly: entries.filter((t) => t.remoteOnly).length,
    actionOnly: entries.filter((t) => t.actionOnly).length
  };
  console.log(JSON.stringify(stats, null, 2));
  if (errors.length) {
    console.log('\napply errors:');
    for (const e of errors) console.log(`  ${e.id} [${e.sourceModule}]: ${e.applyError}`);
  }
  if (noApply.length) {
    console.log('\nempty apply:');
    for (const e of noApply) console.log(`  ${e.id} [${e.sourceModule}]`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
