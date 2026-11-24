import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, configureRuntimeRole, assertRuntimeRole } from '../database.js';
import { signAliGenieRequest } from '../aligenie.js';
import { createService } from './helpers/licensed-service.js';
import { randomUUID } from 'node:crypto';
import { roleTestDatabase } from './helpers/role-database.js';

test('migration preserves the new ledger and runtime grants support business work while denying administrator actions', async () => {
  let db, query, cleanup;
  if (process.env.MEMBER_TEST_ADMIN_DATABASE_URL) {
    const fixture = await roleTestDatabase();
    const client = await fixture.pool.connect().catch(async error => { await fixture.close(); throw error; });
    query = (...args) => client.query(...args);
    cleanup = async () => { client.release(); await fixture.close(); };
  } else {
    db = new PGlite();
    query = (sql, parameters) => parameters ? db.query(sql, parameters) : sql.includes(';') ? db.exec(sql) : db.query(sql);
    cleanup = () => db.close();
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    const administrator = (await query('SELECT current_user AS name')).rows[0].name;
    const service = createService(pool), password = 'Correct-Horse-Cloud-2026!';
    const created = await service.createOwner({ username: 'owner', password });
    await configureRuntimeRole(pool, 'x'.repeat(48));
    await migrate(pool); await configureRuntimeRole(pool, 'x'.repeat(48));
    await assert.rejects(assertRuntimeRole(pool));
    await query('SET ROLE member_app'); await assertRuntimeRole(pool);
    await assert.rejects(query('SELECT refresh_recovery_statistics()'), { code: '42501' });
    const session = await service.login({ username: 'owner', password, deviceId: randomUUID() }, '127.0.0.1');
    const identity = await service.authenticate(session.accessToken);
    assert.equal(identity.store_id, created.storeId);
    identity.ledgerEpoch = (await service.relational.getBook(identity)).ledgerEpoch;
    await service.relational.importOpeningBalances(identity, { ledgerEpoch: identity.ledgerEpoch, batchId: 'runtime-opening-20261119', sourceDigest: 'e'.repeat(64), expectedCount: 1,
      members: [{ id: 'runtime-v2-member', name: '导入客户', balanceCents: '-100' }] });
    const next = await service.createUser(identity, { username: 'clerk', password, displayName: '店员', role: 'clerk' });
    await service.updateUser(identity, next.id, { active: false, role: 'viewer' });
    const secret = 'runtime-signing-secret-' + randomUUID();
    await service.saveVoiceConfig(identity, { aligenie: { enabled: true, actorId: identity.id, token: secret, allowedDevices: ['runtime-device'] } }, 0);
    const preview = { requestId: randomUUID(), sessionId: 'runtime-session', utterance: '导入客户充值20元', context: { System: { device: { deviceOpenId: 'runtime-device' }, user: { userOpenId: 'runtime-user' } } } };
    const voice = body => { const timestamp = String(Date.now()); return service.handleAliGenieWebhook(body, { headers: { 'x-store-id': identity.store_id, 'x-aligenie-timestamp': timestamp, 'x-aligenie-signature': signAliGenieRequest(secret, timestamp, identity.store_id, body) } }); };
    await voice(preview);
    const confirmation = { ...preview, requestId: randomUUID(), utterance: '确认', confirmationRequestId: preview.requestId };
    assert.match((await voice(confirmation)).returnValue.reply, /充值成功/);
    assert.match((await voice(confirmation)).returnValue.reply, /充值成功/);
    await service.refresh(session.refreshToken);
    await service.auditLog(identity); await query('SELECT * FROM releases');
    await assert.rejects(voice({ ...preview, requestId:randomUUID(), context:{System:{device:{deviceOpenId:'candidate-device'},user:{userOpenId:'runtime-user'}}} }), { code:'VOICE_DEVICE_UNBOUND' });
    assert.equal((await service.getAliGenieDevices(identity))[0].deviceOpenId,'candidate-device');
    const relationalMember = await service.relational.createMember(identity, { name: '合成会员' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
    const relationalCommand = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: relationalMember.id, expectedAccountVersion: '0', actualPayCents: '100' };
    await service.relational.executeCommand(identity, relationalCommand);
    await service.relational.executeCommand(identity, relationalCommand);
    await service.relational.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: relationalMember.id, expectedAccountVersion: '1', originalEntryId: relationalCommand.id });
    await service.relational.listMembers(identity); await service.relational.listLedger(identity); await service.relational.changes(identity, { ledgerEpoch: identity.ledgerEpoch });
    await service.relational.archiveMember(identity, relationalMember.id, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
    await service.relational.updateConfiguration(identity, { expectedVersion: '0', services: [{ id: 'cut', name: '剪发', priceCents: '1010' }], rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
    assert.equal((await service.relational.getConfiguration(identity)).version, '1');
    const batchScope = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, actorId: identity.id, deviceId: identity.device_id };
    const batch = { ...batchScope, items: [{ id: randomUUID(), type: 'member.create', data: { name: '受限角色批次' } }, { id: randomUUID(), type: 'member.create', data: { name: '待取消' } }] };
    await service.relational.captureBatch(identity, batch);
    await service.relational.controlBatch(identity, { ...batchScope, state: 'active', expectedVersion: '0' });
    await service.relational.executeBatchItem(identity, batchScope, batch.items[0].id);
    await service.relational.controlBatch(identity, { ...batchScope, state: 'cancelled', expectedVersion: '1' });
    await assert.rejects(service.relational.executeBatchItem(identity, batchScope, batch.items[1].id), { code: 'BATCH_CANCELLED' });
    assert.equal((await service.relational.getBatch(identity, batchScope)).cancelledCount, 1);
    const exportJob = { id: randomUUID(), ledgerEpoch: identity.ledgerEpoch, from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' };
    assert.equal((await service.relational.queueLedgerExport(identity, exportJob)).state, 'queued');
    assert.equal((await service.relational.getLedgerExport(identity, exportJob)).id, exportJob.id);
    await assert.rejects(query('UPDATE ledger_export_jobs SET session_id=gen_random_uuid()'), { code: '42501' });
    await assert.rejects(query('TRUNCATE ledger_export_jobs'), { code: '42501' });
    assert.equal((await service.relational.discardLedgerExport(identity, exportJob.id, exportJob)).discarded, true);
    for (const table of ['application_batches', 'application_batch_items', 'application_batch_tags']) {
      await assert.rejects(query('DELETE FROM ' + table), { code: '42501' }); await assert.rejects(query('UPDATE ' + table + ' SET store_id=store_id'), { code: '42501' });
    }
    await assert.rejects(query('UPDATE application_batch_controls SET batch_id=batch_id'), { code: '42501' });
    await assert.rejects(query('DELETE FROM application_batch_controls'), { code: '42501' });
    await assert.rejects(query("UPDATE application_batch_controls SET state='active',version=3"), { code: '23514' });
    for (const table of ['consumption_items', 'payment_records', 'recharge_details']) { await assert.rejects(query('DELETE FROM ' + table), { code: '42501' }); await assert.rejects(query('UPDATE ' + table + ' SET entry_id=entry_id'), { code: '42501' }); }
    assert.equal((await service.relational.getMember(identity, relationalMember.id)).balanceCents, '0');
    for (const sql of ["UPDATE stores SET ledger_epoch=gen_random_uuid()", 'DELETE FROM ledger_entries', 'UPDATE ledger_entries SET delta_cents=1', 'UPDATE account_openings SET opening_balance_cents=0', "UPDATE ledger_command_receipts SET result='{}'", 'TRUNCATE store_changes', 'DELETE FROM application_task_receipts', "UPDATE application_task_receipts SET result='{}'", 'TRUNCATE application_task_receipts']) await assert.rejects(query(sql), { code: '42501' });
    for (const sql of ['CREATE TABLE forbidden(id int)', 'CREATE ROLE forbidden_role', 'CREATE DATABASE forbidden_db', 'DROP TABLE member_accounts', 'TRUNCATE member_accounts', 'DELETE FROM member_accounts', "UPDATE voice_requests SET response='{}'", 'TRUNCATE voice_dialogs', "UPDATE releases SET notes='forged'", 'GRANT "' + administrator.replaceAll('"', '""') + '" TO member_app', "COPY stores TO PROGRAM 'echo forbidden'"]) {
      await assert.rejects(query(sql), { code: '42501' });
    }
    await query('RESET ROLE');
    assert.equal((await query('SELECT count(*)::int AS count FROM stores')).rows[0].count, 1);
  } finally { await cleanup(); }
});
