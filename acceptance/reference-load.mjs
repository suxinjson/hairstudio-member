import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const money = /^(0|-?[1-9][0-9]{0,30})$/;
const counter = /^(0|[1-9][0-9]{0,29})$/;
const tagPattern = /^[a-z0-9]{6,24}$/;
const warmup = ['warmup', 300, 20];
const recovered = ['recovery', 60, 20];
const profiles = {
  smoke: { stores: 1, members: 0, entries: 0, phases: [['smoke', 6, 5]] },
  steady: { stores: 1, members: 1000, entries: 100000, phases: [warmup, ['steady', 1800, 20]] },
  burst40: { stores: 1, members: 1000, entries: 100000, phases: [warmup, ['burst', 300, 40], recovered] },
  burst100: { stores: 1, members: 1000, entries: 100000, phases: [warmup, ['burst', 300, 100], recovered] },
  soak: { stores: 1, members: 1000, entries: 100000, phases: [warmup, ['soak', 14400, 20]] },
  d2: { stores: 1, members: 10000, entries: 1000000, phases: [['d2', 300, 20]] },
  d3: { stores: 20, members: 500, entries: 10000, phases: [['d3', 300, 20]] }
};
const mix = ['members','ledger','search','write','members','ledger','report','write','members','ledger',
  'sync','search','members','ledger','write','audit','recent','search','ledger','write'];
const mixKinds = new Set(mix).size;
const echoableCode = /^[A-Z][A-Z0-9_]{1,48}$/;
const tick = 10, maxInFlight = 48, drainAt = 15000;

class LoadError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; Object.assign(this, details); }
}
function check(condition, code) { if (!condition) throw new LoadError(code); }
const validInstant = v => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const isUUID = v => typeof v === 'string' && uuid.test(v);
const integerString = (v, pattern) => typeof v === 'string' && pattern.test(v);
const localOnly = h => h === 'localhost' || h === '[::1]' || /^127\./.test(h) && isIP(h) === 4;
const cause = e => e instanceof LoadError ? e.code : 'DRIVER_ERROR';
function fields(object, names) {
  return !!object && !Array.isArray(object) && typeof object === 'object' && Object.keys(object).every(key => names.includes(key));
}

