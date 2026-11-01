import { requestBodyText } from "./helpers/request-body";
import { URL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { readFocusFrames } from "../src/lib/focus-frames";
import { inspectVideoClip } from "../src/lib/visual-inspection";
import type { Bindings } from "../src/types/bindings";

const workerRoot = fileURLToPath(new URL("../../worker/", import.meta.url));
const python = join(workerRoot, ".venv/bin/python");
const available = existsSync(python) && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
afterEach(() => vi.unstubAllGlobals());

it.skipIf(!available)("reads a real Python/FFmpeg pack through the API and submits its dense frames to vision", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "videoq-focus-contract-"));
  try {
    execFileSync(python, ["-c", `
import json, shutil, subprocess, sys
from pathlib import Path
from worker_python.pipeline.visual_chunks import build_visual_chunk
from worker_python.pipeline.visual_frames import build_frame_cache
root = Path(sys.argv[1])
video = root / "clip.mp4"
subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "color=c=blue:size=160x90:rate=30:duration=8", "-vf",
    "drawbox=color=red:t=fill:enable='gte(t,3)*lt(t,4)'", "-c:v", "mpeg4", str(video)], check=True)
(root / "coarse.json").write_bytes(build_frame_cache(video, 42, 8))
with build_visual_chunk(video, 42, 8, 0) as (pack, sparse, count):
    shutil.copyfile(pack, root / "pack.bin")
    (root / "manifest.json").write_text(json.dumps({"version": 2, "video_id": 42,
        "run_id": "64972424-b2c6-49b3-b9d3-cb0399ad45fa", "duration_seconds": 8,
        "chunk_seconds": 60, "chunk_count": 1,
        "overview": [[round(frame["timestamp_seconds"] * 1000), 0, frame["offset"], frame["length"]] for frame in json.loads(sparse)]}))
`, tmp], { cwd: workerRoot, timeout: 30_000, stdio: "pipe" });
    const pack = new Uint8Array(readFileSync(join(tmp, "pack.bin")));
    const manifest = new Uint8Array(readFileSync(join(tmp, "manifest.json")));
    const coarse = JSON.parse(readFileSync(join(tmp, "coarse.json"), "utf8"));
    expect(coarse.frames.map((f: { timestamp_seconds: number }) => f.timestamp_seconds)).toEqual([0, 5]);
    const reads: { offset: number; length: number }[] = [];
    const bindings = {
      ENVIRONMENT: "production", OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://vision.test/v1",
      VIDEO_BUCKET: { get: async (key: string, options: { range: { offset: number; length: number }; onlyIf: Headers }) => {
        if (key.endsWith('.focus-v2.json')) return { body: new Blob([manifest]).stream(), size: manifest.length };
        expect(key).toBe('media/upload.visual-v2/64972424-b2c6-49b3-b9d3-cb0399ad45fa/0.bin');
        const { offset, length } = options.range;
        reads.push(options.range);
        expect(options.onlyIf.get("if-match")).toBe(offset ? '"pack-v1"' : null);
        return { body: new Blob([pack.slice(offset, offset + length)]).stream(), size: pack.length,
          range: { offset, length }, httpEtag: '"pack-v1"' };
      } },
    } as Bindings;
    const selected = await readFocusFrames(bindings, { id: 42, fileKey: "upload" }, 2, 5, new AbortController().signal);
    if (!("frames" in selected)) throw new Error("Expected dense frames");
    expect(selected.frames.map(f => f.timestamp_seconds)).toEqual([2, 3, 4]);
    // Decode the exact API-returned JPEG. The one-second red event is absent
    // from the coarse cache but present in the dense selection at 3 seconds.
    const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=1:1", "-frames:v", "1",
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { input: Buffer.from(selected.frames[1].jpeg_base64, "base64"), timeout: 10_000 });
    expect(rgb[0]).toBeGreaterThan(200);
    expect(rgb[2]).toBeLessThan(30);
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(requestBodyText(init.body));
      expect(JSON.stringify(request).match(/data:image\/jpeg/g)).toHaveLength(3);
      expect(request.response_format.json_schema.schema.properties.observations.items.properties.frame_index.enum).toEqual([1, 2, 3]);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        observations: [{ frame_index: 2, observation: "Red is displayed." }],
      }) } }] });
    });
    const result = await inspectVideoClip(bindings, { id: 42, fileKey: "upload" }, 2, 5, "Which color appears briefly?",
      new AbortController().signal, { mode: "focus", maxFrames: 16 });
    expect(result).toMatchObject({ observations: [{ timestamp: 3, text: "Red is displayed." }], sampling_interval_seconds: 1 });
    expect(reads.every(r => r.length < pack.length)).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 40_000);
