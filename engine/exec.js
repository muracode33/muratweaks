'use strict';

const { execFile, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BUFFER = 10 * 1024 * 1024;
const PS_PRELUDE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n';

function run(file, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: MAX_BUFFER, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = [String(stdout || '').trim(), String(stderr || '').trim(), err.message].filter(Boolean).join('\n');
        reject(new Error(detail));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function runShell(command, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, maxBuffer: MAX_BUFFER, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = [String(stdout || '').trim(), String(stderr || '').trim(), err.message].filter(Boolean).join('\n');
        reject(new Error(detail));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

// Long scripts go through a temp .ps1: passing them as -Command breaks on the
// double quoting layer (cmd.exe + PowerShell). The BOM keeps PowerShell 5.1
// from reading accents as ANSI.
async function runPowerShell(script, { timeoutMs = 300000 } = {}) {
  const file = path.join(os.tmpdir(), `muratweaks-${crypto.randomUUID()}.ps1`);
  fs.writeFileSync(file, '﻿' + PS_PRELUDE + script, 'utf8');
  try {
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { timeoutMs });
    const failed = out.split(/\r?\n/).find((line) => line.trim().startsWith('ERROR:'));
    if (failed) throw new Error(failed.trim().replace(/^ERROR:\s*/, ''));
    return out;
  } finally {
    fs.unlink(file, () => {});
  }
}

let adminCache = null;

// fltmc asks the filter manager (admin-only) instead of the Server service:
// net session fails when LanmanServer is disabled, even in an elevated process.
async function isAdmin() {
  if (adminCache !== null) return adminCache;
  try {
    await run('fltmc', [], { timeoutMs: 10000 });
    adminCache = true;
  } catch {
    try {
      await run('net', ['session'], { timeoutMs: 10000 });
      adminCache = true;
    } catch {
      adminCache = false;
    }
  }
  return adminCache;
}

// A short volume up/down pulse wakes the audio endpoint after MMCSS or ducking
// changes, without touching the audio service.
async function refreshAudioEndpoint() {
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';",
    '$t = Add-Type -MemberDefinition $sig -Name MuraVolumePulse -Namespace Mura -PassThru;',
    '$t::keybd_event(0xAF,0,0,[UIntPtr]::Zero);',
    '$t::keybd_event(0xAF,0,2,[UIntPtr]::Zero);',
    'Start-Sleep -Milliseconds 20;',
    '$t::keybd_event(0xAE,0,0,[UIntPtr]::Zero);',
    '$t::keybd_event(0xAE,0,2,[UIntPtr]::Zero);',
    'exit 0;'
  ].join(' ');
  await runPowerShell(script, { timeoutMs: 30000 }).catch(() => '');
}

module.exports = { run, runShell, runPowerShell, isAdmin, refreshAudioEndpoint };
