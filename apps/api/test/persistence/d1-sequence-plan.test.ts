import {expect,it} from 'vitest';
import {planSequenceRestore} from '../../scripts/migrations/d1/restore-sequences';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import type {SequenceState} from '../../scripts/migrations/d1/sequence-format';
const manifest=buildMigrationManifest({dialect:'postgresql',tables:{probe:{name:'probe',columns:{id:{name:'id',type:'bigint',notNull:true}}}}},{dialect:'sqlite',tables:{probe:{name:'probe',columns:{id:{name:'id',type:'integer',notNull:true}}}}});
const base:SequenceState={schema:'public',name:'probe_id_seq',owner_schema:'public',owner_table:'probe',owner_column:'id',last_value:'100',is_called:true,increment_by:'1',min_value:'1',max_value:'9223372036854775807',cache_size:'1',cycle:false};
it('plans called and restarted sequence states without rounding or adding unused cache slots',()=>{
 expect(planSequenceRestore([base],manifest)).toEqual([{table:'probe',column:'id',floor:100}]);
 expect(planSequenceRestore([{...base,is_called:false}],manifest)[0].floor).toBe(99);
 expect(planSequenceRestore([{...base,last_value:'1',is_called:false}],manifest)[0].floor).toBe(0);
 expect(planSequenceRestore([{...base,cache_size:'32'}],manifest)[0].floor).toBe(100);
 expect(planSequenceRestore([{...base,last_value:'9007199254740990'}],manifest)[0].floor).toBe(9007199254740990);
});
it.each([{increment_by:'2'},{increment_by:'-1'},{min_value:'2'},{max_value:'1000'},{cycle:true},{cache_size:'0'},{last_value:'0'},{last_value:'-1'},{last_value:'9007199254740991'},{last_value:'9007199254740992',is_called:false},{owner_schema:'other'},{owner_table:null,owner_column:null,owner_schema:null},{owner_table:'unknown'},{owner_column:'unknown'}] as Partial<SequenceState>[])('rejects unsupported or unsafe sequence metadata %j',patch=>{
 expect(()=>planSequenceRestore([{...base,...patch}],manifest)).toThrow();
});
it('refuses ambiguous ownership instead of choosing an arbitrary high-water mark',()=>{
 expect(()=>planSequenceRestore([base,{...base,name:'second_seq'}],manifest)).toThrow('Ambiguous');
});
