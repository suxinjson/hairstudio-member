import { batchScope } from './relational-batches.js';

// Explicit bounded foreground execution. No timer, automatic ID replacement,
// version refresh or inferred success after a network failure. The repository
// owns every captured payload; restarting this controller just reloads progress.
export function createBatchRunner({ repository, getScope }) {
  let running = false;
  async function scope(input) {
    const captured = batchScope(input), current = await getScope();
    if (captured.storeId !== current.storeId || captured.actorId !== current.actorId || captured.deviceId !== current.deviceId || captured.ledgerEpoch !== current.ledgerEpoch) throw Object.assign(new Error('批次原身份或账本已变化'), { code: 'BATCH_CONTEXT_CHANGED', status: 409 });
    return captured;
  }
  return {
    async run(input, { maxItems = 500, signal, onProgress = () => {} } = {}) {
      const captured = batchScope(input);
      if (running) throw Object.assign(new Error('当前批次控制器正在运行'), { code: 'BATCH_BUSY', status: 409 });
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500) throw new Error('本次执行数量须为 1–500');
      running = true;
      try {
        let after = -1, sent = 0;
        for (;;) {
          await scope(captured);
          const page = await repository.getBatch(captured, { after, limit: 100 });
          await scope(captured);
          if (page.state !== 'active' || signal?.aborted) return page;
          const pending = page.items.filter(item => item.state === 'pending');
          const step = repository.executeBatchItems ? 25 : 1;
          for (let start = 0; start < pending.length; start += step) {
            if (signal?.aborted || sent === maxItems) return repository.getBatch(captured);
            await scope(captured);
            // A thrown call may already have committed. Leave the original
            // capture intact and let an explicit later run read its receipt.
            const taskIds = pending.slice(start, start + Math.min(step, maxItems - sent)).map(item => item.taskId);
            if (taskIds.length === 1) await repository.executeBatchItem(captured, taskIds[0]);
            else await repository.executeBatchItems(captured, { taskIds, signal });
            sent += taskIds.length;
            await scope(captured);
            const progress = await repository.getBatch(captured); await scope(captured); await onProgress(progress);
          }
          if (page.nextAfter === null) return repository.getBatch(captured);
          after = page.nextAfter;
        }
      } finally { running = false; }
    }
  };
}