export function prepare(input, { env = process.env, now = Date.now(), addresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(n => n.address) } = {}) {
  check(env.MEMBER_REFERENCE_LOAD_ISOLATED === '1' && env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'ISOLATED_HTTPS_REQUIRED');
  check(fields(input, ['origin','profile','tag','sourceDigest','fixtureFrom','fixtureTo','clients']), 'INVALID_PLAN_FIELDS');
  check(typeof input.origin === 'string' && /^https:\/\/[^/?#@%\\\s]+$/.test(input.origin), 'INVALID_ORIGIN');
  let target;
  try { target = new URL(input.origin); } catch { throw new LoadError('INVALID_ORIGIN'); }
  check(target.origin === input.origin && target.protocol === 'https:', 'INVALID_ORIGIN');
  check(Object.hasOwn(profiles, input.profile) && (input.profile === 'smoke' || !localOnly(target.hostname)), 'INVALID_PROFILE');
  check(typeof input.tag === 'string' && tagPattern.test(input.tag) && typeof input.sourceDigest === 'string' && /^[0-9a-f]{64}$/.test(input.sourceDigest), 'INVALID_TAG_OR_SOURCE');
  check(validInstant(input.fixtureFrom) && validInstant(input.fixtureTo) && Date.parse(input.fixtureFrom) <= now && Date.parse(input.fixtureTo) >= now + 5 * 3600000, 'INVALID_FIXTURE_PERIOD');
  const profile = profiles[input.profile];
  check(Array.isArray(input.clients) && input.clients.length >= 1 && input.clients.length <= 100, 'INVALID_CLIENT_COUNT');
  const ids = new Set(), names = new Set(), devices = new Set(), members = new Set(), stores = new Map();
  const clients = input.clients.map((row, index) => {
    check(fields(row, ['sourceAddress','username','passwordEnv','deviceId','storeId','ledgerEpoch','storeKey','memberId']), 'INVALID_CLIENT_FIELDS');
    check(isUUID(row.storeId) && isUUID(row.ledgerEpoch) && isUUID(row.deviceId) && typeof row.storeKey === 'string' && /^[0-9]{2}$/.test(row.storeKey), 'INVALID_CLIENT_SCOPE');
    const prefix = 'refqa-' + input.tag + '-' + row.storeKey;
    check(typeof row.username === 'string' && row.username.startsWith(prefix + '-') && /^[a-z0-9-]{3,64}$/.test(row.username), 'INVALID_SYNTHETIC_USERNAME');
    check(typeof row.memberId === 'string' && row.memberId.startsWith(prefix + '-') && /^[a-z0-9-]{6,90}$/.test(row.memberId), 'INVALID_SYNTHETIC_MEMBER');
    check(typeof row.passwordEnv === 'string' && /^MEMBER_REF_PASSWORD_[A-Z0-9_]{1,40}$/.test(row.passwordEnv) && typeof env[row.passwordEnv] === 'string' && env[row.passwordEnv].length >= 12, 'PASSWORD_ENV_REQUIRED');
    check(row.sourceAddress === undefined || (typeof row.sourceAddress === 'string' && !!isIP(row.sourceAddress) && addresses.includes(row.sourceAddress)), 'SOURCE_ADDRESS_NOT_LOCAL');
    check(!names.has(row.username) && !devices.has(row.deviceId) && !members.has(row.memberId), 'DUPLICATE_CLIENT');
    names.add(row.username); devices.add(row.deviceId); members.add(row.memberId);
    if (!stores.has(row.storeId)) {
      check(!ids.has(prefix), 'DUPLICATE_STORE_MARKER'); ids.add(prefix);
      stores.set(row.storeId, { prefix, storeId: row.storeId, ledgerEpoch: row.ledgerEpoch, committed: 0 });
    }
    const store = stores.get(row.storeId);
    check(store.prefix === prefix && store.ledgerEpoch === row.ledgerEpoch, 'INCONSISTENT_STORE_SCOPE');
    return { ...row, store, index, committed: 0, cursor: '0', pending: null, writing: false };
  });
  check(stores.size === profile.stores, 'INVALID_STORE_COUNT');
  const bindings = new Map();
  for (const client of clients) {
    const address = client.sourceAddress ?? 'default';
    bindings.set(address, (bindings.get(address) ?? 0) + 1);
  }
  if (input.profile !== 'smoke') {
    // The proxy must see separate egress addresses. Leave headroom for refreshes.
    check(clients.length >= 12 && !bindings.has('default') && Math.max(...bindings.values()) / clients.length * 1200 <= 170, 'INSUFFICIENT_INGRESS_DIVERSITY');
  }
  return { target, profile, name: input.profile, clients, stores, bindings, tag: input.tag, sourceDigest: input.sourceDigest,
    period: { from: input.fixtureFrom, to: input.fixtureTo } };
}

function transport(target, lane, agents) {
  const source = lane.sourceAddress;
  if (!agents.has(source)) agents.set(source, new Agent({ keepAlive: true, maxSockets: maxInFlight, localAddress: source }));
  return (path, body, auth = true) => new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(drainAt), uri = new URL(path, target);
    check(uri.origin === target.origin && uri.pathname.startsWith('/api/'), 'INVALID_ROUTE');
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request(uri, { agent: agents.get(source), localAddress: source, signal, rejectUnauthorized: true, method: data === null ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(auth && { Authorization: 'Bearer ' + lane.access }),
        ...(data !== null && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, res => {
      let length = 0; const chunks = [];
      const requestId = isUUID(res.headers['x-request-id']) ? res.headers['x-request-id'] : undefined;
      res.on('data', bytes => {
        length += bytes.length;
        if (length > 2 * 1024 * 1024) { reject(new LoadError('RESPONSE_LIMIT', { requestId })); res.destroy(); }
        else chunks.push(bytes);
      });
      res.on('error', () => reject(new LoadError(signal.aborted ? 'TIMEOUT' : 'TRANSPORT', { requestId })));
      res.on('end', () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks)); } catch { /* non-JSON proxy response */ }
        if (res.statusCode !== 200) {
          const apiCode = typeof payload?.code === 'string' && echoableCode.test(payload.code) ? payload.code : undefined;
          reject(new LoadError('HTTP_' + res.statusCode, { status: res.statusCode, apiCode, requestId }));
        } else if (!payload || typeof payload !== 'object') reject(new LoadError('INVALID_RESPONSE', { requestId }));
        else resolve(payload);
      });
    });
    req.on('error', () => reject(new LoadError(signal.aborted ? 'TIMEOUT' : 'TRANSPORT')));
    req.end(data);
  });
}

