// Builds data/catalog.json from the recorded operations. Drops premium and
// remote-only tweaks, normalizes the recorded values and replaces the few
// tweaks whose recording depended on this machine's state.
//
// Usage: node tools/build-catalog.js
'use strict';

const fs = require('fs');
const path = require('path');
const { organize } = require('../_extracted/ceitotweaks/tweaks/organization.js');

const ROOT = path.resolve(__dirname, '..');
const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, '_analysis/catalog.raw.json'), 'utf8'));
const OUT = path.join(ROOT, 'data/catalog.json');

const DROP = new Set([
  'red-test-velocidad',          // marker for a network speed-test panel, no tweak
  'install-rainmeter',           // opened a bundled third-party installer
  'rainmeter-skin-mond'          // opened a bundled third-party skin
]);

// Our own Defender exclusion tweak: discovers Steam libraries and Epic installs
// at apply time instead of the hardcoded paths recorded on this machine.
const DEFENDER_DISCOVER = `
$paths = @()
$steam = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath
if ($steam) {
  $vf = Join-Path $steam 'steamapps\\libraryfolders.vdf'
  if (Test-Path $vf) {
    foreach ($m in [regex]::Matches((Get-Content $vf -Raw), '"path"\\s+"([^"]+)"')) {
      $paths += Join-Path ($m.Groups[1].Value -replace '\\\\\\\\', '\\') 'steamapps\\common'
    }
  } else {
    $paths += Join-Path $steam 'steamapps\\common'
  }
}
$epic = Join-Path $env:ProgramData 'Epic\\EpicGamesLauncher\\Data\\Manifests'
if (Test-Path $epic) {
  Get-ChildItem $epic -Filter *.item -ErrorAction SilentlyContinue | ForEach-Object {
    try { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json; if ($j.InstallLocation) { $paths += $j.InstallLocation } } catch {}
  }
}
$paths = @($paths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
`;

const DEFENDER_EXCLUSION_PS = `${DEFENDER_DISCOVER}
if ($paths.Count -eq 0) { Write-Output 'ERROR: no se encontraron carpetas de juegos para excluir.'; exit 0 }
foreach ($p in $paths) { Add-MpPreference -ExclusionPath $p -ErrorAction SilentlyContinue }
$confirmadas = @(Get-MpPreference -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ExclusionPath -ErrorAction SilentlyContinue)
$ok = @($paths | Where-Object { $confirmadas -contains $_ }).Count
if ($ok -eq 0) { Write-Output 'ERROR: Windows Defender no confirmo ninguna exclusion (puede haber otro antivirus activo).'; exit 0 }
Write-Output ('OK: ' + $ok + ' de ' + $paths.Count + ' carpetas')
`;

const DEFENDER_REVERT_PS = `${DEFENDER_DISCOVER}
foreach ($p in $paths) { Remove-MpPreference -ExclusionPath $p -ErrorAction SilentlyContinue }
Write-Output ('OK: ' + $paths.Count + ' exclusiones quitadas')
`;

// Ceito's free power plan is built in JS around live powercfg output. Rebuild
// it as a native op so it creates a real plan on the target machine instead of
// pointing at the GUID that happened to appear while recording.
const POWER_PLAN_OP = { kind: 'powerplan', name: 'Mura Rendimiento' };

const ALLOWED_KINDS = new Set(['reg', 'ps', 'cmd', 'raw', 'open', 'action', 'reg-import', 'powerplan']);

