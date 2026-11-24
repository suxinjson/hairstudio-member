// Workstation verification. Creates uniquely named, disposable loopback DBs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { createPool, migrate } from '../server/database.js';
import { prepareRecoveryTarget } from '../server/prepare-recovery-target.js';
import { createService } from '../server/service.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { refactorSources } from '../tools/refactor-source.mjs';

const [dataset='d1', mode='roundtrip', extra] = process.argv.slice(2);
assert.ok(['d1','d2','d3'].includes(dataset) && ['baseline','roundtrip'].includes(mode) && extra === undefined);
const base = new URL(process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL ?? 'about:blank');
assert.ok(base.protocol==='postgresql:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname) &&
  base.pathname==='/member_relational_test' && !base.search && base.port && process.env.MEMBER_TEST_DATABASE_DISPOSABLE==='1','requires dedicated workstation PG');
const workspace = fileURLToPath(new URL('..',import.meta.url)), run = promisify(execFile), startedAt = new Date().toISOString();
const {digest:sourceDigest} = await refactorSources(workspace);
const fixturePassword = randomUUID()+'-Qa5!', tag = randomUUID().replaceAll('-','').slice(0,12);
const admin = new pg.Client({connectionString:base.href}), created = [], pools = [];
const codeOnly = error => error.code ?? error.name;
const log = stage => console.error(stage);
const timings = {}, queries = {}; let stage = 'setup';
function traced(pool) {
  async function query(client,sql,params) {
    const label=sql.replace(/^SELECT .*? FROM /,'SELECT FROM ').split(' VALUES')[0].slice(0,150), key=stage+': '+label;
    const metric=queries[key]??={count:0,ms:0,maxMs:0}, at=performance.now();
    try { return await client.query(sql,params); }
    finally { const ms=performance.now()-at; metric.count++; metric.ms+=ms; metric.maxMs=Math.max(metric.maxMs,ms); }
  }
  return {query:(sql,params)=>query(pool,sql,params),async connect(){const client=await pool.connect();return {query:(sql,params)=>query(client,sql,params),release:discard=>client.release(discard)};}};
}
async function measure(name, fn) {
  stage = name; log(name);
  const at = performance.now();
  try { return await fn(); } finally { timings[name] = Math.round(performance.now()-at); }
}
async function database(name) {
  assert.match(name,/^member_refqa_(?:restore_)?[a-f0-9]{12}$/);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE template0'); created.push(name);
  const target = new URL(base); target.pathname='/'+name;
  const pool = createPool(target.href,{max:4}); pools.push(pool);
  await migrate(pool); return {pool,target};
}
function seed(target) {
  return run(process.execPath,[join(workspace,'acceptance','reference-fixtures.mjs'),tag,dataset],{cwd:workspace,timeout:1_200_000,
    env:{PATH:process.env.PATH,MEMBER_REFERENCE_FIXTURE_DISPOSABLE:'1',MEMBER_REFERENCE_FIXTURE_DATABASE_URL:target.href,MEMBER_REF_PASSWORD_FIXTURE:fixturePassword}});
}
async function login(service, client, password=fixturePassword) {
  return service.authenticate((await service.login({username:client.username,password,deviceId:client.deviceId},'127.0.0.1')).accessToken);
}
const statement = (pool, storeId) => pool.query('SELECT member_id,balance_cents::text,version::text FROM member_accounts WHERE store_id=$1 ORDER BY member_id',[storeId]).then(r=>r.rows);

