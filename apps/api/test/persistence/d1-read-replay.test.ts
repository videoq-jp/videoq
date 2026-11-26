import {it,expect} from 'vitest';
import {replayDatabase,type ReadObservation} from '../../scripts/acceptance/d1-read-replay';
it('preserves positional duplicate-column raw values and first/all semantics while requiring read metadata',async()=>{
 const observations:ReadObservation[]=[];
 const database=replayDatabase(async()=>({success:true,meta:{rows_read:9,rows_written:0},results:{columns:['id','id'],rows:[[1,2]]}}),row=>observations.push(row));
 expect(await database.prepare('SELECT ids').raw()).toEqual([[1,2]]);
 expect(await database.prepare('SELECT ids').raw({columnNames:true})).toEqual([['id','id'],[1,2]]);
 expect(await database.prepare('SELECT ids').first('id')).toBe(2);
 expect((await database.prepare('SELECT ids').all()).meta.rows_read).toBe(9);
 expect(observations).toHaveLength(4);expect(observations.every(row=>row.rowsRead===9&&row.rowsWritten===0)).toBe(true);
 const missing=replayDatabase(async()=>({success:true,meta:{},results:{columns:[],rows:[]}}),()=>{});
 await expect(missing.prepare('SELECT ids').raw()).rejects.toThrow('metadata unavailable');
});