const query = (lane, path, params = {}) => lane.call('/api/v2/' + path + '?' + new URLSearchParams({ ledgerEpoch: lane.ledgerEpoch, ...params }));
function session(lane, reply) {
  const expiry = Date.parse(reply.expiresAt), role = reply.user?.role;
  check(reply.user?.storeId === lane.storeId && reply.user?.username === lane.username && role === 'owner' && reply.storeProfile?.name === lane.store.prefix, 'WRONG_SYNTHETIC_LOGIN');
  check(typeof reply.accessToken === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(reply.accessToken) && typeof reply.refreshToken === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(reply.refreshToken) && expiry > Date.now() + 60000, 'INVALID_TEST_SESSION');
  lane.access = reply.accessToken; lane.refresh = reply.refreshToken; lane.refreshAt = expiry - 120000;
}
async function refresh(lane) { session(lane, await lane.call('/api/v1/auth/refresh', { refreshToken: lane.refresh }, false)); }
const scoped = (row, lane) => row.storeId === lane.storeId && row.ledgerEpoch === lane.ledgerEpoch;
const synthetic = (id, name, lane) => typeof id === 'string' && id.startsWith(lane.store.prefix + '-') && typeof name === 'string' && name.startsWith(lane.store.prefix + '-');
function member(value, lane) {
  check(value.id === lane.memberId && synthetic(value.id, value.name, lane) && integerString(value.balanceCents, money) && integerString(value.accountVersion, counter), 'INVALID_TEST_MEMBER');
  return { balance: value.balanceCents, version: value.accountVersion };
}
function totals(row, plan) {
  check(Number.isInteger(row.memberCount) && Number.isInteger(row.entryCount) && row.entryCount >= plan.profile.entries && row.memberCount > 0 &&
    (!plan.profile.members || row.memberCount === plan.profile.members) && [row.actualPayCents, row.netChangeCents, row.giftCents, row.consumptionCents, row.reversalDeltaCents].every(v => integerString(v, money)), 'INVALID_TEST_FIXTURE');
  return { members: row.memberCount, entries: row.entryCount, paid: row.actualPayCents, net: row.netChangeCents, gift: row.giftCents, consumed: row.consumptionCents, reversed: row.reversalDeltaCents };
}

export function verifyReceipt(lane, input, value) {
  const changed = String(BigInt(lane.balance) + 2n), version = String(BigInt(input.expectedAccountVersion) + 1n);
  check(scoped(value, lane) && value.type === 'recharge' && value.commandId === input.id && value.entryId === input.id && value.memberId === lane.memberId &&
    value.deltaCents === '2' && value.balanceBeforeCents === lane.balance && value.balanceAfterCents === changed && value.accountVersion === version &&
    validInstant(value.occurredAt) && integerString(value.cursor, counter), 'RECEIPT_MISMATCH');
  lane.balance = changed; lane.version = version; lane.committed++; lane.store.committed++; lane.pending = null;
}

function acceptedThrottle(error) {
  return error.status === 429 && error.apiCode === 'RATE_LIMITED' ? 'rateLimited' : error.status === 503 && error.apiCode === 'SERVER_BUSY' ? 'serverBusy' : null;
}
function compactError(error) { return { code: cause(error), ...(error.apiCode && { apiCode: error.apiCode }), ...(error.requestId && { requestId: error.requestId }) }; }

