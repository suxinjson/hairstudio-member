import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nextTick, reactive } from 'vue';
import { createApi } from '../http.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createService } from './helpers/licensed-service.js';
import { nativeFile, nativeCredentials, memoryStorage } from '../../tests/helpers/native-fixture.mjs';
import { archiveDocumentPlugin } from '../../tests/helpers/archive-document-plugin.mjs';
import { androidArchiveDocuments } from '../../src/android-archive-documents.js';
import { LICENSE_FEATURES } from '../../src/license-policy.js';
import { createRelationalNativeSession } from '../../src/relational-native-session.js';
import { createNativeWorkspace } from '../../src/relational-native-workspace.js';
import { createNativeArchiveController } from '../../src/relational-native-files.js';
import { createOpeningFiles } from '../../src/relational-openings.js';
import { buildOpeningProjection } from '../../tools/relational-import.mjs';

const debit = { type: 'consume', memberId: 'example', expectedAccountVersion: '0', amountCents: '250' };
const opening = { id: 'example', name: '合成会员', balanceCents: '1000' };
const password = 'Native-Workspace-Validation-2026!';

test('native login and paged first sync fence offline writing until complete, then retain the original command through restart and lost server response', async t => {
  const db = await relationalTestDatabase(); t.after(() => db.close());
  const instance = createService(db.pool);
  const { storeId } = await instance.createOwner({ username: 'native-owner', password });
  const login = await instance.login({ username: 'native-owner', password, deviceId: randomUUID() });
  const owner = await instance.authenticate(login.accessToken);
  const ledger = instance.relational, { ledgerEpoch } = await ledger.getBook(owner);
  await ledger.importOpeningBalances(owner, { ledgerEpoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: 2,
    members: [opening, { id: 'another', name: '合成会员乙', balanceCents: '0' }] });
  await instance.createUser(owner, { username: 'native-clerk', password, displayName: '店员', role: 'clerk' });
  const api = createApi({ service: instance, pool: db.pool });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  const origin = 'http://127.0.0.1:' + api.address().port;
  const device = nativeCredentials(randomUUID()), file = await nativeFile(t), storage = memoryStorage();
  let online = true, pauseFirstSync = true, pages = 0, dropResponse = false;
  const dispatched = [];
  const transport = async (url, options) => {
    const parsed = new URL(url);
    if (!online) throw new Error('offline');
    if (parsed.pathname === '/api/v2/sync/changes' && pauseFirstSync) {
      if (pages++ > 0) throw new Error('interrupted initial synchronization');
      parsed.searchParams.set('limit', '1');
    }
    const response = await fetch(parsed, options);
    if (parsed.pathname === '/api/v2/commands') {
      dispatched.push(JSON.parse(options.body).id);
      if (dropResponse) { dropResponse = false; assert.equal(response.status, 200); await response.text(); throw new Error('reply lost'); }
    }
    return response;
  };
  const create = () => {
    const session = createRelationalNativeSession({ device, isOnline: () => online, fetch: transport });
    return { session, book: createNativeWorkspace(session, { storage, openDriver: file.open }) };
  };
  let state = create();
  const connect = async () => { await nextTick(); await state.book.connect(); };
  try {
    await state.session.login(origin, 'native-owner', password); await connect();
    await state.book.sync(); assert.equal(state.book.state.replicaReady, false);
    assert.equal(state.book.getScope().storeId, storeId);
    await assert.rejects(state.book.submit('command', debit, state.book.getScope()), { code: 'REPLICA_NOT_READY' });
    await state.book.dispose(); pauseFirstSync = false;
    state = create(); await state.session.init(); await state.session.heartbeat(); await connect(); await state.book.sync();
    assert.equal(state.book.state.replicaReady, true);
    assert.equal((await state.book.read('getMember', opening.id)).balanceCents, '1000');
    online = false; await state.session.heartbeat();
    const original = await state.book.submit('command', debit, state.book.getScope());
    assert.equal(original.balanceAfterCents, '750'); assert.deepEqual(dispatched, []);
    await state.book.dispose(); state = create(); await state.session.init(); await connect();
    assert.equal((await state.book.read('getMember', opening.id)).balanceCents, '750');
    assert.equal((await state.book.pendingDetails(original.commandId)).command.id, original.commandId);
    await state.session.logout(); online = true;
    await state.session.login(origin, 'native-clerk', password); await connect(); await state.book.sync();
    assert.equal(state.book.state.syncError, 'PENDING_ACTOR_CHANGED');
    assert.deepEqual(dispatched, []);
    await state.session.logout(); dropResponse = true;
    await state.session.login(origin, 'native-owner', password); await connect(); await state.book.sync();
    assert.deepEqual(dispatched, [original.commandId]);
    assert.equal((await ledger.getMember(owner, opening.id)).balanceCents, '750');
    await state.book.dispose(); state = create(); await state.session.init(); await state.session.heartbeat(); await connect();
    await state.book.sync();
    assert.equal(state.book.state.pendingCount, 0);
    assert.equal((await ledger.listLedger(owner)).items.length, 1);
    assert.ok(dispatched.every(id => id === original.commandId));
  } finally { await state.book.dispose(); }
});

