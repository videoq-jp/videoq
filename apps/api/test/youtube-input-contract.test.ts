import { expect, it, vi } from 'vitest';
import { inputSchemas } from '@videoq/trpc/inputs';
import { managementToolSchemas } from '../src/tools/management';
import { extractYoutubeVideoId } from '../src/lib/youtube';
import { createVideoManagementService } from '../src/features/videos/management-service';
import type { VideoManagementDependencies } from '../src/features/videos/management-ports';
const base = 'https://www.youtube.com/watch?v=abcdefghijk&extra=';
const atLength = (n: number) => base + 'x'.repeat(n-base.length);
it.each([200,201,247])('shares URL length policy at %i characters across transports and workflow', async length => {
  const url = atLength(length), allowed = length <= 200;
  expect(inputSchemas['videos.createYoutube'].safeParse({youtubeUrl:url,title:'Clip'}).success).toBe(allowed);
  expect(managementToolSchemas.create_youtube_video.safeParse({idempotency_key:'test-key-123',youtube_url:url,title:'Clip'}).success).toBe(allowed);
  const createYoutube = vi.fn(async()=>({videoId:1,taskId:null,reused:false}));
  const deps = {createYoutube,requireYoutube:()=>{},extractYoutubeVideoId,detail:vi.fn(async()=>null)} as unknown as VideoManagementDependencies;
  const result = await createVideoManagementService(deps).createUserYoutubeVideo('owner',{youtube_url:url,title:'Clip',description:''});
  if (allowed) expect(createYoutube).toHaveBeenCalledWith('owner',expect.objectContaining({sourceUrl:url}),undefined);
  else { expect(result).toHaveProperty('fieldError.youtube_url'); expect(createYoutube).not.toHaveBeenCalled(); }
});
it.each(['not a URL','https://evil.example/watch?v=abcdefghijk','https://youtube.com/watch?v=short','ftp://youtube.com/watch?v=abcdefghijk'])('rejects unsupported YouTube URL at both inputs: %s', url => {
  expect(inputSchemas['videos.createYoutube'].safeParse({youtubeUrl:url,title:'Clip'}).success).toBe(false);
  expect(managementToolSchemas.create_youtube_video.safeParse({idempotency_key:'test-key-123',youtube_url:url,title:'Clip'}).success).toBe(false);
});
it.each(['https://youtu.be/abcdefghijk','https://youtube.com/embed/abcdefghijk','https://youtube.com/shorts/abcdefghijk'])('normalizes surrounding whitespace consistently: %s', url => {
  expect(inputSchemas['videos.createYoutube'].parse({youtubeUrl:'  '+url+'  ',title:'Clip'}).youtubeUrl).toBe(url);
  expect(managementToolSchemas.create_youtube_video.parse({idempotency_key:'test-key-123',youtube_url:'  '+url+'  ',title:'Clip'}).youtube_url).toBe(url);
});
