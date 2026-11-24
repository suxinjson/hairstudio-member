import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function generator(seed) {
  let n = Math.imul(seed, 0x9e3779b9);
  return max => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return (n >>> 0) % max; };
}
const pick = (next, rows) => rows[next(rows.length)];
const key = (seed, step) => 'random-' + String(seed).padStart(6, '0') + '-' + String(step).padStart(3, '0');
const known = (...codes) => error => codes.includes(error.code);
const debt = error => /欠款/.test(error.message);

// The oracle uses its own integer arithmetic and records the intended state.
// It never calls a business rule, money parser or comparison from production.
export async function exerciseLedger(fixture, seed, steps, record) {
  const { scope } = fixture, next = generator(seed), entries = new Map(), originals = [], links = new Map(), taskIds = [], trace = [];
  const rows = Array.from({ length: 91 }, (_, i) => ({ id: 'synthetic-' + String(i).padStart(2, '0'),
    name: '合成会员 ' + i, balanceCents: String(i === 0 || i === 3 || i % 19 === 0 ? 0 : (i % 2 ? 1 : -1) * (1 + next(2000))) }));
  const people = rows.map(row => ({ ...row, accountVersion: '0', profileVersion: '0', balanceCents: BigInt(row.balanceCents), archived: false }));
  const opening = { ...scope, batchId: key(seed, 0), expectedCount: rows.length,
    sourceDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), members: rows };
  let config = { version: 0, giftEnabled: true, giftRateBasisPoints: 1000 };
  const sums = values => values.reduce((a, b) => a + b, 0n).toString();
  try {
    const amounts = rows.map(row => BigInt(row.balanceCents));
    function checkOpening(result) {
      assert.deepEqual([result.memberCount, result.netBalanceCents, result.positiveBalanceCents, result.negativeBalanceCents],
        [91, sums(amounts), sums(amounts.filter(n => n > 0n)), sums(amounts.filter(n => n < 0n))]);
    }
    const preview = await fixture.call('previewOpeningImport', opening); checkOpening(preview);
    checkOpening(await fixture.call('importOpeningBalances', { ...opening, payloadDigest: preview.payloadDigest }));
    if (seed % 20 === 1) assert.equal((await fixture.call('importOpeningBalances', opening)).alreadyImported, true);
    await fixture.checkOpenings(rows);

    for (let step = 1; step <= steps; step++) {
      const roll = next(16), person = people[next(4)], id = key(seed, step);
      // Ordered writes can have identical or backwards wall times. Financial
      // state still advances by account version, and time pages stay complete.
      const at = new Date(Date.UTC(2025, 0, 2) + (next(5) - 2) * 60000).toISOString();
      fixture.setTime(at);
      const label = { step, roll, member: person.id, at }; trace.push(label);
      if (roll === 11 || roll === 12 || roll === 13) {
        let request, expectedRejection;
        if (roll === 11) {
          request = { ...scope, id, type: 'member.archive', memberId: person.id, data: {} };
          if (person.archived) expectedRejection = known('MEMBER_ARCHIVED', 'WRITE_MEMBER_ARCHIVED');
          else if (person.balanceCents !== 0n) expectedRejection = known('BALANCE_NOT_ZERO', 'MEMBER_BALANCE_NOT_ZERO');
        } else if (roll === 12) {
          const stale = next(3) === 0;
          request = { ...scope, id, type: 'configuration.update', data: { expectedVersion: String(config.version + Number(stale)),
            services: [], rechargePlans: [], rechargeSettings: { giftEnabled: next(2) === 1, giftRateBasisPoints: next(10001) } } };
          if (stale) expectedRejection = known('CONFIGURATION_VERSION_CHANGED');
        } else {
          request = { ...scope, id, type: 'member.update', memberId: person.id, data: { name: '合成更名 ' + step, tags: ['已核对'], expectedVersion: person.profileVersion } };
          if (person.archived) expectedRejection = known('MEMBER_ARCHIVED', 'WRITE_MEMBER_ARCHIVED', 'MEMBER_VERSION_CHANGED');
        }
        label.request = request;
        if (expectedRejection) await assert.rejects(async () => fixture.call('executeTask', request), expectedRejection);
        else {
          const result = await fixture.call('executeTask', request); taskIds.push(id);
          if (roll === 11) { assert.equal(result.success, true); person.archived = true; }
          if (roll === 12) {
            config = { version: config.version + 1, ...request.data.rechargeSettings };
            assert.equal(result.version, String(config.version));
            assert.deepEqual(result.rechargeSettings, request.data.rechargeSettings);
          }
          if (roll === 13) person.name = request.data.name;
          if (roll !== 12) person.profileVersion = String(Number(person.profileVersion) + 1);
        }
        await fixture.inspect(person, id, null, expectedRejection ? null : request.type);
        record(expectedRejection ? 'task-rejected' : request.type);
      } else if ((roll === 8 || roll === 9) && originals.length) {
        const old = pick(next, [...entries.values()]), member = people.find(m => m.id === old.row.memberId);
        const request = roll === 8 ? old.request : { ...old.request, [old.request.type === 'reverse' ? 'reason' : 'remark']: '变更同号' };
        label.request = request;
        if (roll === 8) assert.deepEqual(await fixture.call('executeCommand', request), old.receipt);
        else await assert.rejects(async () => fixture.call('executeCommand', request), { code: 'COMMAND_CONFLICT' });
        await fixture.inspect(member, request.id, old.row);
        record(roll === 8 ? 'original-retry' : 'changed-retry');
      } else {
        const original = roll >= 5 && roll <= 7 && originals.length ? pick(next, originals) : null;
        const member = original ? people.find(m => m.id === original.memberId) : roll === 15 ? people[4] : person;
        const type = original ? 'reverse' : (roll % 2 === 0 && roll !== 14 || roll === 15) ? 'recharge' : 'consume';
        const request = { ...scope, id, type, memberId: member.id, expectedAccountVersion: String(Number(member.accountVersion) + Number(roll === 14)) };
        let delta, rejection, actual = 0n, gift = 0n;
        if (type === 'recharge') {
          actual = BigInt(1 + next(500)); gift = BigInt(roll === 15 || next(3) === 0 ? 0 : 1 + next(50));
          Object.assign(request, { actualPayCents: String(actual), giftCents: String(gift), configurationVersion: String(config.version) });
          delta = actual + gift;
          if (!config.giftEnabled && gift > 0n) rejection = known('GIFT_DISABLED');
        } else if (type === 'consume') {
          const amount = member.balanceCents > 0n && next(3) === 0 ? member.balanceCents : BigInt(1 + next(1700));
          Object.assign(request, { amountCents: String(amount), allowDebt: next(2) === 0 });
          delta = -amount;
        } else {
          Object.assign(request, { originalEntryId: original.id, allowDebt: next(2) === 0 });
          delta = -BigInt(original.deltaCents);
          if (links.has(original.id)) rejection = known('ALREADY_REVERSED');
        }
        const balance = member.balanceCents + delta;
        if (!rejection && member.archived && type !== 'reverse') rejection = known('MEMBER_ARCHIVED', 'WRITE_MEMBER_ARCHIVED');
        if (!rejection && roll === 14) rejection = known('ACCOUNT_VERSION_CHANGED');
        if (!rejection && type !== 'recharge' && balance < 0n && !request.allowDebt) rejection = debt;
        label.request = request;
        if (rejection) {
          await assert.rejects(async () => fixture.call('executeCommand', request), rejection);
          await fixture.inspect(member, id, null);
          record('financial-rejected');
          continue;
        }
        if (roll === 15) {
          fixture.failNextAudit();
          await assert.rejects(async () => fixture.call('executeCommand', request), /randomized audit failure/);
          await fixture.inspect(member, id, null);
          record('audit-rollback');
        }
        const row = { id, memberId: member.id, kind: original ? 'reversal' : type,
          accountVersion: String(Number(member.accountVersion) + 1), deltaCents: String(delta),
          balanceBeforeCents: String(member.balanceCents), balanceAfterCents: String(balance), actualPayCents: String(actual), giftCents: String(gift),
          originalEntryId: original?.id ?? null, occurredAt: at };
        let receipt;
        if (roll === 10) {
          // The caller never receives the submission result. Only the
          // persisted original can establish whether it committed.
          await fixture.call('executeCommand', request);
          receipt = await fixture.call('getCommand', id, scope);
          assert.deepEqual(await fixture.call('executeCommand', request), receipt);
          record('response-recovered');
        } else receipt = await fixture.call('executeCommand', request);
        assert.deepEqual([receipt.entryId, receipt.commandId, receipt.ledgerEpoch, receipt.storeId, receipt.memberId, receipt.type, receipt.accountVersion,
          receipt.deltaCents, receipt.balanceBeforeCents, receipt.balanceAfterCents, receipt.occurredAt],
        [id, id, scope.ledgerEpoch, scope.storeId, member.id, row.kind, row.accountVersion, row.deltaCents, row.balanceBeforeCents, row.balanceAfterCents, at]);
        if (member.archived) { member.archived = false; member.profileVersion = String(Number(member.profileVersion) + 1); }
        member.balanceCents = balance; member.accountVersion = row.accountVersion;
        entries.set(id, { row, request, receipt });
        if (original) links.set(original.id, id); else originals.push(row);
        await fixture.inspect(member, id, row);
        record(row.kind);
      }
    }
    await fixture.checkFinal({ people, rows, entries, links, taskIds, config });
  } catch (error) {
    error.scenario = { seed, step: trace.at(-1)?.step ?? 0, trace };
    throw error;
  }
}