function unquoteString(value) {
  if (typeof value !== 'string') return value;
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function normalizeOps(ops) {
  const out = [];
  for (const op of ops) {
    if (!ALLOWED_KINDS.has(op.kind)) throw new Error(`unsupported op kind ${op.kind}`);
    if (op.kind === 'reg') {
      if (!op.hive || !op.path || !op.name) throw new Error(`invalid reg op ${JSON.stringify(op)}`);
      const copy = { ...op, value: op.delete ? undefined : unquoteString(op.value) };
      if (copy.delete) delete copy.value;
      out.push(copy);
    } else if (op.kind === 'reg-import') {
      for (const inner of op.ops) out.push({ ...inner, value: unquoteString(inner.value) });
    } else {
      out.push(op);
    }
  }
  return out;
}

function rebrand(value) {
  if (typeof value === 'string') {
    return value
      .replace(/CeitoTweaks/g, 'MuraTweaks')
      .replace(/Ceito/g, 'Mura')
      // There is no paid tier here, so references to one are meaningless.
      .replace(/,\s*aunque menos que la versi[oó]n Premium\.?/gi, '.')
      .replace(/\s*\(?mejor que la versi[oó]n Premium\)?/gi, '')
      .replace(/versi[oó]n Premium/gi, 'version completa');
  }
  if (Array.isArray(value)) return value.map(rebrand);
  return value;
}

function rebrandOp(op) {
  const copy = { ...op };
  for (const key of ['name', 'value', 'script', 'command', 'file']) {
    if (typeof copy[key] === 'string') copy[key] = rebrand(copy[key]);
  }
  if (Array.isArray(copy.args)) copy.args = copy.args.map((a) => rebrand(String(a)));
  if (Array.isArray(copy.ops)) copy.ops = copy.ops.map(rebrandOp);
  return copy;
}

const tweaks = [];
for (const raw of RAW.tweaks) {
  if (raw.premium || raw.remoteOnly || DROP.has(raw.id)) continue;
  if (raw.applyError && raw.id !== 'fps-exclude-game-folders-defender') {
    console.error(`drop ${raw.id}: ${raw.applyError}`);
    continue;
  }
  if (!raw.apply.length) {
    console.error(`drop ${raw.id}: empty apply`);
    continue;
  }

  let apply = raw.apply;
  let revert = raw.revert;
  if (raw.id === 'fps-exclude-game-folders-defender') {
    apply = [{ kind: 'ps', script: DEFENDER_EXCLUSION_PS }];
    revert = [{ kind: 'ps', script: DEFENDER_REVERT_PS }];
  }
  if (raw.id === 'ceito-power-plan') {
    apply = [POWER_PLAN_OP];
    revert = undefined; // no portable undo: the plan is removed from Windows' power panel
  }

  tweaks.push({
    id: raw.id,
    name: rebrand(raw.name),
    description: rebrand(raw.description),
    warning: rebrand(raw.warning),
    laptopWarning: rebrand(raw.laptopWarning),
    risk: raw.risk,
    category: raw.category,
    subcategory: raw.subcategory,
    actionOnly: raw.actionOnly,
    buttonLabel: rebrand(raw.buttonLabel),
    confirmMessage: rebrand(raw.confirmMessage),
    perfImpact: raw.perfImpact,
    vendor: raw.vendor,
    sourceModule: raw.sourceModule,
    apply: normalizeOps(apply.map(rebrandOp)),
    revert: revert ? normalizeOps(revert.map(rebrandOp)) : null
  });
}

const organized = organize(tweaks);
const seen = new Set();
const finalTweaks = [];
for (const t of organized) {
  if (seen.has(t.id)) continue;
  seen.add(t.id);
  finalTweaks.push(t);
  if (!t.apply || !t.apply.length) throw new Error(`tweak ${t.id} lost its operations`);
}

const categories = [];
for (const t of finalTweaks) if (!categories.includes(t.category)) categories.push(t.category);

const catalog = {
  catalogVersion: 1,
  generatedAt: new Date().toISOString(),
  categories,
  tweaks: finalTweaks
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(catalog, null, 0));

console.log(`wrote ${OUT}: ${finalTweaks.length} tweaks, ${categories.length} categories, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB`);
console.log(categories.join(' | '));
const counts = {};
for (const t of finalTweaks) counts[t.risk || 'sin-riesgo'] = (counts[t.risk || 'sin-riesgo'] || 0) + 1;
console.log(counts);
