// Run only against an explicitly supplied, empty disposable database.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { createDatabase, login } from '../src/db.js';
import { createPairBoard } from '../src/pair-boards.js';
import type { Config } from '../src/config.js';

const url=process.env.MCP_MIGRATION_DATABASE_URL;
if (!url) throw new Error('MCP_MIGRATION_DATABASE_URL must name an empty disposable test database');
const db=createDatabase(url);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const directory=new URL('../migrations/',import.meta.url);
const migration='016_mcp_lifecycle.sql';
let app: ReturnType<typeof buildApp> | undefined;
let client: Client | undefined;
try {
  assert.equal((await db.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count,0,'Refusing a nonempty database');
  const files=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
  for (const file of files.filter(file=>file<migration)) await db.query(await readFile(new URL(file,directory),'utf8'));
  const config: Config={botToken:'test',databaseUrl:url,sessionSecret:'isolated-migration',initDataMaxAgeSeconds:60,sessionMaxAgeSeconds:3600,host:'127.0.0.1',port:0,production:false,webhookSecret:'isolated-test',publicUrl:'http://127.0.0.1',botUsername:'test_bot'};
  const owner=await login(db,{id:randomBytes(6).readUIntBE(0,6),first_name:'Migration fixture'},3600,config.sessionSecret);
  const boardId=(await db.query('SELECT id FROM boards WHERE owner_user_id=$1',[owner.userId])).rows[0].id;
  const unknown=await createPairBoard(db,owner.userId,'Not selected',randomUUID());
  const input={requestId:randomUUID(),name:'Legacy connection',mode:'write',boardIds:[boardId]};
  const id=randomUUID(), key='ktk_mcp_'+randomBytes(32).toString('base64url');
  const requestHash=hash(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)))));
  await db.query('INSERT INTO mcp_connections (id,user_id,name,mode,key_hash,create_request_id,request_hash,board_count) VALUES ($1,$2,$3,$4,$5,$6,$7,1)',[id,owner.userId,input.name,input.mode,hash(key),input.requestId,requestHash]);
  await db.query('INSERT INTO mcp_board_grants (connection_id,user_id,board_id) VALUES ($1,$2,$3)',[id,owner.userId,boardId]);
  // Seed the old schema directly: current task writers require later chat/assessment columns.
  const task=(await db.query('INSERT INTO tasks (id,board_id,title,creator_user_id) VALUES ($1,$2,$3,$4) RETURNING id',[randomUUID(),boardId,'Legacy task',owner.userId])).rows[0];
  await db.query('INSERT INTO mcp_write_receipts (connection_id,request_id,request_hash,subject_id,board_id,version) VALUES ($1,$2,$3,$4,$5,1)',[id,randomUUID(),'synthetic-fingerprint',task.id,boardId]);
  const snapshot=async()=>({
    connection:(await db.query('SELECT id,user_id,name,mode,key_hash,create_request_id,request_hash,board_count,created_at,revoked_at FROM mcp_connections WHERE id=$1',[id])).rows,
    grants:(await db.query('SELECT * FROM mcp_board_grants WHERE connection_id=$1',[id])).rows,
    receipts:(await db.query('SELECT * FROM mcp_write_receipts WHERE connection_id=$1',[id])).rows,
    task:(await db.query("SELECT to_jsonb(t)-'importance'-'urgency' AS legacy FROM tasks t WHERE id=$1",[task.id])).rows
  });
  const before=await snapshot();
  await db.query(await readFile(new URL(migration,directory),'utf8'));
  assert.equal(JSON.stringify(await snapshot())===JSON.stringify(before),true,'Migration preserves key, grants, tasks and receipts');
  const added=(await db.query('SELECT board_selection,revision::text FROM mcp_connections WHERE id=$1',[id])).rows[0];
  assert.deepEqual(added,{board_selection:'selected',revision:'1'});
  // Exercise the actual runner adopting a legacy database and then skipping applied files.
  const migrate=()=>promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/migrate.ts',import.meta.url))],{env:{...process.env,DATABASE_URL:url},timeout:30_000});
  const first=await migrate();
  assert.match(first.stdout,/applied 016_mcp_lifecycle.sql/);
  assert.match(first.stdout,/applied 016_task_assessment.sql/);
  assert.match(first.stdout,/applied 017_chat_directions.sql/);
  // Assessment backfill is one UPDATE, so the existing revision trigger advances once.
  const afterAssessment={...before,task:before.task.map(row=>({legacy:{...row.legacy,revision:row.legacy.revision+1}}))};
  assert.deepEqual(await snapshot(),afterAssessment,'Full migration preserves legacy data with the single assessment revision bump');
  assert.deepEqual((await db.query('SELECT importance,urgency FROM tasks WHERE id=$1',[task.id])).rows,[{importance:null,urgency:null}]);
  const second=await migrate();
  assert.equal(second.stdout,'');
  assert.deepEqual(await snapshot(),afterAssessment,'Journaled rerun preserves the old key, grants, task and receipts');
  app=buildApp(config,db);
  const origin=await app.listen({host:'127.0.0.1',port:0}); config.publicUrl=origin;
  client=new Client({name:'migration-check',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+key}}}));
  const listed=(await client.callTool({name:'list_boards',arguments:{}})).structuredContent as any;
  assert.deepEqual(listed.items.map((board:any)=>board.id),[boardId]);
  assert.equal(listed.items.some((board:any)=>board.id===unknown.id),false);
  const read=(await client.callTool({name:'get_task',arguments:{boardId,taskId:task.id}})).structuredContent as any;
  assert.equal(read.title,'Legacy task');
  const replay=await app.inject({method:'POST',url:'/api/mcp-connections',cookies:{session:owner.token},headers:{host:new URL(origin).host,origin},payload:input});
  assert.equal(replay.json().code,'KEY_ALREADY_ISSUED','Legacy create fingerprint stays compatible');
  assert.equal(replay.body.includes(key),false);
  console.log('PASS: old schema/data, selected-only migration, unchanged key/grants/tasks/receipts, full idempotent migration rerun, HTTP/SDK old-key readback and legacy retry. Synthetic data only.');
} finally { await client?.close(); await app?.close(); await db.end(); }
