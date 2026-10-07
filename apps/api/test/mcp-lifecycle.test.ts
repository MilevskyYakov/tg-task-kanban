import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createTask, login, renameBoard } from '../src/db.js';
import { createPairBoard, removePairMember } from '../src/pair-boards.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// All credentials below are ephemeral synthetic test data; never include them in diagnostics.
test('MCP lifecycle: atomic edits, auto access, membership loss, rotation, receipts and real barriers', async () => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0,6);
  const config: Config = {botToken:'test',databaseUrl:url,sessionSecret:'isolated-lifecycle',initDataMaxAgeSeconds:60,sessionMaxAgeSeconds:3600,host:'127.0.0.1',port:0,production:false,webhookSecret:'isolated-test',publicUrl:'http://127.0.0.1',botUsername:'test_bot'};
  const owner = await login(db,{id:stamp,first_name:'Lifecycle owner'},3600,config.sessionSecret);
  const other = await login(db,{id:stamp+1,first_name:'Lifecycle outsider'},3600,config.sessionSecret);
  const personal = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1',[owner.userId])).rows[0].id;
  const foreign = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1',[other.userId])).rows[0].id;
  const pair = await createPairBoard(db,other.userId,'Synthetic medals',randomUUID());
  await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member')",[pair.id,owner.userId]);
  const app = buildApp(config,db);
  const clients: Client[] = [];
  try {
    const origin = await app.listen({host:'127.0.0.1',port:0}); config.publicUrl=origin;
    const management = (method: 'POST'|'GET'|'PATCH'|'DELETE', path: string, payload?: object, person=owner, headers: Record<string,string>={}) => app.inject({method,url:'/api/mcp-connections'+path,cookies:{session:person.token},headers:{host:new URL(origin).host,origin,...headers},payload});
    const connect = async (key: string) => {
      const client = new Client({name:'isolated-lifecycle',version:'1'}); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+key}}})); return client;
    };
    const call = async (client: Client, name: string, args: Record<string,unknown>={}) => (await client.callTool({name,arguments:args})).structuredContent as any;
    const input = {requestId:randomUUID(),name:'Selected',mode:'write',boardIds:[personal]};
    const issued = await management('POST','',input); assert.equal(issued.statusCode,201);
    let current = issued.json().connection;
    const originalKey = issued.json().key;
    const path = '/'+current.id;
    const writer = await connect(originalKey);
    const readback = async () => (await management('GET',path)).json();
    const editPayload = (values: object={}) => ({requestId:randomUUID(),expectedVersion:current.version,expectedAccessVersion:current.accessVersion,name:current.name,mode:current.mode,boardSelection:current.boardSelection,boardIds:current.boardSelection==='all' ? [] : current.boards.map((b:any)=>b.id),confirmExpansion:true,...values});
    const edit = async (values: object={}) => {
      current=await readback();
      const response = await management('PATCH',path,editPayload(values));
      assert.equal(response.statusCode,200,response.json().code); current=response.json().connection; return response.json();
    };
    assert.equal(current.boardSelection,'selected'); assert.equal(current.version,'1');
    assert.match(current.accessVersion,/^[0-9a-f]{64}$/);
    assert.equal((await management('PATCH',path,editPayload({expectedAccessVersion:undefined}))).json().code,'INVALID_ARGUMENT');
    assert.equal((await management('PATCH',path,editPayload({expectedAccessVersion:'0'.repeat(64)}))).json().code,'VERSION_CONFLICT');
    assert.equal((await call(writer,'list_tasks',{boardId:pair.id})).error.code,'NOT_FOUND');
    const expansion = editPayload({boardIds:[personal,pair.id],confirmExpansion:false});
    assert.equal((await management('PATCH',path,expansion)).json().code,'EXPANSION_CONFIRMATION_REQUIRED');
    assert.equal((await readback()).version,current.version);
    for (const method of ['PATCH','POST','DELETE'] as const) {
      const target = path+(method==='POST' ? '/rotate' : '');
      const payload = method==='PATCH' ? expansion : {requestId:randomUUID(),expectedVersion:current.version};
      assert.equal((await management(method,target,payload,other)).statusCode,404);
      assert.equal((await management(method,target,payload,owner,{origin:'https://evil.invalid'})).statusCode,403);
      assert.equal((await app.inject({method,url:'/api/mcp-connections'+target,headers:{host:new URL(origin).host,origin,authorization:'Bearer '+originalKey},payload})).statusCode,401);
      assert.equal((await app.inject({method,url:'/api/mcp-connections'+target,cookies:{session:owner.token},headers:{host:new URL(origin).host},payload})).statusCode,403);
      assert.equal((await management(method,target,undefined,owner,{'content-type':'text/plain'})).statusCode,400);
    }
    assert.equal((await management('PATCH',path,editPayload({boardIds:[personal,foreign]}))).statusCode,404);
    assert.equal((await readback()).version,current.version,'failed edit is atomic');
    const add = editPayload({name:'Renamed connection',boardIds:[personal,pair.id]});
    current=(await management('PATCH',path,add)).json().connection;
    assert.equal((await management('PATCH',path,add)).json().replayed,true);
    assert.equal((await management('PATCH',path,{...add,name:'Other payload'})).json().code,'REQUEST_CONFLICT');
    assert.equal((await call(writer,'list_boards')).items.length,2,'same key sees new grant');
    await renameBoard(db,other.userId,pair.id,'Synthetic Reels');
    assert.equal((await readback()).accessVersion,current.accessVersion,'board rename does not change effective-access version');
    const renamed=(await call(writer,'list_boards')).items.filter((b:any)=>b.id===pair.id);
    assert.equal(renamed.length,1); assert.equal(renamed[0].name,'Synthetic Reels');
    const task=await createTask(db,owner.userId,pair.id,{title:'Synthetic task'});
    const offered=(await writer.listTools()).tools;
    assert.equal(offered.length,20);
    await edit({boardIds:[personal]});
    // Every tool with a boardId is denied before business logic, including cached write names.
    const toolArgs: Record<string,object> = {
      list_projects:{},list_members:{},list_tasks:{},get_task:{taskId:task.id},get_task_collaboration:{taskId:task.id},
      create_task:{title:'Forbidden'},update_task:{taskId:task.id,expectedVersion:'1',changes:{title:'Forbidden'}},claim_task:{taskId:task.id},archive_task:{taskId:task.id,archived:true},
      create_project:{name:'Forbidden'},update_project:{projectId:randomUUID(),name:'Forbidden'},
      add_task_comment:{taskId:task.id,body:'Forbidden'},add_checklist_item:{taskId:task.id,text:'Forbidden'},
      update_checklist_item:{taskId:task.id,itemId:randomUUID(),patch:{completed:true}},delete_checklist_item:{taskId:task.id,itemId:randomUUID()},
      add_task_attachment:{taskId:task.id,url:'https://example.com'},list_recurrences:{},
      create_recurrence:{title:'Forbidden',frequency:'daily',localTime:'10:00',timezone:'UTC',startAt:'2030-01-01T00:00:00Z'},update_recurrence:{recurrenceId:randomUUID(),paused:true}
    };
    assert.equal(Object.keys(toolArgs).length,offered.length-1);
    for (const tool of offered.filter(tool=>tool.name!=='list_boards')) {
      const requestId = tool.annotations?.readOnlyHint ? {} : {requestId:randomUUID()};
      assert.equal((await call(writer,tool.name,{boardId:pair.id,...requestId,...toolArgs[tool.name]})).error.code,'NOT_FOUND',tool.name);
    }
    assert.equal((await call(writer,'list_boards')).items.some((b:any)=>b.id===pair.id),false);
    await edit({mode:'read'});
    assert.equal((await writer.listTools()).tools.length,7);
    for (const tool of offered.filter(tool=>!tool.annotations?.readOnlyHint)) assert.equal((await call(writer,tool.name,{boardId:personal,requestId:randomUUID(),...toolArgs[tool.name]})).error.code,'READ_ONLY',tool.name);
    assert.equal((await call(writer,'list_tasks',{boardId:personal})).ok,true);
    assert.equal((await management('PATCH',path,editPayload({mode:'write',confirmExpansion:false}))).json().code,'EXPANSION_CONFIRMATION_REQUIRED');
    await edit({boardSelection:'all',boardIds:[],mode:'write'});
    const future = await createPairBoard(db,owner.userId,'Future synthetic board',randomUUID());
    assert.equal((await call(writer,'list_boards')).items.some((b:any)=>b.id===future.id),true);
    assert.equal((await call(writer,'create_task',{boardId:future.id,requestId:randomUUID(),title:'Auto write'})).ok,true);
    await edit({mode:'read'});
    const futureRead=await createPairBoard(db,owner.userId,'Future read-only board',randomUUID());
    assert.equal((await call(writer,'list_tasks',{boardId:futureRead.id})).ok,true);
    assert.equal((await call(writer,'create_task',{boardId:futureRead.id,requestId:randomUUID(),title:'No auto write'})).error.code,'READ_ONLY');
    await edit({mode:'write'});
    for (const state of ['draft','frozen','archived']) {
      await db.query('UPDATE boards SET status=$2 WHERE id=$1',[future.id,state]);
      assert.equal((await call(writer,'list_tasks',{boardId:future.id})).ok,true);
      for (const tool of offered.filter(tool=>!tool.annotations?.readOnlyHint)) assert.equal((await call(writer,tool.name,{boardId:future.id,requestId:randomUUID(),...toolArgs[tool.name]})).error.code,'BOARD_READ_ONLY',tool.name);
    }
    await db.query("UPDATE boards SET status='active' WHERE id=$1",[future.id]);
    await removePairMember(db,other.userId,pair.id,owner.userId);
    assert.equal(JSON.stringify(await readback()).includes('Synthetic Reels'),false,'no inaccessible names');
    await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member')",[pair.id,owner.userId]);
    assert.equal((await call(writer,'list_tasks',{boardId:pair.id})).error.code,'NOT_FOUND');
    assert.equal((await management('PATCH',path,editPayload({name:'Stale auto rename'}))).json().code,'VERSION_CONFLICT');
    await edit({name:'Auto renamed'});
    assert.equal((await call(writer,'list_tasks',{boardId:pair.id})).error.code,'NOT_FOUND','rename cannot restore a lost tenure');
    assert.equal((await readback()).excludedBoards.some((b:any)=>b.id===pair.id),true);
    // Loss and rejoin without any intervening MCP call, including an automatically added board.
    await db.query('DELETE FROM memberships WHERE board_id=$1 AND user_id=$2',[future.id,owner.userId]);
    await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'owner')",[future.id,owner.userId]);
    assert.equal((await call(writer,'list_tasks',{boardId:future.id})).error.code,'NOT_FOUND');
    await edit({boardSelection:'selected',boardIds:[personal,pair.id]});
    assert.equal((await call(writer,'get_task',{boardId:pair.id,taskId:task.id})).ok,true,'explicit confirmed regrant');
    await removePairMember(db,other.userId,pair.id,owner.userId);
    await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member')",[pair.id,owner.userId]);
    assert.equal((await call(writer,'get_task',{boardId:pair.id,taskId:task.id})).error.code,'NOT_FOUND','selected rejoin also denied');
    // A cached form must not silently regrant a lost board, even while explicitly adding another one.
    for (const boardIds of [[personal,pair.id],[personal,pair.id,futureRead.id]]) {
      const stale=await management('PATCH',path,editPayload({name:'Stale rename',boardIds}));
      assert.equal(stale.statusCode,409,'stale access confirmation must fail closed');
      assert.equal(stale.json().code,'VERSION_CONFLICT');
      assert.equal((await readback()).version,current.version);
      assert.equal((await call(writer,'get_task',{boardId:pair.id,taskId:task.id})).error.code,'NOT_FOUND');
    }
    current=await readback();
    // Two stale editors cannot overwrite each other; receipt replay never reapplies an older edit.
    assert.equal((await management('PATCH',path,editPayload({boardIds:[personal,pair.id],confirmExpansion:false}))).json().code,'EXPANSION_CONFIRMATION_REQUIRED','fresh access version is not expansion approval');
    const first=editPayload({name:'First editor',boardIds:[personal]}), second=editPayload({name:'Second editor',boardIds:[personal]});
    const competing=await Promise.all([management('PATCH',path,first),management('PATCH',path,second)]);
    assert.deepEqual(competing.map(r=>r.statusCode).sort(),[200,409]);
    assert.equal(competing.find(r=>r.statusCode===409)!.json().code,'VERSION_CONFLICT');
    current=await readback();
    assert.equal((await management('PATCH',path,add)).json().connection.version,current.version);
    assert.equal((await readback()).name,current.name);
    await edit({boardIds:[]});
    assert.equal((await call(writer,'list_boards')).items.length,0,'empty selected list can remove the last board without revoking the key');
    await edit({boardIds:[personal]});
    // Rotation is once-only even with parallel identical intents and a lost response.
    const rotation={requestId:randomUUID(),expectedVersion:current.version};
    const rotations=await Promise.all([management('POST',path+'/rotate',rotation),management('POST',path+'/rotate',rotation)]);
    assert.deepEqual(rotations.map(r=>r.statusCode).sort(),[200,409]);
    const replacement=rotations.find(r=>r.statusCode===200)!.json();
    assert.equal(rotations.find(r=>r.statusCode===409)!.json().code,'KEY_ALREADY_ISSUED');
    assert.deepEqual(replacement.connection.boards,current.boards); assert.equal(replacement.connection.name,current.name);
    current=replacement.connection;
    assert.equal((await fetch(origin+'/mcp',{headers:{Authorization:'Bearer '+originalKey}})).status,401);
    const replacementClient=await connect(replacement.key);
    assert.equal((await call(replacementClient,'list_tasks',{boardId:personal})).ok,true);
    assert.equal((await management('POST',path+'/rotate',{...rotation,expectedVersion:current.version})).json().code,'REQUEST_CONFLICT');
    assert.equal((await management('POST',path+'/rotate',rotation)).body.includes(replacement.key),false);
    const stored=(await db.query('SELECT key_hash FROM mcp_connections WHERE id=$1',[current.id])).rows[0];
    assert.equal(stored.key_hash===hash(replacement.key),true);
    // Inject failure after key/settings update: receipt, audit and changes all roll back.
    const failId=randomUUID();
    await db.query(`ALTER TABLE mcp_connection_events ADD CONSTRAINT lifecycle_fault CHECK (request_id <> '${failId}'::uuid) NOT VALID`);
    try {
      assert.equal((await management('POST',path+'/rotate',{requestId:failId,expectedVersion:current.version})).statusCode,503);
      assert.equal((await readback()).version,current.version);
      assert.equal((await db.query('SELECT key_hash FROM mcp_connections WHERE id=$1',[current.id])).rows[0].key_hash===stored.key_hash,true);
      assert.equal((await management('PATCH',path,editPayload({requestId:failId,name:'Must roll back',boardIds:[pair.id]}))).statusCode,503);
      assert.equal((await readback()).name,current.name);
      assert.deepEqual((await readback()).boards,current.boards);
    } finally { await db.query('ALTER TABLE mcp_connection_events DROP CONSTRAINT lifecycle_fault'); }
    // Real PostgreSQL waits, not timers as evidence: MCP holds connection while blocked on board.
    const waitBlocked = async (pid: number) => {
      for (let attempt=0;attempt<100;attempt++) {
        if ((await db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount) return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('Expected a real blocked transaction');
    };
    let activeKey=replacement.key, activeClient=replacementClient;
    for (const action of ['downgrade','remove','rotate','revoke'] as const) {
      if (action==='remove') await edit({mode:'write',boardIds:[personal,pair.id]});
      if (action==='rotate' || action==='revoke') await edit({mode:'write',boardIds:[personal]});
      const holder=await db.connect(); let inFlight: Promise<any>|undefined; let changing: Promise<any>|undefined;
      try {
        await holder.query('BEGIN');
        const pid=(await holder.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[personal]);
        inFlight=call(activeClient,'create_task',{boardId:personal,requestId:randomUUID(),title:'Before '+action});
        await waitBlocked(pid);
        let finished=false;
        const payload=action==='downgrade' ? editPayload({mode:'read'}) : action==='remove' ? editPayload({boardIds:[pair.id]}) : {requestId:randomUUID(),expectedVersion:current.version};
        changing=management(action==='rotate' ? 'POST' : action==='revoke' ? 'DELETE' : 'PATCH',path+(action==='rotate' ? '/rotate' : ''),payload).then(r=>{finished=true;return r;});
        // Observe the management statement waiting for a connection row, with both transactions live.
        for (let attempt=0;attempt<100;attempt++) {
          const blocked=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT%FROM mcp_connections%FOR UPDATE%'");
          if (blocked.rowCount) break;
          if (attempt===99) assert.fail('Management did not wait on connection');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(finished,false);
        await holder.query('COMMIT');
        assert.equal((await inFlight).ok,true);
        const response=await changing; assert.equal(response.statusCode,200,response.json().code); current=await readback();
        if (action==='rotate') {
          assert.equal((await fetch(origin+'/mcp',{headers:{Authorization:'Bearer '+activeKey}})).status,401);
          activeKey=response.json().key; activeClient=await connect(activeKey);
        } else if (action==='revoke') assert.equal((await fetch(origin+'/mcp',{headers:{Authorization:'Bearer '+activeKey}})).status,401);
        else assert.equal((await call(activeClient,'create_task',{boardId:personal,requestId:randomUUID(),title:'After barrier'})).error.code,action==='downgrade' ? 'READ_ONLY' : 'NOT_FOUND');
      } finally { await holder.query('ROLLBACK'); holder.release(); await inFlight; await changing; }
    }
    assert.equal((await management('PATCH',path,editPayload({boardSelection:'all',boardIds:[]}))).json().code,'CONNECTION_REVOKED');
    assert.equal((await management('POST',path+'/rotate',{requestId:randomUUID(),expectedVersion:current.version})).json().code,'CONNECTION_REVOKED');
    assert.equal((await management('DELETE',path,{})).statusCode,200);
    const events=(await db.query('SELECT * FROM mcp_connection_events WHERE connection_id=$1',[current.id])).rows;
    assert.ok(events.some(e=>e.action==='created') && events.some(e=>e.action==='edited') && events.some(e=>e.action==='rotated') && events.some(e=>e.action==='revoked'));
    assert.equal(events.filter(e=>e.request_id===rotation.requestId).length,1);
    for (const key of [originalKey,replacement.key,activeKey]) assert.equal(JSON.stringify(events).includes(key),false);
    assert.equal(JSON.stringify(events).includes('Synthetic task'),false);
    assert.equal(JSON.stringify(await readback()).includes('key_hash'),false);
    // Different intents at one revision: at most one key/settings transition, no resurrection.
    for (const actions of [['edit','rotate'],['rotate','revoke'],['edit','revoke'],['rotate','rotate']] as const) {
      const issued=await management('POST','',{requestId:randomUUID(),name:'Race fixture',mode:'write',boardSelection:'all',boardIds:[]});
      assert.equal(issued.statusCode,201);
      const connection=issued.json().connection;
      const requests=actions.map(action=>({action,payload:{requestId:randomUUID(),expectedVersion:connection.version,...(action==='edit' ? {expectedAccessVersion:connection.accessVersion,name:'Race renamed',mode:'read',boardSelection:'selected',boardIds:[personal],confirmExpansion:false} : {})}}));
      const outcomes=await Promise.all(requests.map(({action,payload})=>management(action==='edit' ? 'PATCH' : action==='rotate' ? 'POST' : 'DELETE','/'+connection.id+(action==='rotate' ? '/rotate' : ''),payload)));
      assert.deepEqual(outcomes.map(r=>r.statusCode).sort(),[200,409]);
      assert.ok(['VERSION_CONFLICT','CONNECTION_REVOKED'].includes(outcomes.find(r=>r.statusCode===409)!.json().code));
      const snapshot=(await management('GET','/'+connection.id)).json();
      assert.equal(snapshot.version,'2');
      const audit=(await db.query('SELECT action FROM mcp_connection_events WHERE connection_id=$1',[connection.id])).rows;
      assert.equal(audit.length,2,'creation plus exactly one committed mutation');
      const winning=requests[outcomes.findIndex(r=>r.statusCode===200)];
      const replay=await management(winning.action==='edit' ? 'PATCH' : winning.action==='rotate' ? 'POST' : 'DELETE','/'+connection.id+(winning.action==='rotate' ? '/rotate' : ''),winning.payload);
      assert.equal(winning.action==='rotate' ? replay.json().code : replay.statusCode,winning.action==='rotate' ? 'KEY_ALREADY_ISSUED' : 200);
      assert.equal((await management('GET','/'+connection.id)).json().version,'2');
      if (snapshot.revokedAt) assert.equal((await management('PATCH','/'+connection.id,{requestId:randomUUID(),expectedVersion:'2',expectedAccessVersion:snapshot.accessVersion,name:'No revival',mode:'write',boardSelection:'all',boardIds:[],confirmExpansion:true})).json().code,'CONNECTION_REVOKED');
    }
    const deletionFixture=(await management('POST','',{requestId:randomUUID(),name:'Membership barrier',mode:'write',boardSelection:'all',boardIds:[]})).json();
    const deletionClient=await connect(deletionFixture.key);
    const holder=await db.connect(); let writing: Promise<any>|undefined; let editing: Promise<any>|undefined;
    try {
      await holder.query('BEGIN');
      const pid=(await holder.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[pair.id]);
      writing=call(deletionClient,'create_task',{boardId:pair.id,requestId:randomUUID(),title:'Must not cross member removal'});
      await waitBlocked(pid);
      editing=management('PATCH','/'+deletionFixture.connection.id,{requestId:randomUUID(),expectedVersion:'1',expectedAccessVersion:deletionFixture.connection.accessVersion,name:'Concurrent rename',mode:'write',boardSelection:'all',boardIds:[],confirmExpansion:false});
      // This transaction holds the board, the tool holds the connection. The loss trigger must not lock the connection.
      await holder.query("SET LOCAL statement_timeout='2s'");
      await holder.query('DELETE FROM memberships WHERE board_id=$1 AND user_id=$2',[pair.id,owner.userId]);
      await holder.query('COMMIT');
      assert.equal((await writing).error.code,'NOT_FOUND');
      const editResult=await editing;
      assert.equal(editResult.statusCode,409);
      assert.equal(editResult.json().code,'VERSION_CONFLICT','membership changed while the edit waited, without a reverse-lock deadlock');
      await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member')",[pair.id,owner.userId]);
      assert.equal((await call(deletionClient,'get_task',{boardId:pair.id,taskId:task.id})).error.code,'NOT_FOUND');
    } finally { await holder.query('ROLLBACK'); holder.release(); await writing; await editing; }
  } finally {
    await Promise.all(clients.map(client=>client.close().catch(()=>undefined))); await app.close();
    await db.query('DELETE FROM boards WHERE owner_user_id=ANY($1)',[[owner.userId,other.userId]]);
    await db.query('DELETE FROM users WHERE id=ANY($1)',[[owner.userId,other.userId]]); await db.end();
  }
});
