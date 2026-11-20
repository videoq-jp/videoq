import { expect, it } from 'vitest';
import { MAX_INLINE_TRANSCRIPT_BYTES, MAX_MATERIAL_DESCRIPTION_BYTES, type ContentReadLogic } from '../src/application/content-read';
import { evidenceVideoSelected, inlineTranscript, inlineMaterialDescription, visualEvidenceReady } from '../src/application/content-read';
const logic:ContentReadLogic<string|null,number|null,boolean|null>={
  atMost:(size,limit)=>size===null?null:size<=limit,
  above:(size,limit)=>size===null?null:size>limit,
  choose:(condition,yes,no)=>condition===true?yes:no,
  nullValue:()=>null,coalesceFalse:condition=>condition??false,
};
it('keeps exact UTF-8 byte boundaries inclusive and unknown length separate from oversized',()=>{
  expect(inlineTranscript('text',MAX_INLINE_TRANSCRIPT_BYTES,logic)).toEqual({value:'text',tooLarge:false});
  expect(inlineTranscript('text',MAX_INLINE_TRANSCRIPT_BYTES+1,logic)).toEqual({value:null,tooLarge:true});
  expect(inlineTranscript(null,null,logic)).toEqual({value:null,tooLarge:false});
  expect(inlineTranscript('',0,logic)).toEqual({value:'',tooLarge:false});
  expect(inlineMaterialDescription('text',MAX_MATERIAL_DESCRIPTION_BYTES,logic)).toBe('text');
  expect(inlineMaterialDescription('text',MAX_MATERIAL_DESCRIPTION_BYTES+1,logic)).toBeNull();
});
it('checks evidence scope independently of content retrieval',()=>{
  expect(evidenceVideoSelected([1,2],2)).toBe(true);expect(evidenceVideoSelected([],2)).toBe(false);expect(evidenceVideoSelected([1],2)).toBe(false);
});
it('requires both current file binding and published readiness',()=>{
  const logic={and:(a:boolean,b:boolean)=>a&&b,statusIs:(status:string,expected:'ready')=>status===expected};
  expect(visualEvidenceReady(true,'ready',logic)).toBe(true);
  expect(visualEvidenceReady(false,'ready',logic)).toBe(false);
  expect(visualEvidenceReady(true,'processing',logic)).toBe(false);
});
