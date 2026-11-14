import {blob,integer,primaryKey,sqliteTable,text,index} from "drizzle-orm/sqlite-core";
import {chatConversations} from "./modern";
export const conversationCheckpoints=sqliteTable("conversation_checkpoints",{
  threadId:text("thread_id").notNull().references(()=>chatConversations.threadId,{onDelete:"cascade"}),
  namespace:text("namespace").notNull(),checkpointId:text("checkpoint_id").notNull(),parentId:text("parent_id"),
  checkpointType:text("checkpoint_type").notNull(),checkpoint:blob("checkpoint",{mode:"buffer"}).notNull(),
  metadataType:text("metadata_type").notNull(),metadata:blob("metadata",{mode:"buffer"}).notNull(),
},table=>[primaryKey({columns:[table.threadId,table.namespace,table.checkpointId]})]);
export const conversationCheckpointWrites=sqliteTable("conversation_checkpoint_writes",{
  threadId:text("thread_id").notNull().references(()=>chatConversations.threadId,{onDelete:"cascade"}),namespace:text("namespace").notNull(),
  checkpointId:text("checkpoint_id").notNull(),taskId:text("task_id").notNull(),index:integer("idx").notNull(),taskPath:text("task_path").notNull().default(""),
  channel:text("channel").notNull(),valueType:text("value_type").notNull(),value:blob("value",{mode:"buffer"}).notNull(),
},table=>[primaryKey({columns:[table.threadId,table.namespace,table.checkpointId,table.taskId,table.index]}),
  index("conversation_checkpoint_writes_lookup_idx").on(table.threadId,table.namespace,table.checkpointId)]);