async function callMix(kind, lane, { range, journal, isSmoke }) {
  if (kind === 'write') {
    const command = { id: randomUUID(), storeId: lane.storeId, ledgerEpoch: lane.ledgerEpoch, memberId: lane.memberId, type: 'recharge', expectedAccountVersion: lane.version, actualPayCents: '2' };
    await journal({ event: 'original', lane: lane.index, command });
    lane.pending = command;
    const start = performance.now();
    try { verifyReceipt(lane, command, await lane.call('/api/v2/commands', command)); }
    catch (error) { if (acceptedThrottle(error)) lane.pending = null; throw error; }
    return performance.now() - start;
  }
  const start = performance.now();
  if (kind === 'sync') {
    const row = await query(lane,'sync/changes',{after:lane.cursor,limit:25});
    check(scoped(row, lane) && Array.isArray(row.items) && integerString(row.cursor,counter) && BigInt(row.cursor) >= BigInt(lane.cursor), 'SYNC_SCOPE_MISMATCH');
    lane.cursor = row.cursor;
  } else if (kind === 'audit') {
    const row = await lane.call('/api/v1/activity?limit=25');
    check(Array.isArray(row) && row.length <= 25, 'INVALID_TEST_AUDIT');
  } else if (kind === 'report') {
    const row = await query(lane,'reports/business',{...range,offsetMinutes:480});
    check(row.balances?.memberCount === lane.store.before.members && row.from === range.from && row.to === range.to, 'REPORT_SCOPE_MISMATCH');
  } else {
    const ledger = kind === 'ledger';
    const rows = await query(lane,ledger?'ledger':'members',{limit:25,...(kind==='search'?{search:lane.store.prefix}:kind==='recent'?{balance:'recent'}:{})});
    check(Array.isArray(rows.items) && rows.items.length <= 25 && (rows.items.length > 0 || ledger && isSmoke) && rows.items.every(r => synthetic(ledger?r.memberId:r.id,ledger?r.memberName:r.name,lane)), 'PAGE_SCOPE_MISMATCH');
  }
  return performance.now() - start;
}

function distribution(samples) {
  samples.sort((a,b)=>a-b);
  const at = p => Math.round(samples[Math.ceil(p*samples.length)-1]*10)/10;
  return { count:samples.length, p50:at(.5), p95:at(.95), p99:at(.99) };
}

