import assert from 'node:assert/strict';

export async function verifyMemberTotals(api) {
  const max = 9223372036854775807n;
  const member = await api.create({ name: '精确累计合成会员', phone: '', notes: '', tags: [] });
  const charges = [], consumes = [];
  for (let i = 0; i < 3; i++) {
    charges.push(await api.command(member.id, 'recharge', { actualPayCents: String(max), giftCents: '0' }));
    consumes.push(await api.command(member.id, 'consume', { amountCents: String(max) }));
  }
  for (let i = 0; i < 25; i++) {
    const original = await api.command(member.id, 'recharge', { actualPayCents: '100', giftCents: '0' });
    await api.command(member.id, 'reverse', { originalEntryId: original.entryId });
  }
  await api.command(member.id, 'reverse', { originalEntryId: consumes[0].entryId });
  await api.command(member.id, 'reverse', { originalEntryId: charges[0].entryId });
  const expected = {
    grossRechargeCents: String(3n * max + 2500n),
    reversedRechargeCents: String(max + 2500n),
    grossConsumptionCents: String(3n * max),
    reversedConsumptionCents: String(max),
    netRechargeCents: String(2n * max),
    netConsumptionCents: String(2n * max)
  };
  assert.deepEqual(await api.totals(member.id), expected);
  const recent = await api.history(member.id);
  assert.equal(recent.items.length, 15);
  assert.ok(recent.nextCursor);
  const other = await api.create({ name: '另一位合成会员', phone: '', notes: '', tags: [] });
  await api.command(other.id, 'recharge', { actualPayCents: '50', giftCents: '0' });
  assert.deepEqual(await api.totals(member.id), expected);
  assert.equal((await api.totals(other.id)).netRechargeCents, '50');
  return { member, expected };
}
