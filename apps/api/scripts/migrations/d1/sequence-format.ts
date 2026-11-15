import {z} from 'zod';
const identifier=z.string().min(1).refine(value=>!value.includes('\0'));
const integer=z.string().regex(/^-?\d+$/);
export const sequenceStateSchema=z.object({schema:identifier,name:identifier,last_value:integer,is_called:z.boolean(),increment_by:integer,min_value:integer,max_value:integer,cache_size:integer,cycle:z.boolean(),owner_schema:identifier.nullable(),owner_table:identifier.nullable(),owner_column:identifier.nullable()}).strict().refine(value=>[value.owner_schema,value.owner_table,value.owner_column].every(item=>item===null)||[value.owner_schema,value.owner_table,value.owner_column].every(item=>item!==null));
export type SequenceState=z.infer<typeof sequenceStateSchema>;
