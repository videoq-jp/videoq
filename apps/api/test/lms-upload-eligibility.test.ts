import { expect, it } from 'vitest';
import { lmsResourceState } from '../src/domain/lms/resource-state';
import { planLmsUploadSnapshot } from '../src/domain/lms/lms-upload';
const resource = {id:'r',kind:'video',enabled:true,generation:1,syncError:null,contentType:'video/mp4',fileSize:3};
const video = {id:1,status:'uploading',file:'key'};
it.each([
 {fileSize:null}, {contentType:null}, {contentType:''}, {contentType:'  '}, {fileSize:0},
 {fileSize:-1}, {fileSize:0.5}, {enabled:false}, {kind:'course'},
])('does not advertise an upload denied by the snapshot: %j', patch => {
  const source = {resource:{...resource,...patch},video};
  expect(lmsResourceState(source).upload).toBeNull();
  expect(planLmsUploadSnapshot(source,'external',1)).toBeNull();
});
it('advertises valid metadata with the same values as the snapshot', () => {
  expect(lmsResourceState({resource,video}).upload).toEqual({fileKey:'key',size:3,contentType:'video/mp4'});
  expect(planLmsUploadSnapshot({resource,video},'external',1)).toMatchObject({fileKey:'key',size:3,contentType:'video/mp4'});
});
it('does not advertise confirmed or absent videos and rejects stale upload generations', () => {
  expect(lmsResourceState({resource,video:{...video,status:'completed'}}).upload).toBeNull();
  expect(lmsResourceState({resource,video:null}).upload).toBeNull();
  expect(planLmsUploadSnapshot({resource,video},'external',2)).toBeNull();
});
