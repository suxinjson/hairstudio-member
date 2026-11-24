// Workstation integration only. Requires an existing disposable local test DB
// and Caddy/OpenSSL. Nothing is provisioned in a target or production service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../server/http.js';
import { digest } from '../server/security.js';
import { createService } from '../server/service.js';
import { relationalTestDatabase } from '../server/tests/helpers/relational-database.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { refactorSources } from '../tools/refactor-source.mjs';
import { prepare } from './reference-load.mjs';

const target = new URL(process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL || 'about:blank');
assert.ok(target.protocol==='postgresql:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname) && /^\/member_[a-z_]*test(?:_[a-z0-9_]+)?$/.test(target.pathname) && process.env.MEMBER_TEST_DATABASE_DISPOSABLE==='1','requires disposable local PostgreSQL');
const caddyBin = process.env.MEMBER_REFERENCE_TEST_CADDY;
assert.ok(caddyBin,'set MEMBER_REFERENCE_TEST_CADDY to the local Caddy binary');
const workspace = fileURLToPath(new URL('..',import.meta.url)), dir = await mkdtemp(join(tmpdir(),'member-reference-load-smoke-'));
const cert = join(dir,'tls.crt'), key = join(dir,'tls.key');
const childEnv = { PATH:process.env.PATH, NODE_EXTRA_CA_CERTS:cert, XDG_CONFIG_HOME:dir, XDG_DATA_HOME:dir };
function command(exe,args,env=childEnv) {
  const child = spawn(exe,args,{stdio:['ignore','pipe','pipe'],env,cwd:dir});
  let stdout='';
  child.stdout.on('data', b=>{ stdout=(stdout+b).slice(-8192); });
  child.stderr.resume();
  return {child,result:new Promise((resolve,reject)=>{ child.once('error',reject); child.once('close',code=>resolve({code,stdout})); })};
}
async function listen(server) {
  server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port;
}
async function stop(server) { server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve)); }
const openssl=await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert]).result;
assert.equal(openssl.code,0);
const certBytes = await readFile(cert);
const db = await relationalTestDatabase();
let backend,caddy;
try {
  const {pool}=db, service=createService(pool), source=await refactorSources(workspace);
  const tag=randomUUID().replaceAll('-','').slice(0,12), prefix='refqa-'+tag+'-01', username=prefix+'-owner', password=randomUUID()+'Aa!5', deviceId=randomUUID();
  const owner=await service.createOwner({username,password,storeName:prefix});
  await pool.query('INSERT INTO store_licenses(id,store_id,features,offline_hours) VALUES($1,$2,$3,24)',[randomUUID(),owner.storeId,JSON.stringify(LICENSE_FEATURES)]);
  const seeded=await service.login({username,password,deviceId},'127.0.0.1');
  const identity=await service.authenticate(seeded.accessToken), book=await service.relational.getBook(identity);
  const members=Array.from({length:91},(_,index)=>({id:prefix+'-m'+String(index).padStart(3,'0'),name:prefix+'-person'+index,balanceCents:'0'}));
  const opening={...book,batchId:randomUUID(),sourceDigest:digest(JSON.stringify(members)),expectedCount:members.length,members};
  const preview=await service.relational.previewOpeningImport(identity,opening);
  await service.relational.importOpeningBalances(identity,{...opening,payloadDigest:preview.payloadDigest});
  const initial={...book,id:randomUUID(),type:'recharge',memberId:members[0].id,expectedAccountVersion:'0',actualPayCents:'2'};
  await service.relational.executeCommand(identity,initial);

  const probe=createServer(), front=await listen(probe); await stop(probe);
  const origin='https://127.0.0.1:'+front;
  backend=createApi({pool,service,production:true,trustedProxyIPs:['127.0.0.1'],allowedOrigins:[origin]});
  let drop=false,dropped=0;
  backend.prependListener('request',(req,res)=>{
    if (drop && req.method==='POST' && req.url==='/api/v2/commands') {
      const end=res.end;
      res.end=function (...args) {
        if (this.statusCode===200) { drop=false; dropped++; this.destroy(); return this; }
        return end.apply(this,args);
      };
    }
  });
  const back=await listen(backend);
  const config=join(dir,'Caddyfile');
  await writeFile(config,['{','admin off','auto_https disable_redirects','}',origin+' {','bind 127.0.0.1','tls '+cert+' '+key,'reverse_proxy 127.0.0.1:'+back,'}',''].join('\n'));
  caddy=command(caddyBin,['run','--config',config,'--adapter','caddyfile']);
  let ready=false;
  for(let n=0;n<40&&!ready;n++) {
    ready=await new Promise(resolve=>get(origin+'/api/ready',{ca:certBytes,signal:AbortSignal.timeout(500)},res=>{
      res.resume(); res.on('end',()=>resolve(res.statusCode===200));
    }).on('error',()=>resolve(false)));
    if (!ready) await delay(100);
  }
  assert.equal(ready,true,'trusted Caddy TLS endpoint should become ready');
  assert.equal((await fetch('http://127.0.0.1:'+back+'/api/health')).status,400,'API still requires proxy');

  const plan={origin,profile:'smoke',tag,sourceDigest:source.digest,fixtureFrom:new Date(Date.now()-3600000).toISOString(),fixtureTo:new Date(Date.now()+86400000).toISOString(),
    clients:[{...book,sourceAddress:'127.0.0.1',username,passwordEnv:'MEMBER_REF_PASSWORD_FIXTURE',storeKey:'01',memberId:members[0].id,deviceId}]};
  const env={...childEnv,MEMBER_REFERENCE_LOAD_ISOLATED:'1',MEMBER_REF_PASSWORD_FIXTURE:password};
  assert.throws(()=>prepare(plan,{env:{...env,NODE_TLS_REJECT_UNAUTHORIZED:'0'},addresses:['127.0.0.1']}),{code:'ISOLATED_HTTPS_REQUIRED'});
  assert.throws(()=>prepare({...plan,origin:origin+'/api'},{env,addresses:['127.0.0.1']}),{code:'INVALID_ORIGIN'});
  assert.throws(()=>prepare({...plan,clients:[plan.clients[0],plan.clients[0]]},{env,addresses:['127.0.0.1']}),{code:'DUPLICATE_CLIENT'});
  assert.throws(()=>prepare({...plan,profile:'steady'},{env,addresses:['127.0.0.1']}),{code:'INVALID_PROFILE'});
  const snapshot=async()=>service.relational.getMember(identity,plan.clients[0].memberId,{ledgerEpoch:book.ledgerEpoch});
  const invoke=async(name,capture)=>{
    const path=join(dir,name+'.json'); await writeFile(path,JSON.stringify(capture),{mode:0o600});
    const res=await command(process.execPath,[join(workspace,'acceptance','reference-load.mjs'),path],env).result;
    const {output}=JSON.parse(res.stdout);
    return {code:res.code,report:JSON.parse(await readFile(join(output,'summary.json'),'utf8')),journal:(await readFile(join(output,'write-originals.ndjson'),'utf8').catch(e=>{
      if(e.code!=='ENOENT')throw e; return '';
    })).trim().split('\n').filter(Boolean).map(JSON.parse)};
  };
  const wrong=await invoke('wrong',{...plan,clients:[{...plan.clients[0],ledgerEpoch:randomUUID()}]});
  assert.equal(wrong.code,1); assert.deepEqual(wrong.report.issues,[{stage:'preflight',code:'BOOK_SCOPE_MISMATCH'}]);
  assert.equal(wrong.journal.length,0); assert.equal((await snapshot()).accountVersion,'1');
  const clean=await invoke('clean',plan);
  assert.equal(clean.code,0,JSON.stringify({phases:clean.report.phases,issues:clean.report.issues}));
  assert.equal(clean.report.status,'pass-workload'); assert.equal(clean.report.phases[0].ok,30);
  const confirmed=clean.report.stores[0].confirmedWrites;
  assert.equal(confirmed,clean.journal.length); assert.equal(confirmed,6);
  assert.equal((await snapshot()).accountVersion,'7');
  drop=true;
  const lost=await invoke('lost',plan);
  assert.equal(dropped,1); assert.equal(lost.code,1); assert.equal(lost.report.confirmedAfterResponseLoss,1);
  assert.equal(lost.journal.length,1); assert.equal(lost.report.stores[0].confirmedWrites,1); assert.deepEqual(lost.report.pending,[]);
  assert.equal((await snapshot()).accountVersion,'8');
  const verification={sourceDigest:source.digest,driverSha256:clean.report.toolSha256,scope:'Local Caddy HTTPS and disposable real PostgreSQL; not target acceptance',postgres:db.version,
    status:'pass',checks:{accepted:30,confirmed,wrongEpochWrites:wrong.journal.length,responseLossRecovered:lost.report.confirmedAfterResponseLoss,responseLossReplacementWrites:lost.journal.length-1}};
  console.log(JSON.stringify(verification,null,2));
} finally {
  if(caddy) { caddy.child.kill(); await caddy.result.catch(()=>{}); }
  if(backend) await stop(backend);
  await db.close();
}
