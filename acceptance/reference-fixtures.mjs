// Seed only a newly migrated, disposable PostgreSQL database for REF-03.
// The synthetic history includes the facts required by v2 archive validation.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { provisionStore } from '../server/provision-store.js';
import { hashPassword } from '../server/security.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { refactorSources } from '../tools/refactor-source.mjs';

const sizes = {d1:{stores:1,members:1000,versions:100,lanes:16},d2:{stores:1,members:10000,versions:100,lanes:16},d3:{stores:20,members:500,versions:20,lanes:1}};
const day = 86_400_000;
function requireThat(value, code) { if (!value) throw Object.assign(new Error(code), {code}); }
const pad = (n, width) => String(n).padStart(width, '0');

function input() {
  const [tag, dataset, extra] = process.argv.slice(2), env = process.env;
  requireThat(typeof tag === 'string' && /^[a-z0-9]{6,24}$/.test(tag) && Object.hasOwn(sizes,dataset) && extra === undefined,'USAGE_REFERENCE_FIXTURES_TAG_D1_D2_D3');
  requireThat(env.MEMBER_REFERENCE_FIXTURE_DISPOSABLE === '1' && env.NODE_TLS_REJECT_UNAUTHORIZED !== '0','DISPOSABLE_FIXTURE_DB_REQUIRED');
  const db = 'member_refqa_' + tag;
  let uri;
  try { uri = new URL(env.MEMBER_REFERENCE_FIXTURE_DATABASE_URL); } catch { throw Object.assign(new Error('INVALID_FIXTURE_URL'),{code:'INVALID_FIXTURE_URL'}); }
  // Create no database, use no default DSN or environment authentication. TLS
  // options are set in code so a query string cannot turn verification off.
  requireThat(uri.protocol === 'postgresql:' && uri.pathname === '/' + db && uri.hostname && uri.port && uri.username && uri.password && !uri.search && !uri.hash,'INVALID_FIXTURE_URL');
  requireThat(typeof env.MEMBER_REF_PASSWORD_FIXTURE === 'string' && env.MEMBER_REF_PASSWORD_FIXTURE.length >= 12 && env.MEMBER_REF_PASSWORD_FIXTURE.length <= 128,'FIXTURE_PASSWORD_REQUIRED');
  const host = uri.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.');
  return {tag,dataset,db,sizing:sizes[dataset],password:env.MEMBER_REF_PASSWORD_FIXTURE, connection:{
    host, port:Number(uri.port), user:decodeURIComponent(uri.username), password:decodeURIComponent(uri.password), database:db,
    application_name:'member-refqa-fixture', connectionTimeoutMillis:5000,
    ssl:loopback ? false : {rejectUnauthorized:true,...(env.MEMBER_REFERENCE_FIXTURE_CA_FILE && {caFile:env.MEMBER_REFERENCE_FIXTURE_CA_FILE})}
  }};
}

