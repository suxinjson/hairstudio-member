import { applyFinancialCommand, createConsumption, createRecharge } from '../src/ledger-domain.js';
import { ApiError, digest } from './security.js';
import { readConfiguration } from './relational-sales.js';

const MAX_NAMED_CANDIDATES = 32;
const MAX_SHOWN_MATCHES = 4;
const AMOUNT_PREFIX = /(?:消费|扣款|扣除|结账|买单)\s*[-+\d零一二两三四五六七八九十百千万]/;
const fields = 'm.id,m.name,m.phone,m.profile_version,a.balance_cents::text,a.version AS account_version';
const members = 'member_profiles m JOIN member_accounts a ON a.store_id=m.store_id AND a.member_id=m.id';

export function voiceYuan(cents) {
  const amount = BigInt(cents), magnitude = amount < 0n ? -amount : amount;
  return (amount < 0n ? '-' : '') + String(magnitude / 100n) + '.' + String(magnitude % 100n).padStart(2, '0');
}

function serviceMatches(services, query) {
  if (!query) return [];
  const cleaned = query.toLowerCase();
  const exact = services.filter(service => service.name.toLowerCase() === cleaned);
  return exact.length ? exact : services.filter(service => {
    const name = service.name.toLowerCase();
    return name.includes(cleaned) || cleaned.includes(name);
  });
}

