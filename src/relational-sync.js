// The synchronizer never creates a replacement command ID. A lost response
// leaves the original typed outbox row available for idempotent retry.
import { requireLedgerEpoch } from './ledger-epoch.js';

export function createRelationalSync({ repository, remote, maxPages = 100 }) {
  if (!repository || !remote || typeof remote.getBook !== 'function' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('同步配置无效');
  let running = null;
  const epochError = error => ['LEDGER_EPOCH_MISMATCH', 'LEDGER_EPOCH_REQUIRED'].includes(error.code);
  const blocked = error => epochError(error) || ['CURSOR_AHEAD', 'CURSOR_HISTORY_INCOMPLETE'].includes(error.code);
  async function perform() {
    if (repository.mode !== 'cloud') throw new Error('独立离线账本不能自动上传');
    // Read the remote generation before sending even the first queued command.
    // The server also checks it inside each write transaction to fence a
    // recovery racing this preflight. Never rebind old queued work.
    try {
      const local = await repository.getBook(), current = await remote.getBook();
      if (current.storeId !== local.storeId) return { status: 'blocked', errorCode: 'STORE_MISMATCH' };
      requireLedgerEpoch(local.ledgerEpoch, current.ledgerEpoch);
    } catch (error) {
      return { status: error.code === 'LEDGER_EPOCH_MISMATCH' || error.code === 'LEDGER_EPOCH_REQUIRED' || error.status === 401 || error.status === 403 ? 'blocked' : 'pending', errorCode: error.code || 'RESULT_UNKNOWN' };
    }
    const pending = await repository.pendingCommands({ limit: 100 });
    if (pending.length) {
      // A cursor fence must also be visible while an earlier conflict is waiting for review.
      const state = await repository.syncState();
      try { await remote.changes({ ledgerEpoch: state.ledgerEpoch, after: state.cursor, limit: 100 }); }
      catch (error) { if (blocked(error)) return { status: 'blocked', errorCode: error.code }; throw error; }
    }
    for (const item of pending) {
      if (item.status === 'blocked') return { status: 'blocked', commandId: item.command.id, errorCode: item.errorCode };
      if (item.status === 'conflict') return { status: 'conflict', commandId: item.command.id, errorCode: item.errorCode };
      let result;
      try { result = await remote.executeCommand(item.command); }
      catch (error) {
        if (error.code === 'LEDGER_EPOCH_MISMATCH' || error.code === 'LEDGER_EPOCH_REQUIRED') return { status: 'blocked', commandId: item.command.id, errorCode: error.code };
        if (error.status === 409 || error.status === 400 || error.status === 404) {
          const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'SERVER_REJECTED';
          await repository.markConflict(item.command.id, code);
          return { status: 'conflict', commandId: item.command.id, errorCode: code };
        }
        return { status: error.status === 401 || error.status === 403 ? 'blocked' : 'pending', commandId: item.command.id, errorCode: error.code || 'RESULT_UNKNOWN' };
      }
      // If acknowledgement fails, the original row is retained. Retrying the
      // server operation is safe because the full command ID is unchanged.
      try { await repository.acknowledge(item.command.id, result); }
      catch (error) {
        if (error.code === 'LEDGER_EPOCH_MISMATCH' || error.code === 'LEDGER_EPOCH_REQUIRED') return { status: 'blocked', commandId: item.command.id, errorCode: error.code };
        if (error.code === 'RECEIPT_MISMATCH') {
          await repository.markConflict(item.command.id, error.code);
          return { status: 'conflict', commandId: item.command.id, errorCode: error.code };
        }
        throw error;
      }
    }
    if ((await repository.syncState()).pendingCount) return { status: 'pending' };
    for (let index = 0; index < maxPages; index++) {
      const state = await repository.syncState(); let page;
      try { page = await remote.changes({ ledgerEpoch: state.ledgerEpoch, after: state.cursor, limit: 100 }); }
      catch (error) { if (blocked(error)) return { status: 'blocked', errorCode: error.code }; throw error; }
      try { await repository.applyChanges(page); }
      catch (error) { if (error.code === 'LEDGER_EPOCH_MISMATCH' || error.code === 'LEDGER_EPOCH_REQUIRED') return { status: 'blocked', errorCode: error.code }; if (error.code === 'SYNC_PENDING') return { status: 'pending' }; throw error; }
      const current = await repository.syncState();
      if (!page.hasMore) {
        if (page.cursor !== page.head) throw new Error('服务器增量页面提前结束');
        return { status: current.pendingCount ? 'pending' : 'confirmed', cursor: current.cursor };
      }
      if (BigInt(current.cursor) <= BigInt(state.cursor)) throw new Error('同步游标未前进');
    }
    return { status: 'catching_up', cursor: (await repository.syncState()).cursor };
  }
  return {
    sync() { if (!running) running = perform().finally(() => { running = null; }); return running; },
    async inspectOriginal(commandId) {
      if (running) await running;
      const item = await repository.pendingDetails(commandId), { command } = item;
      const remoteBook = await remote.getBook();
      if (remoteBook.storeId !== command.storeId) return { status: 'blocked', errorCode: 'STORE_MISMATCH' };
      try {
        requireLedgerEpoch(command.ledgerEpoch, remoteBook.ledgerEpoch);
        const result = await remote.getCommand(command.id, { ledgerEpoch: command.ledgerEpoch });
        await repository.acknowledge(command.id, result);
        return { status: 'confirmed', result };
      } catch (error) {
        if (epochError(error)) return { status: 'blocked', errorCode: error.code };
        if (error.status === 404 && error.code === 'COMMAND_NOT_FOUND') return { status: 'not-found', commandId };
        throw error;
      }
    }
  };
}
