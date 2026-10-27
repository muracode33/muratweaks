'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class BackupStore {
  constructor(baseDir) {
    this.dir = path.join(baseDir, 'backups');
    this.stateFile = path.join(baseDir, 'state.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed && parsed.schema === 1 && parsed.applied && typeof parsed.applied === 'object') return parsed;
    } catch {}
    return { schema: 1, applied: {} };
  }

  writeState(state) {
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  getApplied() {
    return this.readState().applied;
  }

  markApplied(tweakId, backupId, at = new Date().toISOString()) {
    const state = this.readState();
    state.applied[tweakId] = { backupId, at };
    this.writeState(state);
  }

  markReverted(tweakId) {
    const state = this.readState();
    delete state.applied[tweakId];
    this.writeState(state);
  }

  save({ tweakId, tweakName, entries, status = 'applied', context = null }) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const record = { version: 1, id, tweakId, tweakName, createdAt, status, entries, context };
    const safeStamp = createdAt.replace(/[:.]/g, '-');
    const file = path.join(this.dir, `${safeStamp}__${id}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  get(id) {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json') || !name.includes(id)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (record && record.id === id) return record;
      } catch {}
    }
    return null;
  }

  updateStatus(id, status) {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json') || !name.includes(id)) continue;
      const file = path.join(this.dir, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!record || record.id !== id) continue;
        record.status = status;
        fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
        return true;
      } catch {}
    }
    return false;
  }

  list() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (!record || !record.id || !record.tweakId) continue;
        const entryCount = Array.isArray(record.entries) ? record.entries.length : 0;
        out.push({
          id: record.id,
          tweakId: record.tweakId,
          tweakName: record.tweakName || record.tweakId,
          createdAt: record.createdAt || '',
          status: record.status || 'applied',
          entries: entryCount,
          restorable: entryCount > 0 || !!record.context?.powerplan
        });
      } catch {}
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

module.exports = { BackupStore };
