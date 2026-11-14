import {BaseCheckpointSaver,WRITES_IDX_MAP,TASKS,compareWritesSortKeys,writesSortKey,getCheckpointId,maxChannelVersion,
  type Checkpoint,type CheckpointMetadata,type CheckpointTuple,type CheckpointListOptions,type ChannelVersions,type PendingWrite,type CheckpointPendingWrite,type SerializerProtocol} from "@langchain/langgraph-checkpoint";
import type {RunnableConfig} from "@langchain/core/runnables";
const ACCESS="EXISTS(SELECT 1 FROM chat_conversations WHERE thread_id=? AND lease_id=? AND julianday(leased_until)>julianday('now') AND julianday(expires_at)>julianday('now'))";
import {D1_CHECKPOINT_MAX_BYTES as MAX_BYTES} from './checkpoint-limits';
type Binary=number[]|ArrayBuffer|Uint8Array;
type Stored={checkpoint_id:string;parent_id:string|null;checkpoint_type:string;checkpoint:Binary;metadata_type:string;metadata:Binary};
type Write={task_id:string;idx:number;task_path:string;channel:string;value_type:string;value:Binary};
const bytes=(value:Binary)=>value instanceof Uint8Array?value:new Uint8Array(value instanceof ArrayBuffer?value:Uint8Array.from(value));
const buffer=(value:Uint8Array)=>Uint8Array.from(value).buffer;
export class D1CheckpointAccessError extends Error {constructor(){super('Conversation checkpoint lease is unavailable');}}
/** Request-scoped LangGraph saver. Every SQL operation is fenced to one live lease. */
export class D1CheckpointSaver extends BaseCheckpointSaver {
  constructor(private database:D1Database,private scope:{threadId:string;leaseId:string},serializer?:SerializerProtocol){super(serializer);if(!scope.threadId||!scope.leaseId)throw new Error('Missing checkpoint scope');}
  private identity(config:RunnableConfig){
    const thread:unknown=config.configurable?.thread_id;
    if(thread!==this.scope.threadId)throw new D1CheckpointAccessError();
    const namespace:unknown=config.configurable?.checkpoint_ns??'';
    const id:unknown=getCheckpointId(config);
    if(typeof namespace!=='string'||typeof id!=='string')throw new Error('Invalid checkpoint identity');
    return {namespace,id};
  }
  private async access(){return Boolean(await this.database.prepare(`SELECT 1 WHERE ${ACCESS}`).bind(this.scope.threadId,this.scope.leaseId).first());}
  private async writes(namespace:string,id:string):Promise<CheckpointPendingWrite[]>{
    const rows=(await this.database.prepare(`SELECT task_id,idx,task_path,channel,value_type,value FROM conversation_checkpoint_writes
      WHERE thread_id=? AND namespace=? AND checkpoint_id=? AND ${ACCESS}`).bind(this.scope.threadId,namespace,id,this.scope.threadId,this.scope.leaseId).all<Write>()).results;
    rows.sort((a,b)=>compareWritesSortKeys(writesSortKey(a.task_path,a.task_id,a.idx),writesSortKey(b.task_path,b.task_id,b.idx)));
    return Promise.all(rows.map(async row=>[row.task_id,row.channel,await this.serde.loadsTyped(row.value_type,bytes(row.value))] as CheckpointPendingWrite));
  }
  private async tuple(namespace:string,row:Stored):Promise<CheckpointTuple>{
    const checkpoint=await this.serde.loadsTyped(row.checkpoint_type,bytes(row.checkpoint)) as Checkpoint;
    if(checkpoint.v<4 && row.parent_id){
      checkpoint.channel_values[TASKS]=(await this.writes(namespace,row.parent_id)).filter(([,channel])=>channel===TASKS).map(([, ,value])=>value);
      const versions=Object.values(checkpoint.channel_versions);
      checkpoint.channel_versions[TASKS]=versions.length?maxChannelVersion(...versions):this.getNextVersion(undefined);
    }
    return {config:{configurable:{thread_id:this.scope.threadId,checkpoint_ns:namespace,checkpoint_id:row.checkpoint_id}},checkpoint,
      metadata:await this.serde.loadsTyped(row.metadata_type,bytes(row.metadata)) as CheckpointMetadata,
      ...(row.parent_id?{parentConfig:{configurable:{thread_id:this.scope.threadId,checkpoint_ns:namespace,checkpoint_id:row.parent_id}}}:{}),
      pendingWrites:await this.writes(namespace,row.checkpoint_id)};
  }
  async getTuple(config:RunnableConfig):Promise<CheckpointTuple|undefined>{
    const {namespace,id}=this.identity(config);
    const row=await this.database.prepare(`SELECT checkpoint_id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata FROM conversation_checkpoints
      WHERE thread_id=? AND namespace=? AND (?='' OR checkpoint_id=?) AND ${ACCESS} ORDER BY checkpoint_id DESC LIMIT 1`)
      .bind(this.scope.threadId,namespace,id,id,this.scope.threadId,this.scope.leaseId).first<Stored>();
    if(!row){if(!await this.access())throw new D1CheckpointAccessError();return undefined;}
    return this.tuple(namespace,row);
  }
  async *list(config:RunnableConfig,options:CheckpointListOptions={}):AsyncGenerator<CheckpointTuple>{
    const {namespace,id}=this.identity(config);
    let before:unknown=options.before?getCheckpointId(options.before):'';
    if(typeof before!=='string')throw new Error('Invalid checkpoint cursor');
    if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<0))throw new Error('Invalid checkpoint list limit');
    let remaining=options.limit??Infinity;
    while(remaining>0){
      const rows=(await this.database.prepare(`SELECT checkpoint_id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata FROM conversation_checkpoints
        WHERE thread_id=? AND namespace=? AND (?='' OR checkpoint_id=?) AND (?='' OR checkpoint_id<?) AND ${ACCESS}
        ORDER BY checkpoint_id DESC LIMIT 20`).bind(this.scope.threadId,namespace,id,id,before,before,this.scope.threadId,this.scope.leaseId).all<Stored>()).results;
      if(!rows.length){if(!await this.access())throw new D1CheckpointAccessError();return;}
      for(const row of rows){
        before=row.checkpoint_id;
        const tuple=await this.tuple(namespace,row);
        if(options.filter&&!Object.entries(options.filter).every(([key,value])=>(tuple.metadata as Record<string,unknown>)[key]===value))continue;
        yield tuple;if(--remaining<=0)return;
      }
      if(rows.length<20)return;
    }
  }
  async put(config:RunnableConfig,checkpoint:Checkpoint,metadata:CheckpointMetadata,_newVersions:ChannelVersions):Promise<RunnableConfig>{
    const {namespace,id}=this.identity(config);
    if(!checkpoint.id)throw new Error('Missing checkpoint id');
    const [[checkpointType,checkpointBytes],[metadataType,metadataBytes]]=await Promise.all([this.serde.dumpsTyped(checkpoint),this.serde.dumpsTyped(metadata)]);
    if(checkpointBytes.byteLength+metadataBytes.byteLength>MAX_BYTES)throw new Error('Conversation checkpoint exceeds D1 row budget');
    const result=await this.database.prepare(`INSERT INTO conversation_checkpoints(thread_id,namespace,checkpoint_id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata)
      SELECT ?,?,?,?,?,?,?,? WHERE ${ACCESS} ON CONFLICT(thread_id,namespace,checkpoint_id) DO UPDATE SET
      parent_id=excluded.parent_id,checkpoint_type=excluded.checkpoint_type,checkpoint=excluded.checkpoint,metadata_type=excluded.metadata_type,metadata=excluded.metadata RETURNING checkpoint_id`)
      .bind(this.scope.threadId,namespace,checkpoint.id,id||null,checkpointType,buffer(checkpointBytes),metadataType,buffer(metadataBytes),this.scope.threadId,this.scope.leaseId).all();
    if(!result.results.length)throw new D1CheckpointAccessError();
    return {configurable:{thread_id:this.scope.threadId,checkpoint_ns:namespace,checkpoint_id:checkpoint.id}};
  }
  async putWrites(config:RunnableConfig,writes:PendingWrite[],taskId:string,taskPath=''):Promise<void>{
    const {namespace,id}=this.identity(config);
    if(!id||!taskId)throw new Error('Missing checkpoint write identity');
    if(writes.length>128)throw new Error('Checkpoint write set exceeds D1 batch budget');
    const encoded=await Promise.all(writes.map(async([channel,value],index)=>{const [type,data]=await this.serde.dumpsTyped(value);return {channel,index:WRITES_IDX_MAP[channel]??index,type,data};}));
    if(encoded.reduce((size,row)=>size+row.data.byteLength,0)>MAX_BYTES)throw new Error('Checkpoint writes exceed D1 batch budget');
    const token=crypto.randomUUID();
    const statements=[this.database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'checkpoint_writes',0 WHERE ${ACCESS}`).bind(token,this.scope.threadId,this.scope.leaseId)];
    const update=writes.every(([channel])=>channel in WRITES_IDX_MAP);
    for(const row of encoded)statements.push(this.database.prepare(`INSERT INTO conversation_checkpoint_writes(thread_id,namespace,checkpoint_id,task_id,idx,task_path,channel,value_type,value)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) ON CONFLICT(thread_id,namespace,checkpoint_id,task_id,idx)
      ${update?'DO UPDATE SET task_path=excluded.task_path,channel=excluded.channel,value_type=excluded.value_type,value=excluded.value':'DO NOTHING'}`)
      .bind(this.scope.threadId,namespace,id,taskId,row.index,taskPath,row.channel,row.type,buffer(row.data),token));
    statements.push(this.database.prepare('SELECT token FROM mutation_receipts WHERE token=?').bind(token),this.database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token));
    const results=await this.database.batch(statements);
    if(!results[results.length-2].results.length)throw new D1CheckpointAccessError();
  }
  async deleteThread(threadId:string):Promise<void>{
    if(threadId!==this.scope.threadId)throw new D1CheckpointAccessError();
    const token=crypto.randomUUID();
    const results=await this.database.batch([
      this.database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'checkpoint_delete',0 WHERE ${ACCESS}`).bind(token,threadId,this.scope.leaseId),
      this.database.prepare('DELETE FROM conversation_checkpoint_writes WHERE thread_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(threadId,token),
      this.database.prepare('DELETE FROM conversation_checkpoints WHERE thread_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(threadId,token),
      this.database.prepare('SELECT token FROM mutation_receipts WHERE token=?').bind(token),
      this.database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token),
    ]);
    if(!results[3].results.length)throw new D1CheckpointAccessError();
  }
}
