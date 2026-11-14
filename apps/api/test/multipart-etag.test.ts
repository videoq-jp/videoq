import {expect,it} from 'vitest';
import {isValidUploadPartEtag} from '@videoq/trpc/video-upload';
import {videosInputSchemas} from '../../../packages/trpc/src/inputs/videos';
it.each(['a'.repeat(32),'opaque_R2-part/token+value=','x'.repeat(1024)])('accepts bounded opaque ETags (%s)',etag=>{
 expect(isValidUploadPartEtag(etag)).toBe(true);expect(videosInputSchemas['videos.completeMultipartUpload'].safeParse({id:1,parts:[{partNumber:1,etag}]}).success).toBe(true);
});
it.each(['','a b','a"b','a\nb','a\rb','x'.repeat(1025),null,undefined])('rejects malformed ETags (%s)',etag=>{
 expect(isValidUploadPartEtag(etag)).toBe(false);expect(videosInputSchemas['videos.completeMultipartUpload'].safeParse({id:1,parts:[{partNumber:1,etag}]}).success).toBe(false);
});