let summary, tmp, file;
try {
  await admin.connect();
  const source = await database('member_refqa_'+tag), service = createService(traced(source.pool));
  const badTarget = new URL(base);
  await assert.rejects(seed(badTarget), e=>e.stderr.includes('INVALID_FIXTURE_URL'));
  const seeded = JSON.parse((await measure('seed',()=>seed(source.target))).stdout);
  assert.equal(seeded.sourceDigest,sourceDigest);
  await assert.rejects(seed(source.target), e=>e.stderr.includes('FIXTURE_DB_NOT_EMPTY'));
  const {plan,stores} = seeded, {rows:[server]} = await source.pool.query("SELECT current_setting('server_version') AS version,current_setting('statement_timeout') AS statement_timeout");
  const {fixtureFrom:from,fixtureTo:to} = plan;
  assert.deepEqual([stores.length,stores[0].members,stores[0].entries,plan.clients.length],
    ({d1:[1,1000,100000,16],d2:[1,10000,1000000,16],d3:[20,500,10000,20]})[dataset]);
  const actors = [];
  await measure('api-reconciliation',async()=>{
    for (const store of stores) {
      const lane = plan.clients.find(c=>c.storeKey===store.storeKey), scope = {ledgerEpoch:lane.ledgerEpoch}, identity = await login(service,lane);
      actors.push({lane,scope,identity});
      const rows = await statement(source.pool,lane.storeId), version = String(store.entries/store.members);
      assert.equal(rows.length,store.members);
      assert.ok(rows.every(r=>r.member_id.startsWith('refqa-'+tag+'-'+store.storeKey+'-m') && r.balance_cents===store.balancePerMemberCents && r.version===version));
      const report = await service.relational.report(identity,{from,to,...scope});
      assert.deepEqual([report.memberCount,report.entryCount,report.storedCents,report.netChangeCents,report.actualPayCents,report.consumptionCents],
        [store.members,store.entries,store.net,store.net,String(BigInt(store.paidPerRechargeCents)*BigInt(store.entries/2)),String(25*store.entries/2)]);
      const seedId = 'refqa-'+tag+'-'+store.storeKey+'-entry-00001-', original = {storeId:lane.storeId, ...scope, memberId:lane.memberId};
      const r = await service.relational.executeCommand(identity,{...original,id:seedId+'001',type:'recharge',expectedAccountVersion:'0',actualPayCents:store.paidPerRechargeCents,payMethod:'cash'});
      const c = await service.relational.executeCommand(identity,{...original,id:seedId+'002',type:'consume',expectedAccountVersion:'1',amountCents:'25',itemsSummary:'fixture-service'});
      assert.deepEqual([r.entryId,r.accountVersion,c.entryId,c.accountVersion,c.balanceAfterCents],[seedId+'001','1',seedId+'002','2',String(BigInt(store.paidPerRechargeCents)-25n)]);
      const after = await service.relational.getMember(identity,lane.memberId,scope);
      assert.deepEqual([after.balanceCents,after.accountVersion],[store.balancePerMemberCents,version]);
    }
    if (actors.length>1) await assert.rejects(service.relational.getMember(actors[0].identity,actors[1].lane.memberId,actors[0].scope),{status:404});
  });
  summary = {status:'pass-workstation-only',scope:'Dedicated loopback real PG and application services; not target infrastructure or load',dataset,mode,postgres:server.version,statementTimeout:server.statement_timeout,startedAt,
    sourceDigest,fixtureToolSha256:seeded.toolSha256,stores:stores.length,members:stores.reduce((a,s)=>a+s.members,0),entries:stores.reduce((a,s)=>a+s.entries,0),
    invalidDatabaseRejected:true,nonemptyDatabaseRejected:true,originalChargeAndConsumeReplayedPerStore:true,checkedCrossStoreRead:actors.length>1,timingsMs:timings};
  if (mode==='roundtrip') {
    const {lane,scope,identity}=actors[0], expected=stores[0], id=randomUUID(), applied = {storeId:lane.storeId,...scope,id,type:'recharge',memberId:lane.memberId,
      expectedAccountVersion:String(expected.entries/expected.members),actualPayCents:'2'};
    const posted=await service.relational.executeCommand(identity,applied);
    assert.equal(posted.balanceAfterCents,String(BigInt(expected.balancePerMemberCents)+2n));
    tmp=await mkdtemp(join(tmpdir(),'member-refqa-archive-')); file=join(tmp,'growth.ndjson');
    const output=await open(file,'ax',0o600);
    let archive;
    try { archive=await measure('export',()=>service.relational.exportArchive(identity,{...scope,write:line=>output.writeFile(line)})); await output.sync(); }
    finally { await output.close(); }
    const fileSha256=await measure('external-readback',async()=>{
      let bytes=0; const hash=createHash('sha256');
      for await(const block of createReadStream(file)){ bytes+=block.length; hash.update(block); }
      assert.equal(bytes,archive.byteLength); return hash.digest('hex');
    });
    const dest=await database('member_refqa_restore_'+tag), name=dest.target.pathname.slice(1), username='fixture-recovery-'+tag;
    await prepareRecoveryTarget(dest.pool,{databaseName:name,storeId:lane.storeId,username,displayName:username,storeName:'fixture-recovery-'+tag,password:fixturePassword,apply:true});
    await dest.pool.query('INSERT INTO store_licenses(id,store_id,features) VALUES($1,$2,$3)',[randomUUID(),lane.storeId,JSON.stringify(LICENSE_FEATURES)]);
    const recovery=createService(traced(dest.pool),{recoveryPool:traced(dest.pool)}), credential={username,deviceId:randomUUID()};
    let actor=await login(recovery,credential); const target=await recovery.relational.getBook(actor);
    const restoreId=randomUUID(), read=()=>createReadStream(file), captured={id:restoreId,ledgerEpoch:target.ledgerEpoch};
    const preview=await measure('preview',()=>recovery.relational.previewArchiveRestore(actor,{...captured,chunks:read()}));
    assert.deepEqual([preview.sourceDigest,preview.memberCount,preview.entryCount],[archive.digest,expected.members,expected.entries+1]);
    assert.equal((await statement(dest.pool,lane.storeId)).length,0);
    const restore={...captured,sourceEpoch:preview.sourceEpoch,reviewedDigest:preview.sourceDigest};
    actor=await login(recovery,credential);
    const restored=await measure('restore',()=>recovery.relational.restoreArchive(actor,{...restore,chunks:read()}));
    const book=await recovery.relational.getBook(actor);
    assert.equal(book.ledgerEpoch,restored.ledgerEpoch); assert.notEqual(book.ledgerEpoch,lane.ledgerEpoch); assert.notEqual(book.ledgerEpoch,target.ledgerEpoch);
    assert.deepEqual(await statement(dest.pool,lane.storeId),await statement(source.pool,lane.storeId));
    await assert.rejects(recovery.relational.getMember(actor,lane.memberId,scope),{code:'LEDGER_EPOCH_MISMATCH'});
    const next=await recovery.relational.executeCommand(actor,{...applied,...book,id:randomUUID(),expectedAccountVersion:posted.accountVersion});
    assert.equal(next.balanceAfterCents,String(BigInt(posted.balanceAfterCents)+2n));
    assert.deepEqual(await recovery.relational.restoreArchive(actor,{...restore,chunks:(async function*(){})()}),restored);
    assert.equal((await recovery.relational.getMember(actor,lane.memberId,{ledgerEpoch:book.ledgerEpoch})).balanceCents,next.balanceAfterCents);
    summary.archive={fileSha256,archiveDigest:archive.digest,bytes:archive.byteLength,entries:preview.entryCount,membersCompared:preview.memberCount,
      previewRolledBack:true,newEpoch:true,retryPreservedNewWrite:true};
  }
  assert.equal((await refactorSources(workspace)).digest,sourceDigest,'candidate changed during verification');
  summary.sourceUnchanged=true;
} catch (error) {
  console.error('fixture verification failed:',codeOnly(error),error.stderr?.trim() ?? error.message);
  summary = {...summary,status:'fail-workstation',stage,code:codeOnly(error),dataset,mode,sourceDigest,startedAt,timingsMs:timings};
  process.exitCode=1;
} finally {
  for (const pool of pools) await pool.end();
  for (const name of created.reverse()) await admin.query('DROP DATABASE '+name);
  await admin.end();
  if (file) await unlink(file).catch(e=>{if (e.code!=='ENOENT') throw e;});
  if (tmp) await rmdir(tmp);
}
console.log(JSON.stringify({...summary,queryTimings:Object.entries(queries).map(([query,m])=>({query,...Object.fromEntries(Object.entries(m).map(([k,v])=>[k,Math.round(v*100)/100]))})).sort((a,b)=>b.ms-a.ms),finishedAt:new Date().toISOString()},null,2));