function standalone(storeId, file, storage = memoryStorage()) {
  const user = { id: randomUUID(), storeId, role: 'owner' }, deviceId = randomUUID();
  const state = reactive({ binding: { mode: 'standalone', storeId }, user, generation: 0, busy: false,
    deviceId, deviceAccess: { allowed: true, features: LICENSE_FEATURES } });
  const session = { state, remote: {}, async authorize() { return { ...state.user, deviceId, features: LICENSE_FEATURES, contextVersion: state.generation }; } };
  return createNativeWorkspace(session, { storage, openDriver: file.open });
}

test('unknown SQLite COMMIT can be settled in the native workspace by reading the original local receipt after reopening', async t => {
  const file = await nativeFile(t), book = standalone(randomUUID(), file);
  try {
    await book.connect();
    await book.repository.importOpeningBalances({ ledgerEpoch: book.getScope().ledgerEpoch, batchId: randomUUID(),
      sourceDigest: 'a'.repeat(64), expectedCount: 1, members: [opening] });
    const member = await book.read('getMember', opening.id);
    file.failCommit('after');
    await assert.rejects(book.submit('command', { ...debit, expectedAccountVersion: member.accountVersion }, book.getScope()), /commit response unavailable/);
    const original = book.state.pending.id;
    assert.equal(book.repository.needsReopen, true);
    const recovered = await book.retryPending();
    assert.equal(file.opened, 2);
    assert.equal(recovered.commandId, original); assert.equal(recovered.balanceAfterCents, '750');
    assert.equal(book.state.pending, null);
    assert.equal((await book.read('listLedger', {})).items.length, 1);
    file.failCommit('before');
    await assert.rejects(book.submit('command', { ...debit, expectedAccountVersion: recovered.accountVersion }, book.getScope()), /commit response unavailable/);
    assert.deepEqual(await book.retryPending(), { uncommitted: true });
    assert.equal((await book.read('getMember', opening.id)).balanceCents, '750');
  } finally { await book.dispose(); }
});

test('standalone opening review is read only and an unknown COMMIT returns the original batch after SQLite reopens', async t => {
  const file = await nativeFile(t), book = standalone(randomUUID(), file);
  const { projection, summary } = buildOpeningProjection(JSON.stringify({ members: Array.from({ length: 91 }, (_, i) => ({
    id: 'native-opening-' + i, name: '合成独立结转 ' + i, balance: i - 45, phone: '000' + i
  })) }));
  try {
    await book.connect(); const epoch = book.getScope().ledgerEpoch;
    const controller = createOpeningFiles(book), content = JSON.stringify(projection);
    assert.equal((await controller.review(content, summary)).zeroBalanceCount, 1);
    assert.equal((await book.read('listMembers', {})).items.length, 0);
    file.failCommit('after'); await assert.rejects(controller.submit(), /commit response unavailable/);
    const recovered = createOpeningFiles(book);
    assert.equal(recovered.pending().batchId, projection.batchId);
    assert.equal(recovered.pending().ledgerEpoch, epoch);
    await recovered.review(content, summary);
    const result = await recovered.submit(); assert.equal(result.alreadyImported, true); assert.equal(result.memberCount, 91);
    assert.equal(result.ledgerEpoch, epoch); assert.equal(file.opened, 2); assert.equal(recovered.pending(), null);
    const members = (await book.read('listMembers', { limit: 100 })).items;
    assert.deepEqual(Object.fromEntries(members.map(row => [row.id, row.balanceCents])), Object.fromEntries(projection.members.map(row => [row.id, row.balanceCents])));
    assert.deepEqual((await book.read('listLedger', {})).items, []);
  } finally { await book.dispose(); }
});

test('native archive readback and committed restore finish by the original task across an uncertain commit and a new ledger epoch', async t => {
  const [source, target] = await Promise.all([nativeFile(t), nativeFile(t)]);
  const storeId = randomUUID(), original = standalone(storeId, source), restored = standalone(storeId, target);
  const provider = archiveDocumentPlugin(), documentPort = androidArchiveDocuments({ plugin: provider.plugin, native: true });
  try {
    await original.connect(); await restored.connect();
    const starting = restored.getScope().ledgerEpoch;
    await original.repository.importOpeningBalances({ ledgerEpoch: original.getScope().ledgerEpoch, batchId: randomUUID(),
      sourceDigest: 'b'.repeat(64), expectedCount: 1, members: [opening] });
    assert.equal((await createNativeArchiveController(original, { documents: documentPort }).save()).status, 'saved-verified');
    const controller = createNativeArchiveController(restored, { documents: documentPort });
    const { taskId } = await controller.chooseRestore();
    assert.equal((await restored.read('listMembers', {})).items.length, 0);
    // Arm the failure only for the restore COMMIT, after the receipt precheck.
    const write = restored.repository.restoreArchive;
    restored.repository.restoreArchive = options => { target.failCommit('after'); return write(options); };
    await assert.rejects(controller.restore(taskId), /commit response unavailable/);
    assert.equal(controller.pending().taskId, taskId);
    await controller.forgetPreview();
    provider.bytes = Buffer.alloc(0);
    const reopenedController = createNativeArchiveController(restored, { documents: documentPort });
    const result = await reopenedController.restore(taskId);
    assert.equal(result.taskId, taskId); assert.equal(result.targetEpoch, starting); assert.notEqual(result.ledgerEpoch, starting);
    await restored.connect();
    assert.equal(restored.getScope().ledgerEpoch, result.ledgerEpoch);
    assert.equal((await restored.read('getMember', opening.id)).balanceCents, '1000');
    assert.equal(reopenedController.pending(), null);
  } finally { await original.dispose(); await restored.dispose(); }
});