async function phase(plan, [name, seconds, rate], hooks) {
  const start = performance.now(), scheduled = seconds * rate, active = new Set(), next = new Map(), tim = new Map(), errors = {}, missedBy = {};
  const slots = name === 'recovery' ? Array.from({length:seconds},()=>0) : null;
  let done = 0, sent = 0, ok = 0, peak = 0, sampleAt = 60, refreshJob;
  const miss = (kind, n = 1) => { missedBy[kind] = (missedBy[kind] ?? 0) + n; };
  while (!hooks.stopped() && done < scheduled) {
    const elapsed = (performance.now()-start)/1000, due = Math.min(scheduled,Math.floor(elapsed*rate));
    if (due - done > rate) { miss('scheduler', due - done - rate); done = due - rate; }
    if (!refreshJob && plan.clients.some(lane=>lane.refreshAt <= Date.now())) refreshJob = (async()=>{
      for (const lane of plan.clients) if (lane.refreshAt <= Date.now()) await refresh(lane);
    })().catch(error=>hooks.fail('SESSION_REFRESH', error)).finally(()=>{refreshJob=undefined;});
    while (done < due && !hooks.stopped()) {
      const ordinal=done++, kind=mix[ordinal%mix.length], index=next.get(kind) ?? 0, lane=plan.clients[index%plan.clients.length];
      next.set(kind,index+1);
      const locking=kind==='write'?'writing':kind==='sync'?'syncing':null;
      if (active.size >= maxInFlight) { miss('clientCapacity'); continue; }
      if (locking && (lane[locking] || kind==='write' && lane.pending)) { miss('laneUnavailable'); continue; }
      if (locking) lane[locking]=true;
      sent++;
      const work=callMix(kind,lane,hooks).then(ms=>{
        ok++; if (slots) slots[Math.floor(ordinal/rate)]++;
        if (!tim.has(kind)) tim.set(kind,[]); tim.get(kind).push(ms);
      }).catch(error=>{
        const code=acceptedThrottle(error) ?? [cause(error),error.apiCode].filter(Boolean).join(':');
        errors[code]=(errors[code]??0)+1;
        if (lane.pending && kind==='write' || /(?:SCOPE_MISMATCH|INVALID_TEST|DRIVER_ERROR)/.test(cause(error))) hooks.fail(kind,error);
      }).finally(()=>{ active.delete(work); if (locking) lane[locking]=false; });
      active.add(work); peak=Math.max(peak,active.size);
    }
    if (elapsed >= sampleAt) { sampleAt+=60; await hooks.log({phase:name,elapsedSeconds:Math.floor(elapsed),plannedSoFar:done,sent,ok,peak,missedBy,errors,rss:process.memoryUsage().rss}); }
    if (done<scheduled && !hooks.stopped()) await delay(tick);
  }
  await Promise.all([...active,refreshJob]);
  if (scheduled>done) miss('stopped',scheduled-done);
  const timings = Object.fromEntries([...tim].map(([kind,ms])=>[kind,distribution(ms)]));
  const unexpected = Object.keys(errors).some(key=>!['burst','recovery'].includes(name) || !['rateLimited','serverBusy'].includes(key));
  const latencyOk = Object.entries(timings).every(([kind,m])=>m.p95 <= (kind==='write'?300:name==='d2'?(kind==='report'?2000:500):200) && (name==='d2'||m.p99<=1000));
  const passed = !unexpected && (name==='burst' ? sent===scheduled && ok>0 : name==='recovery' ? slots.slice(-10).every(count=>count===rate) && latencyOk :
    sent===scheduled && ok===scheduled && Object.keys(timings).length===mixKinds && (latencyOk || name==='smoke'));
  const row = {phase:name,seconds,rate,scheduled,sent,ok,peak,missedBy,errors,timings,latencyOk,passed,...(slots && {successesByScheduledSecond:slots})};
  await hooks.log(row); return row;
}

