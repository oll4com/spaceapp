import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
export interface ControlRecord {kind:"operation"|"layout"|"snapshot"|"schedule"|"grant"|"pane_state"; actorId:string; key:string; roomId:string; version:number; value:unknown}
export interface ControlRepository {
  get(kind:ControlRecord["kind"],actorId:string,key:string):Promise<ControlRecord|null>;
  list(kind:ControlRecord["kind"],actorId:string|null,roomId?:string):Promise<ControlRecord[]>;
  write(record:ControlRecord,expectedVersion:number):Promise<boolean>;
  withLock<T>(key:string,work:()=>Promise<T>):Promise<T>;
  dispose():Promise<void>;
}
export class InMemoryControlRepository implements ControlRepository {
  private records=new Map<string,ControlRecord>();
  private locks=new Map<string,Promise<unknown>>();
  async withLock<T>(key:string,work:()=>Promise<T>):Promise<T>{
    const prior=this.locks.get(key)??Promise.resolve();
    const next=prior.catch(()=>{}).then(work);this.locks.set(key,next);
    try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  private key(kind:string,actor:string,key:string){return JSON.stringify([kind,actor,key]);}
  async get(kind:ControlRecord["kind"],actorId:string,key:string){return structuredClone(this.records.get(this.key(kind,actorId,key))??null);}
  async list(kind:ControlRecord["kind"],actorId:string|null,roomId?:string){return structuredClone([...this.records.values()].filter(r=>r.kind===kind && (actorId===null||r.actorId===actorId)&&(!roomId||r.roomId===roomId)));}
  async write(record:ControlRecord,expectedVersion:number){const key=this.key(record.kind,record.actorId,record.key);if((this.records.get(key)?.version??0)!==expectedVersion)return false;this.records.set(key,structuredClone({...record,version:expectedVersion+1}));return true;}
  async dispose(){}
}
export class PostgresControlRepository implements ControlRepository {
  constructor(private pool:PgPoolLike,private lockPool:PgPoolLike=pool){}
  static fromConnectionString(url:string){return new PostgresControlRepository(createSpacePgPool(url,{max:4}),createSpacePgPool(url,{max:2}));}
  async withLock<T>(key:string,work:()=>Promise<T>):Promise<T>{
    const client=await this.lockPool.connect();
    try{
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 207))",[key]);
      try{return await work();}finally{await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 207))",[key]);}
    }finally{client.release?.();}
  }
  private row(r:{kind:ControlRecord["kind"];actor_id:string;record_key:string;room_id:string;version:number;value:unknown}):ControlRecord{return {kind:r.kind,actorId:r.actor_id,key:r.record_key,roomId:r.room_id,version:r.version,value:r.value};}
  async get(kind:ControlRecord["kind"],actorId:string,key:string){const r=await this.pool.query<any>("SELECT * FROM space_control_records WHERE kind=$1 AND actor_id=$2 AND record_key=$3",[kind,actorId,key]);return r.rows[0]?this.row(r.rows[0]):null;}
  async list(kind:ControlRecord["kind"],actorId:string|null,roomId?:string){const r=await this.pool.query<any>("SELECT * FROM space_control_records WHERE kind=$1 AND ($2::text IS NULL OR actor_id=$2) AND ($3::text IS NULL OR room_id=$3) ORDER BY updated_at DESC LIMIT 1000",[kind,actorId,roomId??null]);return r.rows.map(row=>this.row(row));}
  async write(r:ControlRecord,expectedVersion:number){
    const out=expectedVersion===0?await this.pool.query("INSERT INTO space_control_records(kind,actor_id,record_key,room_id,value) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING version",[r.kind,r.actorId,r.key,r.roomId,JSON.stringify(r.value)]):
      await this.pool.query("UPDATE space_control_records SET value=$5::jsonb,version=version+1,updated_at=now() WHERE kind=$1 AND actor_id=$2 AND record_key=$3 AND room_id=$4 AND version=$6 RETURNING version",[r.kind,r.actorId,r.key,r.roomId,JSON.stringify(r.value),expectedVersion]);
    return out.rows.length===1;
  }
  async dispose(){await (this.pool as PgPoolLike & {end?:()=>Promise<void>}).end?.();if(this.lockPool!==this.pool)await (this.lockPool as PgPoolLike & {end?:()=>Promise<void>}).end?.();}
}
