import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function createMaintenance(store, adapter, { interval = 2000 } = {}) {
  const path = join(dirname(store.path), 'pending-maintenance.json');
  const jobs = new Map(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
  let running = null, stopped = false, paused = false;
  const persist = () => {
    writeFileSync(path + '.tmp', JSON.stringify([...jobs]), { flush: true });
    renameSync(path + '.tmp', path);
  };
  async function drain(id) {
    if (running) await running;
    const job = id ? jobs.get(id) : [...jobs.values()].find(value => value.next <= Date.now());
    if (!job || stopped || paused || !adapter) return;
    running = (async () => {
      try {
        if (job.annotation) {
          await adapter.retryAnnotation(job.id, job.annotation === true ? undefined : job.annotation);
          job.annotation = false;
          persist();
        }
        if (job.compact) await adapter.compact(job.id);
        jobs.delete(job.id);
      } catch (error) {
        job.attempts++;
        job.next = Date.now() + Math.min(60000, interval * 2 ** Math.min(job.attempts, 5));
        console.error('BigFish maintenance retry:', error.code ?? 'RETRY', error.cause?.message ?? error.message);
      } finally { persist(); }
    })();
    try { await running; } finally { running = null; }
  }
  const timer = setInterval(() => { if (!running && !stopped && !paused) drain().catch(error => console.error('BigFish maintenance:', error.message)); }, interval);
  timer.unref();
  return {
    pending: id => jobs.has(id),
    schedule(id, error) {
      const existing = jobs.get(id);
      jobs.set(id, {
        id, annotation: error.annotation ?? existing?.annotation ?? (error.code === 'ANNOTATION_FAILED'),
        compact: !!(existing?.compact || error.code === 'COMPACTION_FAILED' || error.compactionError),
        attempts: existing?.attempts ?? 0, next: Date.now() + interval,
      });
      persist();
    },
    async ensure(id) {
      if (jobs.has(id)) await drain(id);
      if (jobs.has(id)) throw Object.assign(new Error('记忆正在自动整理，请稍候'), { code: 'MAINTENANCE_PENDING' });
    },
    async pause() { paused = true; await running; },
    resume() { paused = false; },
    async close() { stopped = true; clearInterval(timer); await running; },
  };
}
