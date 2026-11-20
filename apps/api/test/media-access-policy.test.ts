import { expect, it } from 'vitest';
import { mediaAccessMode, mediaAuthenticatedPermission, mediaSharedPermission, mediaSharedPathValue } from '../src/application/media-access';
it('gives explicit shares priority even for owners, empty slugs and unsafe paths', () => {
  expect(mediaAccessMode('lesson.mp4',{userId:'owner',shareSlug:''})).toEqual({kind:'shared',shareSlug:'',safePath:true});
  expect(mediaAccessMode('../lesson.mp4',{userId:'owner',shareSlug:'public'})).toEqual({kind:'shared',shareSlug:'public',safePath:false});
  expect(mediaAccessMode('lesson.mp4',{userId:'owner',shareSlug:null})).toEqual({kind:'user',userId:'owner'});
});
it('denies unsafe or anonymous nonshared reads and preserves literal empty actor IDs', () => {
  expect(mediaAccessMode('lesson.mp4',{})).toEqual({kind:'denied'});
  expect(mediaAccessMode('../lesson.mp4',{userId:'owner'})).toEqual({kind:'denied'});
  expect(mediaAccessMode('lesson.mp4',{userId:''})).toEqual({kind:'user',userId:''});
});
it('requires safe shared membership and admits independent owners or eligible native members', () => {
  const logic={and:(a:boolean,b:boolean)=>a&&b,or:(a:boolean,b:boolean)=>a||b};
  for(const a of [false,true])for(const b of [false,true]){
    expect(mediaSharedPermission(a,b,logic)).toBe(a&&b);
    expect(mediaAuthenticatedPermission(a,b,logic)).toBe(a||b);
  }
});

it('does not evaluate an unsafe path comparison while preserving share resolution', () => {
  let compared=false;
  expect(mediaSharedPathValue(false,()=>{compared=true;return true;},false)).toBe(false);
  expect(compared).toBe(false);
  expect(mediaSharedPathValue(true,()=>true,false)).toBe(true);
});
