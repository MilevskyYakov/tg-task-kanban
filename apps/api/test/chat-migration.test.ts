import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDatabase } from '../src/db.js';
import { chatContext, createChatDirection } from '../src/chat-boards.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
test('legacy data migration preserves IDs, schedules and links; rerunning does not recreate per-board schedules', async t => {
  const admin = createDatabase(process.env.TEST_DATABASE_URL!);
  const name = `migration_${randomBytes(8).toString('hex')}`;
  const target = new URL(process.env.TEST_DATABASE_URL!); target.pathname = `/${name}`;
  const db = createDatabase(target.href);
  const directory = new URL('../migrations/', import.meta.url);
  const root = randomUUID(), task = randomUUID(), project = randomUUID();
  const run = promisify(execFile);
  const migrate = () => run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/migrate.ts', import.meta.url))], {env: {...process.env, DATABASE_URL: target.href}, timeout: 10_000});
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok: true, result: {status: 'administrator'}}));
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && file < '017_').sort()) await db.query(await readFile(new URL(file, directory), 'utf8'));
    const user = (await db.query("INSERT INTO users (telegram_id,first_name) VALUES (176,'Legacy admin') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat','Существующая доска',-176,'active')", [root]);
    await db.query("INSERT INTO memberships VALUES ($1,$2,'admin')", [root,user]);
    await db.query("INSERT INTO projects (id,board_id,name,created_by) VALUES ($1,$2,'Существующий проект',$3)", [project,root,user]);
    await db.query("INSERT INTO tasks (id,board_id,project_id,title,creator_user_id) VALUES ($1,$2,$3,'История остаётся',$4)", [task,root,project,user]);
    await db.query("INSERT INTO board_links (token_hash,board_id,kind) VALUES ('synthetic-legacy-launch',$1,'launch')", [root]);
    await db.query("INSERT INTO publication_schedules (board_id,kind,enabled,weekdays,local_time,timezone) VALUES ($1,'daily',true,ARRAY[2,4]::smallint[],'06:17','Asia/Tokyo'),($1,'weekly',false,ARRAY[6]::smallint[],'22:53','America/New_York')", [root]);
    await db.query("INSERT INTO publication_runs (id,board_id,kind,local_date,status,attempts) VALUES ($1,$4,'daily','2030-01-01','pending',0),($2,$4,'daily','2030-01-02','pending',1),($3,$4,'daily','2030-01-03','sending',1)", [randomUUID(),randomUUID(),randomUUID(),root]);
    const snapshot = async () => ({
      tasks: (await db.query('SELECT * FROM tasks ORDER BY id')).rows,
      projects: (await db.query('SELECT * FROM projects ORDER BY id')).rows,
      members: (await db.query('SELECT * FROM memberships ORDER BY board_id,user_id')).rows,
      links: (await db.query('SELECT * FROM board_links ORDER BY token_hash')).rows,
      schedules: (await db.query('SELECT board_id,kind,enabled,weekdays,local_time,timezone,included_statuses,updated_at FROM publication_schedules ORDER BY kind')).rows
    });
    const before = await snapshot();
    const first = await migrate(); assert.match(first.stdout, /applied 017_chat_directions.sql/);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await db.query('SELECT status FROM publication_runs ORDER BY local_date')).rows.map(row => row.status), ['pending','uncertain','uncertain']);
    const context = await chatContext(db,user,root,'test');
    const child = await createChatDirection(db,user,root,'test',{name:'Новая доска',requestId:randomUUID(),memberVersion:context.memberVersion,memberIds:[user]});
    const after = await snapshot();
    const second = await migrate(); assert.equal(second.stdout, ''); assert.deepEqual(await snapshot(), after);
    assert.equal((await db.query('SELECT count(*) FROM publication_schedules WHERE board_id=$1',[child.id])).rows[0].count,'0');
    assert.equal((await db.query('SELECT count(*) FROM tasks WHERE board_id=$1',[root])).rows[0].count,'1');
    await db.query("DELETE FROM schema_migrations WHERE name='017_chat_directions.sql'");
    await db.query("UPDATE publication_schedules SET included_board_ids=NULL WHERE board_id=$1 AND kind='daily'", [root]);
    await db.query('ALTER TABLE publication_schedules ADD CONSTRAINT migration_failure_fixture CHECK (included_board_ids IS NULL) NOT VALID');
    await assert.rejects(migrate, (error: {code?: string | number; killed?: boolean}) => error.code === 1 && !error.killed);
    assert.equal((await db.query("SELECT count(*) FROM schema_migrations WHERE name='017_chat_directions.sql'")).rows[0].count, '0');
    await db.query('ALTER TABLE publication_schedules DROP CONSTRAINT migration_failure_fixture');
    await migrate();
    assert.equal((await db.query('SELECT count(*) FROM boards WHERE id=$1', [child.id])).rows[0].count, '1');
    // The previous runtime's ON CONFLICT target is no longer compatible. Do not roll back to it.
    await assert.rejects(db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat','Old runtime',-176,'draft') ON CONFLICT (telegram_chat_id) WHERE type='chat' DO NOTHING",[randomUUID()]), /no unique or exclusion constraint/);
    t.diagnostic(JSON.stringify({migration: '017', preserved: ['board ID','task ID','project ID','memberships','links','independent timezones'], rerun: 'no-op', failure: 'rollback and release connection', oldRuntime: 'incompatible after migration 017'}));
  } finally { await db.end(); await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end(); }
});
