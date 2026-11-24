import { randomUUID } from 'node:crypto';

export async function seedVoiceBook(service, identity, members, services = [], giftRateBasisPoints = 1000) {
  const ledger = service.relational;
  const { ledgerEpoch } = await ledger.getBook(identity);
  const scope = { ledgerEpoch, storeId: identity.store_id };
  await ledger.importOpeningBalances(identity, {
    ledgerEpoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: members.length,
    members: members.map(member => ({ phone: '', tags: [], notes: '', ...member }))
  });
  await ledger.updateConfiguration(identity, {
    expectedVersion: '0', services, rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints }
  }, { ...scope, id: randomUUID() });
  return {
    async command(memberId, type, fields) {
      const { accountVersion } = await ledger.getMember(identity, memberId, scope);
      return ledger.executeCommand(identity, { ...scope, id: randomUUID(), memberId, type, expectedAccountVersion: accountVersion, ...fields });
    },
    async snapshot() { return voiceSnapshot(service, identity); }
  };
}

export async function voiceSnapshot(service, identity) {
  const ledger = service.relational;
  const scope = await ledger.getBook(identity);
  const members = (await ledger.listMembers(identity, scope)).items;
  const entries = (await ledger.listLedger(identity, scope)).items;
  return { members, entries };
}