// SQL decides identity inside the tenant. A capped search never silently
// makes a single choice out of an incomplete set of results.
export function createRelationalVoice({ client, user, req, receiptId, executeCommand, language }) {
  const { cleanMemberQuery, stripMemberQuery, phoneFromUtterance, membersFromUtterance, parseVoiceCents, spokenAmountCandidate } = language;
  const { store_id: storeId, ledger_epoch: ledgerEpoch, id: actorId, device_id: deviceId } = user;

  async function matchSlot(raw) {
    if (!raw) return [];
    const query = cleanMemberQuery(raw), literal = stripMemberQuery(raw), digits = query.replace(/\D/g, '');
    const tail = /^[0-9]{3,8}$/.test(query) || query.includes('尾号') && /^[0-9]{3,8}$/.test(digits);
    const { rows } = await client.query(`WITH candidates AS (
      SELECT ` + fields + `,CASE
        WHEN m.name=$2 THEN 1 WHEN $3<>$4 AND m.name=$3 THEN 2
        WHEN length($5)=11 AND replace(m.phone_normalized,'+','')=$5 THEN 3
        WHEN $6::boolean AND right(replace(m.phone_normalized,'+',''),length($5))=$5 THEN 4
        WHEN $4<>'' AND m.name=$4 THEN 5
        WHEN $4<>'' AND (strpos(m.name,$4)>0 OR strpos($4,m.name)>0) THEN 6
        WHEN length($5)>=4 AND strpos(replace(m.phone_normalized,'+',''),$5)>0 THEN 7
        END AS rank FROM ` + members + `
      WHERE m.store_id=$1 AND m.archived_at IS NULL)
      SELECT * FROM candidates WHERE rank IS NOT NULL ORDER BY rank,id LIMIT ` + MAX_SHOWN_MATCHES,
    [storeId, raw, literal, query, digits, tail]);
    return rows.filter(row => row.rank === rows[0].rank);
  }

  async function findMembers() {
    const { utterance, slots } = req;
    if (utterance.length > 512 || (slots.member || '').length > 128 || (slots.service || '').length > 128) {
      throw new ApiError(400, '语音指令过长，请缩短会员或服务名称');
    }
    if (slots.member) {
      const matches = await matchSlot(slots.member);
      return { matches, names: matches };
    }
    if (!utterance) return { matches: [], names: [] };
    const { rows } = await client.query('SELECT ' + fields + ' FROM ' + members +
      ' WHERE m.store_id=$1 AND m.archived_at IS NULL AND strpos($2,m.name)>0 ORDER BY length(m.name) DESC,m.id LIMIT ' + (MAX_NAMED_CANDIDATES + 1), [storeId, utterance]);
    if (rows.length > MAX_NAMED_CANDIDATES) return { matches: [], names: [], tooMany: true };
    const names = membersFromUtterance(rows, utterance);
    return { names, matches: names.length ? names : await matchSlot(phoneFromUtterance(utterance)) };
  }

  async function accountSummary(memberId) {
    const { rows: [row] } = await client.query(`SELECT m.name,m.notes,a.balance_cents::text,
      (SELECT e.occurred_at FROM ledger_entries e WHERE e.store_id=m.store_id AND e.member_id=m.id AND e.kind='consume'
        AND NOT EXISTS (SELECT 1 FROM ledger_reversals r WHERE r.store_id=e.store_id AND r.original_entry_id=e.entry_id)
        ORDER BY e.occurred_at DESC,e.entry_id DESC LIMIT 1) AS last_visit,
      (SELECT COALESCE(sum(e.delta_cents::numeric),0)::text FROM ledger_entries e WHERE e.store_id=m.store_id AND e.member_id=m.id AND e.kind='recharge'
        AND NOT EXISTS (SELECT 1 FROM ledger_reversals r WHERE r.store_id=e.store_id AND r.original_entry_id=e.entry_id)) AS recharge_cents
      FROM ` + members + ' WHERE m.store_id=$1 AND m.id=$2 AND m.archived_at IS NULL', [storeId, memberId]);
    return row || null;
  }

  async function prepare(action, member) {
    const { slots, utterance } = req;
    const spoken = slots.amount ?? spokenAmountCandidate(utterance, member.name);
    let amountCents = parseVoiceCents(spoken), selected = null;
    if (amountCents === '0') amountCents = null;
    const remaining = utterance.replaceAll(member.name, '');
    if (!amountCents && (action === 'recharge' || slots.amount !== undefined || AMOUNT_PREFIX.test(remaining))) return { askAmount: true };
    const configuration = await readConfiguration(client, storeId, { lock: true });
    if (action === 'consume' && (slots.service || !amountCents)) {
      const matches = serviceMatches(configuration.services, slots.service || remaining);
      if (matches.length === 1) selected = matches[0];
      if (!amountCents && matches.length > 1) return { askService: true };
      if (!amountCents && selected?.priceCents !== '0') amountCents = selected?.priceCents;
    }
    if (!amountCents) return { askAmount: true };

    const command = { id: 'voice-' + digest(receiptId), type: action, storeId, ledgerEpoch, actorId, deviceId, memberId: member.id,
      expectedAccountVersion: String(member.account_version), configurationVersion: configuration.version };
    const consumptionLabel = selected?.name || slots.service || '消费';
    const before = BigInt(member.balance_cents);
    let after;
    if (action === 'consume') {
      Object.assign(command, { amountCents, itemsSummary: consumptionLabel, remark: '天猫精灵语音扣款', allowDebt: before < BigInt(amountCents),
        items: [{ ...(selected?.priceCents === amountCents ? { serviceId: selected.id } : {}), name: consumptionLabel, quantity: 1, unitPriceCents: amountCents }] });
      try { after = applyFinancialCommand(member.balance_cents, createConsumption(command)).balanceAfterCents; }
      catch (error) { return { businessError: error.message }; }
    } else {
      const policy = configuration.rechargeSettings;
      const giftCents = slots.giftAmount === undefined
        ? String(policy.giftEnabled ? (BigInt(amountCents) * BigInt(policy.giftRateBasisPoints) + 5000n) / 10000n : 0n)
        : parseVoiceCents(slots.giftAmount);
      if (giftCents === null) return { businessError: '赠送金额无效，请重新报金额' };
      if (!policy.giftEnabled && giftCents !== '0') return { businessError: '充值赠送已关闭，请重新报金额' };
      Object.assign(command, { actualPayCents: amountCents, giftCents, payments: [{ method: '语音充值', amountCents }], remark: '天猫精灵语音充值' });
      try { after = applyFinancialCommand(member.balance_cents, createRecharge(command)).balanceAfterCents; }
      catch (error) { return { businessError: error.message }; }
    }
    return { command, expectedProfileVersion: String(member.profile_version), before, after, label: consumptionLabel };
  }

  return { findMembers, accountSummary, prepare, execute: pending => executeCommand(client, user, pending.command, pending) };
}