async function seedHistory(client, store) {
  const {storeId, prefix, members, versions, anchor, ledgerEpoch, actorId, deviceId, paid} = store;
  const total = members * versions, head = members + total * 2;
  await client.query(
    "INSERT INTO member_profiles(store_id,id,name,created_at,updated_at) SELECT $1,$4::text||'-m'||lpad(i::text,5,'0'),$4::text||'-person-'||i," +
    "$3::timestamptz-make_interval(days=>$5::int+1),$3::timestamptz-make_interval(days=>$5::int+1) FROM generate_series(1,$2::int) i",[storeId,members,anchor,prefix,versions]);
  await client.query('INSERT INTO member_accounts(store_id,member_id,balance_cents,version) SELECT store_id,id,$2::bigint,$3 FROM member_profiles WHERE store_id=$1',
    [storeId,(paid-25)*versions/2,versions]);
  await client.query("INSERT INTO audit_events(store_id,user_id,device_id,event,details,received_at) SELECT $1,$2,$3,'member_created',jsonb_build_object('memberId',id),created_at FROM member_profiles WHERE store_id=$1",[storeId,actorId,deviceId]);
  await client.query("INSERT INTO store_changes(store_id,cursor,entity_type,entity_id,change_type,recorded_at) SELECT $1,i,'member',$3::text||'-m'||lpad(i::text,5,'0'),'upsert',created_at " +
    "FROM generate_series(1,$2::int) i JOIN member_profiles m ON m.store_id=$1 AND m.id=$3::text||'-m'||lpad(i::text,5,'0')",[storeId,members,prefix]);

  // Consume 25 cents after each top-up, with closed-form balance and version.
  // One temporary relation per transaction supplies the same IDs to every fact.
  await client.query('TRUNCATE pg_temp.refqa_entries');
  await client.query("INSERT INTO pg_temp.refqa_entries SELECT $1::text||'-entry-'||lpad(i::text,5,'0')||'-'||lpad(v::text,3,'0')," +
    "$1::text||'-m'||lpad(i::text,5,'0'),v,CASE WHEN v%2=1 THEN 'recharge' ELSE 'consume' END," +
    "CASE WHEN v%2=1 THEN $5::int ELSE -25 END,((v-1)/2)*($5::int-25)+CASE WHEN v%2=0 THEN $5::int ELSE 0 END," +
    "(v/2)*($5::int-25)+CASE WHEN v%2=1 THEN $5::int ELSE 0 END,CASE WHEN v%2=1 THEN $5::int ELSE 0 END," +
    "$4::timestamptz-make_interval(days=>$3::int-v)+i*interval '20 milliseconds',$2::bigint+2*(($2::bigint*(v-1))+i) " +
    'FROM generate_series(1,$2::int) i CROSS JOIN generate_series(1,$3::int) v',[prefix,members,versions,anchor,paid]);
  await client.query('INSERT INTO ledger_entries(store_id,entry_id,member_id,kind,account_version,delta_cents,balance_before_cents,balance_after_cents,actual_pay_cents,pay_method,items_summary,actor_id,device_id,occurred_at,recorded_at) ' +
    "SELECT $1,id,member_id,kind,version,delta,before_cents,after_cents,paid,CASE WHEN paid>0 THEN 'cash' ELSE '' END,CASE WHEN paid=0 THEN 'fixture-service' ELSE '' END," +
    '$2,$3,at,at FROM pg_temp.refqa_entries',[storeId,actorId,deviceId]);
  await client.query("INSERT INTO consumption_items(store_id,entry_id,position,name,quantity,unit_price_cents,line_total_cents) SELECT $1,id,0,'fixture-service',1,25,25 FROM pg_temp.refqa_entries WHERE paid=0",[storeId]);
  await client.query("INSERT INTO payment_records(store_id,entry_id,position,method,amount_cents) SELECT $1,id,0,'cash',paid FROM pg_temp.refqa_entries WHERE paid>0",[storeId]);
  await client.query('INSERT INTO recharge_details(store_id,entry_id,configuration_version,actual_pay_cents,gift_cents,gift_enabled,gift_rate_basis_points) ' +
    'SELECT $1,id,0,paid,0,false,1000 FROM pg_temp.refqa_entries WHERE paid>0',[storeId]);
  // This is the canonical v2 request hash, not a placeholder. Fixture request
  // values are strings made from the controlled IDs, version and amount.
  await client.query('INSERT INTO ledger_command_receipts(store_id,command_id,ledger_epoch,actor_id,device_id,request_hash,command_type,result,created_at) ' +
    "SELECT $1,h.id,$2,$3,$4,encode(sha256(convert_to(j.canonical,'UTF8')),'hex'),h.kind,jsonb_build_object(" +
    "'storeId',$1::uuid,'ledgerEpoch',$2::uuid,'entryId',h.id,'commandId',h.id,'memberId',h.member_id,'type',h.kind,'accountVersion',h.version::text," +
    "'deltaCents',h.delta::text,'balanceBeforeCents',h.before_cents::text,'balanceAfterCents',h.after_cents::text,'cursor',h.cursor::text," +
    "'occurredAt',to_char(h.at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')),h.at FROM pg_temp.refqa_entries h CROSS JOIN LATERAL (" +
    "SELECT '{'||string_agg(to_json(key)::text||':'||value::text,',' ORDER BY key COLLATE \"C\")||'}' AS canonical FROM jsonb_each(" +
    "jsonb_build_object('expectedAccountVersion',(h.version-1)::text,'id',h.id,'ledgerEpoch',$2::uuid,'memberId',h.member_id,'storeId',$1::uuid,'type',h.kind) || " +
    "CASE WHEN h.paid>0 THEN jsonb_build_object('actualPayCents',h.paid::text,'payMethod','cash') ELSE jsonb_build_object('amountCents','25','itemsSummary','fixture-service') END)) AS j",
    [storeId,ledgerEpoch,actorId,deviceId]);
  await client.query("INSERT INTO audit_events(store_id,user_id,device_id,event,details,received_at) SELECT $1,$2,$3,'ledger_'||kind,jsonb_build_object('commandId',id,'entryId',id,'memberId',member_id),at FROM pg_temp.refqa_entries",[storeId,actorId,deviceId]);
  await client.query("INSERT INTO store_changes(store_id,cursor,entity_type,entity_id,change_type,recorded_at) " +
    "SELECT $1::uuid,cursor-1,'ledger',id,'upsert',at FROM pg_temp.refqa_entries UNION ALL SELECT $1::uuid,cursor,'member',member_id,'upsert',at FROM pg_temp.refqa_entries",[storeId]);
  await client.query('INSERT INTO store_change_heads(store_id,head) VALUES($1,$2)',[storeId,head]);
  const { rows:[row] } = await client.query('SELECT (SELECT count(*)::int FROM member_accounts WHERE store_id=$1) AS members,' +
    '(SELECT count(*)::int FROM ledger_entries WHERE store_id=$1) AS entries,(SELECT count(*)::int FROM ledger_command_receipts WHERE store_id=$1) AS receipts,' +
    '(SELECT count(*)::int FROM store_changes WHERE store_id=$1) AS changes,(SELECT count(*)::int FROM audit_events WHERE store_id=$1) AS audits,' +
    '(SELECT sum(balance_cents)::text FROM member_accounts WHERE store_id=$1) AS net',[storeId]);
  requireThat(row.members===members && row.entries===total && row.receipts===total && row.changes===head && row.audits===total+members && row.net===String((paid-25)*total/2),'FIXTURE_TOTAL_MISMATCH');
  return row;
}

