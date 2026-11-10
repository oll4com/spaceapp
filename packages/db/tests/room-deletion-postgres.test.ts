import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresImage } from "./support/disposable-postgres.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("deletes interior rooms without immediate unique-index collisions and serializes room compaction", async () => {
  const name = `space-room-order-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, {encoding:"utf8",timeout:30000,stdio:["ignore","pipe","pipe"]}).trim();
  let created = false;
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`; await mkdir(socket,{mode:0o777});
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`,{max:4});
  try {
    docker(["image","inspect",disposablePostgresImage]);
    docker(["run","--detach","--rm","--pull=never","--name",name,"--network","none","--mount",`type=bind,source=${socket},target=/var/run/postgresql`,"--env","POSTGRES_HOST_AUTH_METHOD=trust",disposablePostgresImage,"-c","listen_addresses="]); created=true;
    let ready=false;
    for(let i=0;i<60;i++) {try {if(docker(["exec",name,"cat","/proc/1/comm"])!=="postgres")throw Error("Initializing");await pool.query("SELECT 1");ready=true;break;}catch {await new Promise(r=>setTimeout(r,250));}}
    if(!ready)throw Error("Owned PostgreSQL unavailable");
    await pool.query(`CREATE TABLE rooms (id text PRIMARY KEY, name text NOT NULL, description text, project_path text, kind text DEFAULT 'AGENT_PROOF', room_order integer UNIQUE, pane_layout_columns integer DEFAULT 1, pane_layout_height integer DEFAULT 1, pane_cap integer DEFAULT 16, trace_id text DEFAULT 'trace:test', archived_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner_user_id text)`);
    // Reverse ID/order correlation exercises unique-index collisions during compaction.
    await pool.query(`INSERT INTO rooms(id,name,room_order) SELECT 'room:order-'||(7-n),'Synthetic '||n,n FROM generate_series(7,0,-1) n`);
    const store = new PostgresSpaceStore(pool);
    await store.deleteRoom("room:order-2");
    await Promise.all([store.deleteRoom("room:order-4"),store.deleteRoom("room:order-6")]);
    const remaining=await pool.query<{id:string;room_order:number}>("SELECT id,room_order FROM rooms ORDER BY room_order");
    expect(remaining.rows.map(r=>r.id)).toEqual([7,5,3,1,0].map(n=>`room:order-${n}`));
    expect(remaining.rows.map(r=>r.room_order)).toEqual([0,1,2,3,4]);
  } finally {
    await pool.end();
    if(created){try{docker(["exec","--user","root",name,"chmod","0777","/var/run/postgresql"]);}finally{docker(["rm","--force","--volumes",name]);}}
    await rm(root,{recursive:true,force:true});
  }
},60000);
