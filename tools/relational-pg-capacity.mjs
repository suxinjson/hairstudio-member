import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/http.js';
import { createService } from '../server/tests/helpers/licensed-service.js';
import { relationalTestDatabase } from '../server/tests/helpers/relational-database.js';
import { refactorSources } from './refactor-source.mjs';

const [dataset, mode, extra] = process.argv.slice(2);
const sizes = { d1: [1, 1000, 100], d2: [1, 10000, 100], d3: [20, 500, 20] };
if (!Object.hasOwn(sizes, dataset) || !['probe', 'sample', 'steady', 'soak', 'burst2', 'burst5'].includes(mode) || extra) throw Error('Usage: relational-pg-capacity.mjs d1|d2|d3 probe|sample|steady|soak|burst2|burst5');
const url = new URL(process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL || 'about:blank');
if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^member_[a-z_]*test(_[a-z0-9_]+)?$/.test(url.pathname.slice(1)) || process.env.MEMBER_TEST_DATABASE_DISPOSABLE !== '1') throw Error('Requires a disposable loopback member_*test database');
const [stores, members, versions] = sizes[dataset], seedEntries = stores * members * versions;
const root = fileURLToPath(new URL('../', import.meta.url)), startedAt = new Date().toISOString();
const id = startedAt.replace(/[-:.]/g, '') + '-pg-' + dataset + '-' + mode, dir = new URL('../output/refactor-v2/' + id + '/', import.meta.url);
await mkdir(dir, { recursive: true });
const write = (name, value) => writeFile(new URL(name, dir), JSON.stringify(value, null, 2) + String.fromCharCode(10));
const log = value => appendFile(new URL('timeline.ndjson', dir), JSON.stringify({ at: new Date().toISOString(), ...value }) + String.fromCharCode(10));
const source = await refactorSources(root); await write('source-manifest.json', source.manifest);
const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
const date = days => new Date(+midnight - days * 86400000).toISOString();
const memberId = n => 'capacity-' + String(n).padStart(5, '0');
const data = new Map(), plans = new Map(), clients = [], phases = [], outcomes = {};
let pool, database, server, origin, writes = 0, stopping = false, env = {}, result, code = 1;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
function metric(kind, ms) { if (!data.has(kind)) data.set(kind, []); data.get(kind).push(ms); }
function resource() { return { ...process.memoryUsage(), poolWaiting: pool.waitingCount, poolIdle: pool.idleCount, poolTotal: pool.totalCount, eventLoopP99Ms: loop.percentile(.99 * 100) / 1e6 }; }
async function seed(store, actor, device, marker) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL statement_timeout=600000');
    await c.query("INSERT INTO member_profiles(store_id,id,name,notes,created_at) SELECT $1,'capacity-'||lpad(i::text,5,'0'),$4::text||i,CASE WHEN i%100=0 THEN '样本备注' ELSE '' END,$3::timestamptz FROM generate_series(1,$2::int) i", [store,members,date(versions+1),marker]);
    await c.query('INSERT INTO member_accounts(store_id,member_id,balance_cents,version) SELECT store_id,id,$2::bigint*50,$2::bigint FROM member_profiles WHERE store_id=$1',[store,versions]);
    await c.query("INSERT INTO ledger_entries(store_id,entry_id,member_id,kind,account_version,delta_cents,balance_before_cents,balance_after_cents,actual_pay_cents,pay_method,items_summary,actor_id,device_id,occurred_at) " +
      "SELECT $1,'capacity-'||lpad(i::text,5,'0')||'-'||v,'capacity-'||lpad(i::text,5,'0'),CASE WHEN v%2=1 THEN 'recharge' ELSE 'consume' END,v," +
      "CASE WHEN v%2=1 THEN 125 ELSE -25 END,(v-1)/2*100+CASE WHEN v%2=0 THEN 125 ELSE 0 END,v/2*100+CASE WHEN v%2=1 THEN 125 ELSE 0 END," +
      "CASE WHEN v%2=1 THEN 125 ELSE 0 END,CASE WHEN v%2=1 THEN '现金' ELSE '' END,CASE WHEN v%2=0 THEN '合成服务' ELSE '' END,$5,$6," +
      "$4::timestamptz-make_interval(days=>$3::int-v)+i*interval '1 second' FROM generate_series(1,$2::int) i CROSS JOIN generate_series(1,$3::int) v",[store,members,versions,date(0),actor,device]);
    await c.query("INSERT INTO consumption_items(store_id,entry_id,position,name,quantity,unit_price_cents,line_total_cents) SELECT store_id,entry_id,0,'合成服务',1,25,25 FROM ledger_entries WHERE store_id=$1 AND kind='consume'",[store]);
    await c.query("INSERT INTO payment_records(store_id,entry_id,position,method,amount_cents) SELECT store_id,entry_id,0,'现金',125 FROM ledger_entries WHERE store_id=$1 AND kind='recharge'",[store]);
    await c.query("INSERT INTO recharge_details(store_id,entry_id,configuration_version,actual_pay_cents,gift_cents,gift_enabled,gift_rate_basis_points) SELECT store_id,entry_id,0,125,0,true,1000 FROM ledger_entries WHERE store_id=$1 AND kind='recharge'",[store]);
    await c.query("INSERT INTO store_changes(store_id,cursor,entity_type,entity_id,change_type) SELECT $1::uuid,account_version*$2::bigint+substring(member_id from 10)::int,'ledger',entry_id,'upsert' FROM ledger_entries WHERE store_id=$1 UNION ALL SELECT $1::uuid,i,'member','capacity-'||lpad(i::text,5,'0'),'upsert' FROM generate_series(1,$2::int) i",[store,members]);
    await c.query('INSERT INTO store_change_heads(store_id,head) VALUES($1,$2)',[store,members*(versions+1)]);
    await c.query('COMMIT');
  } catch(error) { await c.query('ROLLBACK').catch(()=>{}); throw error; } finally { c.release(); }
}
async function http(c,path,body) {
  const res = await fetch(origin+path,{signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+c.accessToken,'content-type':'application/json','x-forwarded-proto':'https','x-forwarded-for':c.ip},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const result = await res.json();
  if (!res.ok) throw Object.assign(Error('HTTP '+res.status),{code:result.code || 'HTTP_'+res.status});
  return result;
}
const read = (c,path,params) => http(c,'/api/v2/'+path+'?'+new URLSearchParams({ledgerEpoch:c.ledgerEpoch,...params}));
function fail(error) { const key = error.code || error.name; outcomes[key] = (outcomes[key] || 0)+1; }
async function timed(c,kind) {
  const at = performance.now();
  try {
    if (kind==='write') {
      const command = {id:randomUUID(),storeId:c.storeId,ledgerEpoch:c.ledgerEpoch,type:'recharge',memberId:c.memberId,expectedAccountVersion:String(c.version),actualPayCents:'2'};
      const r = await http(c,'/api/v2/commands',command);
      assert.deepEqual([r.entryId,r.memberId,r.deltaCents,r.balanceAfterCents,r.accountVersion],[command.id,c.memberId,'2',String(versions*50+2*(c.version+1-versions)),String(c.version+1)]);
      c.version++; writes++;
    } else if (kind==='sync') {
      const r = await read(c,'sync/changes',{after:c.cursor,limit:25}); assert.equal(r.storeId,c.storeId); assert.equal(r.ledgerEpoch,c.ledgerEpoch);
      if (BigInt(r.cursor)>BigInt(c.cursor)) c.cursor = r.cursor;
    } else if (kind==='audit') {
      const r = await http(c,'/api/v1/activity?limit=25'); assert.ok(Array.isArray(r) && r.length<=25);
    } else if (kind.startsWith('report')) {
      const r = await read(c,'reports/business',{from:date(kind==='report-long'?versions+1:7),to:date(-1),offsetMinutes:480}); assert.equal(r.balances.memberCount,members);
    } else {
      const r = await read(c,kind==='ledger'?'ledger':'members',{limit:25,...(kind==='search'?{search:'样本备注'}:kind==='recent'?{balance:'recent'}:{})});
      assert.ok(r.items.length && r.items.length<=25 && r.items.every(item => (item.memberId ?? item.id).startsWith('capacity-') && (item.memberName ?? item.name).startsWith(c.marker)));
    }
    metric(kind,performance.now()-at);
  } catch(error) { fail(error); }
}
const mix = ['members','ledger','search','members','ledger','recent','search','ledger','members','ledger','search','members','ledger','report','write','write','write','write','sync','audit'];
const internal = ['pool-wait', 'account-lock', 'cursor-lock'];
const completed = () => [...data].filter(([k])=>!internal.includes(k)).reduce((n,[,v])=>n+v.length,0);
const summarizeTimings = () => Object.fromEntries([...data].map(([k,v])=>{v.sort((a,b)=>a-b); const p=f=>Math.round(v[Math.ceil(f*v.length)-1]*10)/10;return [k,{count:v.length,p50:p(.50),p95:p(.95),p99:p(.99),max:p(1)}];}));
const refreshAll = () => Promise.all(clients.map(async c=>Object.assign(c,await http(c,'/api/v1/auth/refresh',{refreshToken:c.refreshToken}))));
async function load(phase, seconds, rate) {
  const start = performance.now(), active = new Set(), baseline = completed(), scheduled=seconds*rate;
  let i=0, misses=0, peak=0, sample=60, refresh=600, refreshing;
  await log({phase,seconds,rate,...resource()});
  while (!stopping && i<scheduled) {
    const elapsed=(performance.now()-start)/1000, due=Math.min(scheduled,Math.floor(elapsed*rate));
    if (due-i>rate) { misses+=due-i-rate; i=due-rate; }
    if (elapsed>=refresh && !refreshing) {
      refresh+=600;
      refreshing=refreshAll().catch(fail).finally(()=>{refreshing=undefined;});
    }
    while (i<due) {
      const ordinal=i++, k=mix[ordinal%mix.length], c=clients[(ordinal+Math.floor(ordinal/mix.length))%clients.length];
      if (active.size>=48 || k==='write' && c.writing) { misses++; continue; }
      if (k==='write') c.writing=true;
      const job=timed(c,k).finally(()=>{active.delete(job);if(k==='write') c.writing=false;});
      active.add(job); peak=Math.max(peak,active.size);
    }
    if (elapsed>=sample) {
      sample+=60;
      const { rows: [waits] } = await pool.query("SELECT count(*) FILTER(WHERE wait_event_type='Lock')::int AS locks FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user");
      await log({phase,elapsed,scheduled:i,misses,peak,completed:completed()-baseline,dbLockWaiters:waits.locks,outcomes,...resource()}); loop.reset();
    }
    if (i<scheduled) await delay(10);
  }
  await Promise.all([...active,refreshing]);
  phases.push({phase,rate,scheduled,dispatched:i-misses,misses:misses+scheduled-i,peak,completed:completed()-baseline,elapsedMs:Math.round(performance.now()-start),outcomes:{...outcomes},timings:summarizeTimings()});
  await log({...phases.at(-1),...resource()});
}
try {
  database=await relationalTestDatabase(); pool=database.pool;
  env={node:process.version,os:process.platform,cpu:cpus()[0]?.model,logicalCpuCount:cpus().length,memory:totalmem(),postgres:database.version,
    settings:(await pool.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','max_connections','fsync','synchronous_commit') ORDER BY name")).rows};
  const tracked={query:(...args)=>pool.query(...args), async connect() {
    const at=performance.now(), c=await pool.connect(); metric('pool-wait',performance.now()-at);
    return {async query(sql,params) {
      const name=sql.startsWith('SELECT m.id,m.name,m.phone,m.notes,m.profile_version') && params?.length===8
        ? params[5]==='recent'?'recent':params[1]===''?'members':'search'
        :sql.startsWith('SELECT e.entry_id,e.member_id,e.kind')?'ledger':sql.startsWith('SELECT to_char((e.occurred_at')?'report':sql.startsWith('SELECT member_id,balance_cents,version FROM member_accounts')?'account-lock':null;
      if(name && !plans.has(name)) plans.set(name,{sql,params});
      const tracked = name==='account-lock'?name:sql.startsWith('INSERT INTO store_change_heads')?'cursor-lock':null, at=performance.now();
      try { return await c.query(sql,params); } finally { if (tracked) metric(tracked,performance.now()-at); }
    },release:(...args)=>c.release(...args)};
  }};
  const service=createService(tracked), password=randomUUID()+'!A7';
  for (let s=0;s<stores;s++) {
    const prefix='load-'+s+'-', marker='合成门店 '+s+' 的会员 ', owner=await service.createOwner({username:prefix+'0',password}); let primary;
    for (let i=0;i<(stores===1 && mode!=='probe'?20:1);i++) {
      if(i) await service.createUser(primary.actor,{username:prefix+i,password,role:'owner',displayName:'合成 '+i});
      const ip='127.0.'+(s+1)+'.'+(i+1), deviceId=randomUUID(), grant=await service.login({username:prefix+i,password,deviceId},ip), actor=await service.authenticate(grant.accessToken);
      const book=await service.relational.getBook(actor), c={...grant,...book,actor,ip,marker,deviceId,memberId:memberId(i+1),version:versions,cursor:String(members*(versions+1)-12)};
      assert.equal(c.storeId,owner.storeId); clients.push(c); if(!i) primary=c;
    }
    await seed(owner.storeId,primary.actor.id,primary.deviceId,marker); await log({phase:'seed',store:s+1,members,entries:members*versions});
  }
  await pool.query('ANALYZE member_profiles,member_accounts,ledger_entries,ledger_reversals,store_changes,payment_records,consumption_items,recharge_details');
  env.tableBytes=(await pool.query('SELECT relname,pg_total_relation_size(relid)::text AS bytes FROM pg_stat_user_tables WHERE schemaname=current_schema() ORDER BY relname')).rows;
  server=createApi({service,pool:tracked,production:true,trustedProxyIPs:['127.0.0.1']});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); origin='http://127.0.0.1:'+server.address().port;
  if (mode==='probe') {
    for(let i=0;i<12 && !stopping;i++) for(const k of ['members','recent','search','ledger','report','report-long','write','sync','audit']) await Promise.all(clients.map(c=>timed(c,k)));
  } else {
    await load('warmup',mode==='sample'?20:300,20); data.clear(); for(const k of Object.keys(outcomes)) delete outcomes[k];
    if (!stopping) {
      await refreshAll();
      await load(mode,mode==='sample'?90:mode==='soak'?14400:mode==='steady'?1800:300,mode==='burst2'?40:mode==='burst5'?100:20);
    }
    if(mode.startsWith('burst') && !stopping) {
      for(const k of Object.keys(outcomes)) delete outcomes[k]; data.clear();
      // Sessions can be rate limited during overload. Give the longest quota
      // window time to close, then check normal throughput and correctness.
      await delay(60000); await load('burst-recovery',30,20);
    }
  }
  const timings=summarizeTimings();
  for (const [name,{sql,params}] of plans) { const {rows:[row]}=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params); await write('plan-'+name+'.json',row['QUERY PLAN']); }
  const {rows:[counts]}=await pool.query('SELECT (SELECT count(*) FROM member_profiles) AS members,(SELECT count(*) FROM ledger_entries) AS entries,(SELECT count(*) FROM ledger_command_receipts) AS receipts,(SELECT sum(balance_cents)::text FROM member_accounts) AS balance');
  let invariantErrors=[Number(counts.members)!==stores*members,Number(counts.entries)!==seedEntries+writes,Number(counts.receipts)!==writes,counts.balance!==String(seedEntries*50+writes*2)].filter(Boolean).length;
  for (const c of clients) {
    const {rows:[row]}=await pool.query('SELECT balance_cents,version FROM member_accounts WHERE store_id=$1 AND member_id=$2',[c.storeId,c.memberId]);
    if (String(row?.version)!==String(c.version) || String(row.balance_cents)!==String(versions*50+2*(c.version-versions))) invariantErrors++;
  }
  const sourceUnchanged=(await refactorSources(root)).digest===source.digest, phase=phases.at(-1);
  const limits={ query:dataset==='d2'?500:200, report:dataset==='d2'?2000:200, write:300 };
  const budgetsMet=Object.entries(timings).filter(([k])=>k!=='report-long'&&!internal.includes(k)).every(([k,v])=>v.p95<=(limits[k]??limits.query) && (dataset==='d2'||v.p99<=1000));
  const loadMet=!phase || !phase.misses && phase.completed>=Math.floor(phase.scheduled*.999);
  const phasesMet=phases.every(row=>Object.keys(row.outcomes).every(outcome=>/^burst[25]$/.test(row.phase)&&['RATE_LIMITED','SERVER_BUSY'].includes(outcome)));
  code=!stopping && sourceUnchanged && !invariantErrors && !Object.keys(outcomes).length && phasesMet && budgetsMet && loadMet?0:1;
  result={status:code?'investigate':'pass-local-sample',scope:'Loopback HTTP/PostgreSQL on this workstation; not reference-host acceptance',dataset,mode,env,fixture:{stores,membersPerStore:members,entriesPerStore:members*versions,seed:'alternating-125-minus25-v1',writes},counts,phases,timings,limits,budgetsMet,loadMet,phasesMet,outcomes,invariantErrors,sourceUnchanged,...resource()};
} catch(error) { result={status:'failed',dataset,mode,env,reason:error.code||error.name,error:error.message,outcomes,writes}; }
finally {
  loop.disable(); if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await write('summary.json',{...result,startedAt,finishedAt:new Date().toISOString(),sourceDigest:source.digest});
  await database?.close(); console.log(JSON.stringify({id,status:result.status,reason:result.reason,timings:result.timings,outcomes})); process.exitCode=code;
}
