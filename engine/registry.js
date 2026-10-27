'use strict';

const { run, runPowerShell } = require('./exec');

const HABILITATED_HIVES = new Set(['HKLM', 'HKCU', 'HKCR', 'HKU', 'HKCC']);
const TYPE_FLAG = {
  DWord: 'REG_DWORD',
  String: 'REG_SZ',
  ExpandString: 'REG_EXPAND_SZ',
  QWord: 'REG_QWORD',
  MultiString: 'REG_MULTI_SZ',
  Binary: 'REG_BINARY'
};
const KNOWN_TYPES = new Set(Object.keys(TYPE_FLAG));

function assertRegOp(op) {
  if (!op || op.kind !== 'reg') throw new Error('Operacion de registro invalida.');
  if (!HABILITATED_HIVES.has(op.hive)) throw new Error(`Hive no soportado: ${op.hive}`);
  if (typeof op.path !== 'string' || !op.path.trim()) throw new Error('Ruta de registro vacia.');
  if (typeof op.name !== 'string') throw new Error('Nombre de valor invalido.');
  if (!op.delete && !TYPE_FLAG[op.type]) throw new Error(`Tipo de registro no soportado: ${op.type}`);
}

function fullKey(op) {
  return `${op.hive}\\${op.path.replace(/^\\+/, '')}`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Reads registry values through .NET, not by parsing reg.exe messages. That
// keeps "value does not exist" independent of the Windows language: a missing
// value returns null, while access errors throw a typed exception.
async function readValues(requests) {
  if (!requests.length) return [];
  for (const request of requests) {
    if (!request || !HABILITATED_HIVES.has(request.hive) || typeof request.path !== 'string' || typeof request.name !== 'string') {
      throw new Error('Pedido de lectura de registro invalido.');
    }
  }

  const script = `
$ErrorActionPreference = 'Stop'
$reqs = ConvertFrom-Json @'
${JSON.stringify(requests)}
'@
$roots = @{
  'HKLM' = [Microsoft.Win32.Registry]::LocalMachine
  'HKCU' = [Microsoft.Win32.Registry]::CurrentUser
  'HKCR' = [Microsoft.Win32.Registry]::ClassesRoot
  'HKU'  = [Microsoft.Win32.Registry]::Users
  'HKCC' = [Microsoft.Win32.Registry]::CurrentConfig
}
$out = New-Object System.Collections.ArrayList
foreach ($r in @($reqs)) {
  $item = [ordered]@{ i = [int]$r.i; exists = $false; error = $null; regType = $null; value = $null }
  try {
    $root = $roots[[string]$r.hive]
    if ($null -eq $root) { throw "Hive no soportado: $($r.hive)" }
    $key = $root.OpenSubKey([string]$r.path, $false)
    if ($null -ne $key) {
      try {
        $val = $key.GetValue([string]$r.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $val) {
          $kind = $key.GetValueKind([string]$r.name)
          $item.exists = $true
          $item.regType = $kind.ToString()
          if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { $item.value = [int64]$val }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::QWord) { $item.value = [string]$val }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::MultiString) { $item.value = @($val) }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) { $item.value = ([System.BitConverter]::ToString($val)).Replace('-','') }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::String -or $kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { $item.value = [string]$val }
          else { $item.error = 'Tipo de registro no soportado: ' + $kind.ToString() }
        }
      } finally { $key.Close() }
    }
  } catch {
    $item.error = $_.Exception.GetType().Name + ': ' + $_.Exception.Message
  }
  [void]$out.Add([pscustomobject]$item)
}
$out | ConvertTo-Json -Compress -Depth 4
`;

  const stdout = await runPowerShell(script, { timeoutMs: 120000 });
  const parsed = JSON.parse(String(stdout).trim() || '[]');
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return requests.map((request) => {
    const found = list.find((entry) => Number(entry.i) === Number(request.i));
    if (!found) throw new Error(`No se pudo leer ${request.hive}\\${request.path}\\${request.name || '(Default)'}.`);
    return found;
  });
}

async function queryValue(op) {
  assertRegOp(op);
  const [result] = await readValues([{ i: 0, hive: op.hive, path: op.path, name: op.name }]);
  if (result.error) throw new Error(`No se pudo leer ${fullKey(op)}\\${op.name || '(Default)'}: ${result.error}`);
  if (!result.exists) return { exists: false };
  return { exists: true, regType: result.regType, value: result.value };
}

function formatValue(op) {
  if (op.type === 'DWord' || op.type === 'QWord') return String(op.value);
  if (op.type === 'Binary') {
    const hex = String(op.value ?? '').replace(/[^0-9a-fA-F]/g, '');
    return (hex.match(/../g) || []).join(',');
  }
  return String(op.value ?? '');
}

async function writeValue(op) {
  assertRegOp(op);
  if (op.delete) return deleteValue(op);
  const key = fullKey(op);
  if (op.type === 'MultiString') {
    const values = `@(${(op.value || []).map(psQuote).join(', ')})`;
    const script = [
      `$key = ${psQuote(key)}`,
      `if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }`,
      op.name
        ? `Set-ItemProperty -Path $key -Name ${psQuote(op.name)} -Type MultiString -Value ${values}`
        : `Set-ItemProperty -Path $key -Name '(Default)' -Type MultiString -Value ${values}`,
      'exit 0'
    ].join('\n');
    await runPowerShell(script, { timeoutMs: 60000 });
    return;
  }
  const args = ['add', key];
  if (op.name) args.push('/v', op.name);
  else args.push('/ve');
  args.push('/t', TYPE_FLAG[op.type], '/d', formatValue(op), '/f');
  await run('reg', args, { timeoutMs: 30000 });
}

async function deleteValue(op) {
  assertRegOp(op);
  const args = ['delete', fullKey(op)];
  if (op.name) args.push('/v', op.name);
  else args.push('/ve');
  args.push('/f');
  try {
    await run('reg', args, { timeoutMs: 30000 });
  } catch (err) {
    // reg.exe localizes "not found"; ask .NET whether the value still exists
    // instead of matching the message text.
    const current = await queryValue(op).catch(() => null);
    if (current && !current.exists) return;
    throw err;
  }
}

// Reads every value a tweak is about to touch. These snapshots are the undo
// data: restoring them puts the machine back exactly as it was, including
// values that didn't exist before.
async function snapshot(ops) {
  const pending = [];
  const requests = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op.kind !== 'reg') continue;
    assertRegOp(op);
    pending.push({ index: i, op });
    requests.push({ i, hive: op.hive, path: op.path, name: op.name });
  }
  if (!requests.length) return [];
  const results = await readValues(requests);
  const byIndex = new Map(results.map((entry) => [Number(entry.i), entry]));
  return pending.map(({ index, op }) => {
    const result = byIndex.get(index);
    if (!result) throw new Error(`No se pudo leer ${fullKey(op)}\\${op.name || '(Default)'}.`);
    if (result.error) throw new Error(`No se pudo leer ${fullKey(op)}\\${op.name || '(Default)'}: ${result.error}`);
    if (result.exists && !KNOWN_TYPES.has(result.regType)) {
      throw new Error(`Tipo de registro no soportado en ${fullKey(op)}\\${op.name || '(Default)'}: ${result.regType}`);
    }
    return {
      index,
      op,
      before: {
        kind: 'reg',
        hive: op.hive,
        path: op.path,
        name: op.name,
        exists: !!result.exists,
        regType: result.exists ? result.regType : null,
        value: result.exists ? result.value : null
      }
    };
  });
}

// Pure plan: reverse order, recreate values that existed and delete the ones
// that didn't. Keeping it separate lets tests prove the undo data without
// touching the real registry.
function restorePlan(entries) {
  return [...entries].reverse().map((entry) => {
    const before = entry.before;
    if (!before || !before.exists) return { kind: 'reg', hive: entry.op.hive, path: entry.op.path, name: entry.op.name, delete: true };
    return {
      kind: 'reg',
      hive: before.hive,
      path: before.path,
      name: before.name,
      type: before.regType || 'String',
      value: before.value
    };
  });
}

async function restoreEntries(entries) {
  for (const op of restorePlan(entries)) await writeValue(op);
}

module.exports = {
  TYPE_FLAG,
  assertRegOp,
  fullKey,
  readValues,
  queryValue,
  writeValue,
  deleteValue,
  snapshot,
  restorePlan,
  restoreEntries
};
