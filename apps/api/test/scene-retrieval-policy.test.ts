import { expect, it } from 'vitest';
import { DEFAULT_SCENE_SEARCH_RESULTS, SceneCandidateRanking, sceneCandidateCurrent, sceneOwnerVisible, sceneSearchSelection, validateSceneSearchLimit, type SceneVisibilityLogic } from '../src/domain/search/scene-retrieval';
it('preserves whole-course and explicit subset order while rejecting empty/foreign selections', () => {
  const allowed=new Set([4,2,1]);expect(sceneSearchSelection(allowed)).toEqual([4,2,1]);
  expect(sceneSearchSelection(allowed,[2,2,4])).toEqual([2,4]);expect(sceneSearchSelection(new Set())).toEqual([]);
  for(const ids of [[],[3],[1,3]])expect(()=>sceneSearchSelection(allowed,ids)).toThrow('non-empty subset');
  expect(DEFAULT_SCENE_SEARCH_RESULTS).toBe(20);
  for(const limit of [1,50])expect(()=>validateSceneSearchLimit(limit)).not.toThrow();
  for(const limit of [0,51,1.5,NaN,Infinity])expect(()=>validateSceneSearchLimit(limit)).toThrow('Search limit');
});
it('deduplicates physical identities with best score and retains the first equal-score candidate', () => {
  const ranking=new SceneCandidateRanking();
  const first={sceneId:'first',revision:'r1',vectorId:'shared',score:0.9};ranking.add(first);
  ranking.add({...first,sceneId:'duplicate',score:0.9});ranking.add({...first,sceneId:'worse',score:0.8});
  ranking.add({sceneId:'legacy',revision:'r1',score:0.5});ranking.add({sceneId:'legacy',revision:'r2',score:0.7});
  expect(ranking.ranked().map(item=>item.sceneId)).toEqual(['first','legacy','legacy']);
  ranking.add({...first,sceneId:'better',score:1});expect(ranking.ranked()[0].sceneId).toBe('better');
});
it('orders score ties by identity and keeps empty physical IDs distinct from legacy IDs', () => {
  const ranking=new SceneCandidateRanking();for(const vectorId of ['z','a',''])ranking.add({sceneId:'s',revision:'r',vectorId,score:1});
  ranking.add({sceneId:'s',revision:'r',score:1});expect(ranking.ranked().map(c=>c.vectorId)).toEqual(['','a',undefined,'z']);
});
it('requires current row, revision, selection and exact physical identity with legacy compatibility', () => {
  const row={id:'s',revision:'r1',vectorId:null,videoId:1},candidate={sceneId:'s',revision:'r1',score:1};
  expect(sceneCandidateCurrent(row,candidate,new Set([1]))).toBe(true);
  expect(sceneCandidateCurrent(undefined,candidate,new Set([1]))).toBe(false);
  expect(sceneCandidateCurrent({...row,revision:'old'},candidate,new Set([1]))).toBe(false);
  expect(sceneCandidateCurrent(row,candidate,new Set([2]))).toBe(false);
  expect(sceneCandidateCurrent(row,{...candidate,vectorId:'s'},new Set([1]))).toBe(true);
  expect(sceneCandidateCurrent(row,{...candidate,vectorId:'forged'},new Set([1]))).toBe(false);
  expect(sceneCandidateCurrent({...row,vectorId:'physical'},candidate,new Set([1]))).toBe(false);
  expect(sceneCandidateCurrent({...row,vectorId:'physical'},{...candidate,vectorId:'physical'},new Set([1]))).toBe(true);
});
it('preserves strict expiry, deactivation and unknown SQL visibility', () => {
  type Truth=boolean|null;
  const logic:SceneVisibilityLogic<number|null,Truth>={
    and:(a,b)=>a===false||b===false?false:a===null||b===null?null:true,
    or:(a,b)=>a===true||b===true?true:a===null||b===null?null:false,
    before:(expiry,now)=>expiry===null||now===null?null:expiry<now,
  };
  const facts={mediaAllowed:true,notDeactivated:true,notBanned:false,expires:100,now:100};
  expect(sceneOwnerVisible(facts,logic)).toBe(false);
  expect(sceneOwnerVisible({...facts,now:101},logic)).toBe(true);
  expect(sceneOwnerVisible({...facts,expires:null},logic)).toBeNull();
  expect(sceneOwnerVisible({...facts,notBanned:true,expires:null},logic)).toBe(true);
  expect(sceneOwnerVisible({...facts,notBanned:true,notDeactivated:false},logic)).toBe(false);
});