let stage = 'input';
async function main() {
  const {tag,dataset,db,sizing,password,connection} = input();
  const root = fileURLToPath(new URL('../',import.meta.url)), sources = await refactorSources(root);
  const toolSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  if (connection.ssl?.caFile) { connection.ssl.ca = await readFile(connection.ssl.caFile,'utf8'); delete connection.ssl.caFile; }
  const client = new pg.Client(connection), lanes = [], stores = [], start = new Date();
  // Last history day is yesterday UTC, even when started just after midnight.
  const anchor = new Date(Math.floor(+start/day)*day-day).toISOString();
  let begun = false;
  stage = 'connect';
  try {
    await client.connect();
    stage = 'guard'; await client.query('BEGIN'); begun = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='20min'");
    await client.query('SET LOCAL search_path=public,pg_catalog');
    const {rows:[guard]} = await client.query("SELECT current_database() AS db, current_schema() AS schema, session_user AS role, " +
      "to_regclass('public.ledger_command_receipts') IS NOT NULL AS migrated, " +
      "EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.stores') AND pg_has_role(relowner,'USAGE')) AS owns_stores, " +
      "to_regclass('public.accounts') IS NOT NULL OR to_regclass('public.operations') IS NOT NULL AS old_schema");
    requireThat(guard.db===db && guard.schema==='public' && guard.migrated && guard.owns_stores && !guard.old_schema &&
      !['member_app','member_recovery'].includes(guard.role),'FIXTURE_SCOPE_NOT_CONFIRMED');
    await client.query('LOCK TABLE public.stores IN SHARE ROW EXCLUSIVE MODE');
    const {rows:[state]} = await client.query('SELECT EXISTS(SELECT 1 FROM public.stores) OR EXISTS(SELECT 1 FROM public.releases) AS in_use');
    requireThat(!state.in_use,'FIXTURE_DB_NOT_EMPTY');
    await client.query('CREATE TEMP TABLE refqa_entries(id text,member_id text,version integer,kind text,delta integer,before_cents integer,after_cents integer,paid integer,at timestamptz,cursor bigint) ON COMMIT DROP');
    for (let index=1; index<=sizing.stores; index++) {
      const storeKey = pad(index,2), prefix = 'refqa-' + tag + '-' + storeKey;
      stage = 'store-' + storeKey;
      const username = prefix + '-owner01';
      const {userId:actorId,storeId} = await provisionStore(client,{username,passwordHash:await hashPassword(password),displayName:username,storeName:prefix});
      const {rows:[book]} = await client.query('SELECT ledger_epoch AS "ledgerEpoch" FROM stores WHERE id=$1',[storeId]);
      await client.query('UPDATE store_recharge_settings SET gift_enabled=false WHERE store_id=$1',[storeId]);
      await client.query('INSERT INTO store_licenses(id,store_id,features,expires_at) VALUES($1,$2,$3,now()+interval \'14 days\')',[randomUUID(),storeId,JSON.stringify(LICENSE_FEATURES)]);
      const deviceId = randomUUID();
      for (let i=1; i<=sizing.lanes; i++) {
        const name = prefix + '-owner' + pad(i,2);
        if (i!==1) await client.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$3,$4,'owner')",[randomUUID(),storeId,name,await hashPassword(password)]);
        lanes.push({storeId,...book,storeKey,memberId:prefix+'-m'+pad(i,5),username:name,deviceId:i===1?deviceId:randomUUID(),passwordEnv:'MEMBER_REF_PASSWORD_FIXTURE'});
      }
      stage = 'history-' + storeKey;
      const paid = 124+index;
      const totals = await seedHistory(client,{...sizing,...book,storeId,prefix,actorId,deviceId,anchor,paid});
      stores.push({storeKey,storeId,...book,paidPerRechargeCents:String(paid),balancePerMemberCents:String((paid-25)*sizing.versions/2),...totals});
    }
    stage = 'analyze';
    await client.query('ANALYZE member_profiles,member_accounts,ledger_entries,ledger_command_receipts,store_changes,audit_events,payment_records,consumption_items,recharge_details');
    stage = 'source';
    requireThat((await refactorSources(root)).digest===sources.digest,'FIXTURE_SOURCE_CHANGED');
    stage = 'commit'; await client.query('COMMIT'); begun = false;
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { await client.end().catch(()=>{}); }
  const plan = {origin:'https://member-acceptance.example.test',profile:dataset==='d1'?'steady':dataset,tag,sourceDigest:sources.digest,
    fixtureFrom:new Date(Date.parse(anchor)-(sizing.versions+2)*day).toISOString(),fixtureTo:new Date(+start+7*day).toISOString(),clients:lanes};
  console.log(JSON.stringify({status:'seeded-disposable-fixture',dataset,sourceDigest:sources.digest,toolSha256,startedAt:start.toISOString(),finishedAt:new Date().toISOString(),stores,plan},null,2));
}

main().catch(error=>{
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,55}$/.test(error.code) ? error.code : 'FIXTURE_DRIVER_ERROR';
  console.error(JSON.stringify({status:'fixture-not-confirmed',stage,code}));
  process.exitCode=1;
});
