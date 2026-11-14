import { beforeEach, expect, it, vi } from "vitest";
import { readVisualManifest, visualChunkKey } from "../src/lib/visual-manifest";
import { readFocusFrames } from "../src/lib/focus-frames";
import { readMediaBytes, readMediaRange } from "../src/integrations/media";
import type { Bindings } from "../src/types/bindings";
vi.mock("../src/integrations/media",()=>({readMediaBytes:vi.fn(),readMediaRange:vi.fn()}));
const env = {} as Bindings;
const runId = crypto.randomUUID();
const version = crypto.randomUUID();
const publication=crypto.randomUUID();
const video = {id:1,fileKey:'private/video.mp4',visualRunId:runId,visualManifestVersion:publication};
const signal = new AbortController().signal;
const manifest = {version:2,video_id:1,run_id:runId,duration_seconds:60,chunk_seconds:60,chunk_count:1,
  chunk_versions:[version],overview:[[0,0,12,4]]};
const encode = (value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
beforeEach(()=>{ vi.mocked(readMediaBytes).mockReset().mockResolvedValue(encode(manifest)); vi.mocked(readMediaRange).mockReset(); });
it("reads only the DB-published run and resolves its immutable chunk version",async()=>{
  expect(await readVisualManifest(env,video,signal)).toEqual(manifest);
  expect(readMediaBytes).toHaveBeenCalledWith(env,`private/video.mp4.visual-v2/${runId}/publications/${publication}/manifest.json`,64*1024,signal);
  expect(visualChunkKey(video.fileKey,runId,0,version)).toBe(`private/video.mp4.visual-v2/${runId}/0/${version}.bin`);
});
it("rejects another run, missing versions and incomplete version maps",async()=>{
  for (const value of [{...manifest,run_id:crypto.randomUUID()},{...manifest,chunk_versions:undefined},{...manifest,chunk_versions:[]}]) {
    vi.mocked(readMediaBytes).mockResolvedValue(encode(value));
    await expect(readVisualManifest(env,video,signal)).rejects.toThrow();
  }
});
it("does not fall back to unversioned packs when D1 has no ready run",async()=>{
  const result=await readFocusFrames(env,{...video,visualRunId:null},0,1,signal);
  expect(result).toHaveProperty('unavailable');
  expect(readMediaBytes).not.toHaveBeenCalled();
  expect(readMediaRange).not.toHaveBeenCalled();
});
it("retains legacy PostgreSQL manifest reads",async()=>{
  vi.mocked(readMediaBytes).mockResolvedValue(encode({...manifest,chunk_versions:undefined}));
  await readVisualManifest(env,{id:1,fileKey:video.fileKey},signal);
  expect(readMediaBytes).toHaveBeenCalledWith(env,`${video.fileKey}.focus-v2.json`,32*1024,signal);
});
