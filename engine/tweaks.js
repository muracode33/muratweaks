'use strict';

const { run, runShell, runPowerShell, refreshAudioEndpoint } = require('./exec');
const registry = require('./registry');
const { ensurePowerPlan, revertPowerPlan, capturePowerPlanState } = require('./powerplan');
const { isUndoable } = require('./catalog');

function firstLine(text) {
  return String(text || '').split(/\r?\n/).find((line) => line.trim()) || 'error desconocido';
}

function expandOps(ops) {
  const out = [];
  for (const op of ops) {
    if (op.kind === 'reg-import') out.push(...op.ops);
    else out.push(op);
  }
  return out;
}

class TweakEngine {
  constructor({ catalog, store, env, adminCheck }) {
    this.catalog = catalog;
    this.store = store;
    this.byId = new Map(catalog.tweaks.map((tweak) => [tweak.id, tweak]));
    this.env = env;
    this.adminCheck = adminCheck;
    this.busy = new Set();
    this.queue = Promise.resolve();
  }

  // One registry-changing operation at a time, whatever card the user clicks.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  tweak(id) {
    const found = this.byId.get(id);
    if (!found) throw new Error(`No existe el tweak "${id}".`);
    return found;
  }

  async assertAdmin(tweak) {
    if (!tweak.needsAdmin) return;
    if (await this.adminCheck()) return;
    const err = new Error('Este ajuste necesita permisos de administrador. Reinicia MuraTweaks como administrador.');
    err.code = 'admin';
    throw err;
  }

  async executeOp(op) {
    switch (op.kind) {
      case 'reg':
        return registry.writeValue(op);
      case 'ps': {
        const options = op.timeoutMs ? { timeoutMs: op.timeoutMs } : {};
        return runPowerShell(op.script, options);
      }
      case 'cmd':
        return run(op.file, op.args, { timeoutMs: 5 * 60 * 1000 });
      case 'raw':
        return runShell(op.command, { timeoutMs: 5 * 60 * 1000 });
      case 'open':
        if (op.target === 'url') return this.env.openUrl(op.value);
        if (op.target === 'path') return this.env.openPath(op.value);
        return this.env.openApp(op.value, op.args || []);
      case 'action':
        return refreshAudioEndpoint();
      case 'powerplan':
        return ensurePowerPlan(op.name);
      default:
        throw new Error(`Operacion no soportada: ${op.kind}`);
    }
  }

  async apply(id) {
    if (this.busy.has(id)) {
      const err = new Error('Ese ajuste ya se esta aplicando.');
      err.code = 'busy';
      throw err;
    }
    this.busy.add(id);
    try {
      return await this.serial(() => this.applyInner(id));
    } finally {
      this.busy.delete(id);
    }
  }

  async applyInner(id) {
    const tweak = this.tweak(id);
    await this.assertAdmin(tweak);
    const ops = expandOps(tweak.apply);

    // Shortcuts (open a settings page, refresh audio...) leave no state.
    if (ops.every((op) => op.kind === 'open' || op.kind === 'action')) {
      for (const op of ops) await this.executeOp(op);
      return { ok: true, transient: true, entries: 0 };
    }

    // Snapshot before writing the backup. If a read fails, nothing changed yet.
    const entries = await registry.snapshot(ops);
    const planOp = ops.find((op) => op.kind === 'powerplan');
    let context = null;
    if (planOp) {
      try {
        context = { powerplan: await capturePowerPlanState() };
      } catch (error) {
        throw new Error(`No se pudo guardar el estado del plan de energia: ${firstLine(error.message)}`);
      }
    }

    // Write-ahead backup: the undo data exists on disk before the first change.
    const backup = this.store.save({ tweakId: tweak.id, tweakName: tweak.name, entries, status: 'pending', context });
    const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
    const executed = [];
    let commandsRun = 0;

    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index];
      try {
        await this.executeOp(op);
        if (op.kind === 'reg') {
          if (byIndex.has(index)) executed.push(byIndex.get(index));
        } else if (op.kind !== 'open' && op.kind !== 'action') {
          commandsRun += 1;
        }
      } catch (error) {
        let rollback = 'No se pudo revertir automaticamente: ';
        try {
          await registry.restoreEntries(executed);
          rollback = 'Se restauraron los valores de registro ya cambiados.';
        } catch (rollbackError) {
          rollback += firstLine(rollbackError.message);
        }
        if (commandsRun) rollback += ' Los comandos ya ejecutados no se revierten automaticamente.';
        this.store.updateStatus(backup.id, 'failed');
        const failure = new Error(`Fallo "${tweak.name}" en el paso ${index + 1} de ${ops.length}: ${firstLine(error.message)}. ${rollback}`);
        failure.code = 'apply-failed';
        failure.partial = executed.length > 0 || commandsRun > 0;
        throw failure;
      }
    }

    this.store.updateStatus(backup.id, 'applied');
    this.store.markApplied(tweak.id, backup.id);
    return { ok: true, backupId: backup.id, entries: entries.length };
  }

  async runRevertOps(tweak, ops, { skipReg }) {
    for (const op of expandOps(ops)) {
      if (skipReg && op.kind === 'reg') continue;
      await this.executeOp(op);
    }
  }

  async revert(id) {
    return this.serial(() => this.revertInner(id));
  }

  async revertInner(id) {
    const tweak = this.tweak(id);
    await this.assertAdmin(tweak);
    const applied = this.store.getApplied()[id];
    const backup = applied ? this.store.get(applied.backupId) : null;
    const planContext = backup && backup.context ? backup.context.powerplan : null;

    if (backup && Array.isArray(backup.entries) && backup.entries.length) {
      await registry.restoreEntries(backup.entries);
    }

    if (tweak.revert && tweak.revert.length) {
      await this.runRevertOps(tweak, tweak.revert, { skipReg: !!(backup && backup.entries.length) });
    } else {
      const planOp = tweak.apply.find((op) => op.kind === 'powerplan');
      if (planOp) await revertPowerPlan(planOp.name, planContext);
      else if (!backup || !backup.entries.length) throw new Error('Este ajuste no tiene reversion automatica ni backup guardado.');
    }

    if (backup) this.store.updateStatus(backup.id, 'reverted');
    this.store.markReverted(id);
    return { ok: true };
  }

  async restoreBackup(backupId) {
    return this.serial(() => this.restoreBackupInner(backupId));
  }

  async restoreBackupInner(backupId) {
    const record = this.store.get(backupId);
    if (!record) throw new Error('No se encontro ese backup.');
    const tweak = this.byId.get(record.tweakId);
    const planOp = tweak ? tweak.apply.find((op) => op.kind === 'powerplan') : null;
    if (!record.entries.length) {
      if (planOp) {
        await revertPowerPlan(planOp.name, record.context ? record.context.powerplan : null);
        this.store.updateStatus(record.id, 'reverted');
        this.store.markReverted(record.tweakId);
        return { ok: true, entries: 0 };
      }
      throw new Error('Ese backup no guardo valores de registro; usa "Revertir" en el ajuste.');
    }
    await this.assertAdmin(tweak || { needsAdmin: record.entries.some((e) => e.op.hive !== 'HKCU') });
    await registry.restoreEntries(record.entries);
    this.store.updateStatus(record.id, 'reverted');
    const applied = this.store.getApplied()[record.tweakId];
    if (applied && applied.backupId === record.id) this.store.markReverted(record.tweakId);
    return { ok: true, entries: record.entries.length };
  }

  listApplied() {
    const applied = this.store.getApplied();
    return Object.entries(applied)
      .map(([id, data]) => {
        const tweak = this.byId.get(id);
        return { id, name: tweak ? tweak.name : id, at: data.at, backupId: data.backupId, undoable: tweak ? isUndoable(tweak) : false };
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  async undoAll() {
    return this.serial(async () => {
      const results = [];
      for (const item of this.listApplied()) {
        if (!item.undoable) {
          results.push({ id: item.id, name: item.name, ok: false, skipped: true, error: 'sin reversion automatica' });
          continue;
        }
        try {
          await this.revertInner(item.id);
          results.push({ id: item.id, name: item.name, ok: true });
        } catch (error) {
          results.push({ id: item.id, name: item.name, ok: false, error: firstLine(error.message) });
        }
      }
      return results;
    });
  }
}

module.exports = { TweakEngine, expandOps, firstLine };