async function run(plan, output) {
  const agents=new Map(), started=new Date(), evidence={schemaVersion:1,profile:plan.name,tag:plan.tag,origin:plan.target.origin,sourceDigest:plan.sourceDigest,
    node:process.version,startedAt:started.toISOString(),sourceBindings:plan.bindings.size,clients:plan.clients.length,
    toolSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    scope:'HTTPS workload evidence only; resource, security, fault and Android evidence still required',status:'investigate',phases:[],issues:[],confirmedAfterResponseLoss:0};
  const stamp=row=>JSON.stringify({at:new Date().toISOString(),...row})+'\n';
  const log=row=>appendFile(join(output,'timeline.ndjson'),stamp(row));
  const journal=row=>appendFile(join(output,'write-originals.ndjson'),stamp(row),{mode:0o600});
  let stop=false, ready=false;
  const interrupted=()=>{ stop=true; if (evidence.issues.length<20) evidence.issues.push({code:'INTERRUPTED'}); };
  const fail=(stage,e)=>{ stop=true; if (evidence.issues.length<20) evidence.issues.push({stage,...compactError(e)}); };
  const range={from:new Date(+started-7*86400000).toISOString(),to:new Date(+started+86400000).toISOString()};
  process.on('SIGINT',interrupted); process.on('SIGTERM',interrupted);
  try {
    for (const lane of plan.clients) {
      if (stop) break;
      lane.call=transport(plan.target,lane,agents);
      session(lane,await lane.call('/api/v1/auth/login',{username:lane.username,password:process.env[lane.passwordEnv],deviceId:lane.deviceId},false));
      check(scoped(await lane.call('/api/v2/book'),lane),'BOOK_SCOPE_MISMATCH');
      Object.assign(lane,member(await query(lane,'members/'+lane.memberId),lane));
      const sync=await query(lane,'sync/changes',{after:'0',limit:1});
      check(scoped(sync,lane) && integerString(sync.head,counter),'SYNC_SCOPE_MISMATCH'); lane.cursor=sync.head;
      lane.store.first ??= lane;
    }
    check(!stop,'PREFLIGHT_STOPPED');
    for (const store of plan.stores.values()) store.before=totals(await query(store.first,'reports/summary',plan.period),plan);
    ready=true;
    for (const p of plan.profile.phases) {
      if (stop) break;
      evidence.phases.push(await phase(plan,p,{stopped:()=>stop,fail,log,journal,range,isSmoke:plan.name==='smoke'}));
      if (!evidence.phases.at(-1).passed && p[0]==='warmup') break;
    }
  } catch(e) { fail(ready?'workload':'preflight',e); }
  if (ready) {
    // This wait is for final reads only; it is not part of the recovery result.
    if (evidence.phases.some(p=>p.errors.rateLimited || p.errors.serverBusy)) await delay(61000);
    for (const lane of plan.clients) {
      try {
        if (lane.refreshAt <= Date.now()) await refresh(lane);
        const original=lane.pending;
        if (original) {
          verifyReceipt(lane,original,await query(lane,'commands/'+original.id));
          evidence.confirmedAfterResponseLoss++;
        }
        const now=member(await query(lane,'members/'+lane.memberId),lane);
        check(now.version===lane.version && now.balance===lane.balance,'ACCOUNT_DIVERGED');
      } catch(e) { fail('member-reconciliation',e); }
    }
    evidence.stores=[];
    for (const store of plan.stores.values()) {
      try {
        const after=totals(await query(store.first,'reports/summary',plan.period),plan), before=store.before, delta=2n*BigInt(store.committed);
        check(after.entries===before.entries+store.committed && after.members===before.members && after.net===String(BigInt(before.net)+delta) &&
          after.paid===String(BigInt(before.paid)+delta) && after.gift===before.gift && after.consumed===before.consumed && after.reversed===before.reversed,'STORE_TOTAL_DIVERGED');
        evidence.stores.push({marker:store.prefix,memberCount:after.members,entriesBefore:before.entries,entriesAfter:after.entries,confirmedWrites:store.committed});
      } catch(e) { fail('store-reconciliation',e); }
    }
  }
  for (const agent of agents.values()) agent.destroy();
  process.off('SIGINT',interrupted); process.off('SIGTERM',interrupted);
  evidence.pending=plan.clients.filter(lane=>lane.pending).map(lane=>lane.pending.id);
  evidence.finishedAt=new Date().toISOString();
  if (ready && !evidence.issues.length && !evidence.pending.length && evidence.phases.length===plan.profile.phases.length && evidence.phases.every(p=>p.passed)) evidence.status='pass-workload';
  await writeFile(join(output,'summary.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  return evidence.status;
}

async function main() {
  check(process.argv.length===3,'USAGE_REFERENCE_LOAD_PLAN_JSON');
  const planFile=process.argv[2], bytes=[]; let length=0;
  for await (const chunk of createReadStream(planFile)) { length+=chunk.length; check(length<=65536,'PLAN_SIZE_LIMIT'); bytes.push(chunk); }
  let input;
  try { input=JSON.parse(Buffer.concat(bytes)); } catch { throw new LoadError('INVALID_PLAN_JSON'); }
  const plan=prepare(input), out=resolve('output','refactor-v2','reference-load');
  await mkdir(out,{recursive:true});
  const output=join(out,new Date().toISOString().replace(/[-:.]/g,'')+'-'+plan.name+'-'+randomUUID());
  await mkdir(output,{mode:0o700});
  const status=await run(plan,output);
  console.log(JSON.stringify({output,status}));
  if (status!=='pass-workload') process.exitCode=1;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{ console.error(cause(error)); process.exitCode=1; });
