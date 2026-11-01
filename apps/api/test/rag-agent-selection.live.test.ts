import { URL } from "node:url";
import { chatAnswerText } from "@videoq/trpc/chat";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseDetail } from "../src/repositories/course-repository";
import { getCourseInfo } from "../src/repositories/course-repository";
import type { SceneHit } from "../src/repositories/vector-repository";
import type { Bindings } from "../src/types/bindings";

// DB・埋め込みだけを固定し、モデルのツール選択は実際のプロンプトとツールで検証する。
// 通常のCIではスキップ。RAG_SELECTION_LIVE=1 で有料のLLM APIを呼ぶ。
const enabled = process.env.RAG_SELECTION_LIVE === "1";
const varsPath = new URL("../.dev.vars", import.meta.url);
const configured = enabled && existsSync(varsPath) ? parse(readFileSync(varsPath)) : {};
const env = Object.fromEntries(
  ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_MODEL"].map((key) => [
    key, process.env[key] ?? configured[key],
  ]),
) as unknown as Bindings;

const search = vi.fn(async (_query: string, videoIds?: readonly number[]) =>
  SCENES.filter((scene) => !videoIds || videoIds.includes(scene.videoId)),
);
const close = vi.fn(async () => {});
const open = vi.fn(async () => ({ search, close }));
vi.mock("../src/repositories/vector-repository", () => ({
  openSceneSearch: (...args: Parameters<typeof open>) => open(...args),
}));
vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: vi.fn() }));

const { runRag, streamRag } = await import("../src/lib/rag");

const SCENES: SceneHit[] = [
  {
    content: "NANDはANDの出力を反転する。入力AとBが両方1のときだけ0を出力し、" +
      "それ以外は1を出力する。2つの入力に同じ信号を与えるとNOT回路になる。",
    videoId: 60, videoTitle: "第7回 論理回路", startTime: "00:01:00", endTime: "00:02:00",
  },
  {
    content: "Dラッチはイネーブルが1の間はDをQに反映し、0の間は値を保持する。" +
      "Dフリップフロップはクロックの立ち上がりでDを記録し、次の立ち上がりまで保持する。",
    videoId: 61, videoTitle: "第8回 順序回路", startTime: "00:03:00", endTime: "00:04:00",
  },
];

const COURSE: CourseDetail = {
  id: 3, name: "デジタル回路", description: "", video_count: 2,
  display_order: 0, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
  access_role: "owner", share_slug: null,
  videos: SCENES.map((scene, index) => ({
    id: scene.videoId, title: scene.videoTitle, description: "", order: index,
    status: "completed", file: "", tags: [], uploaded_at: "2026-09-14T00:00:00Z",
    source_type: "uploaded", source_url: null, youtube_video_id: null, youtube_embed_url: null,
  })),
};

const scenarios = [
  { query: "NANDとは？", locale: "ja", kind: "content" },
  { query: "NAND", locale: "ja", kind: "content" },
  { query: "DラッチとDフリップフロップの違いは？", locale: "ja", kind: "content" },
  { query: "この講座の内容を要約して", locale: "ja", kind: "content" },
  { query: "何を学べる？", locale: "ja", kind: "content" },
  { query: "第7回の内容をまとめて", locale: "ja", kind: "lecture" },
  { query: "動画の本数と、この講座で学ぶ内容を教えて", locale: "ja", kind: "mixed" },
  { query: "この講座は全部で何本の動画がありますか？", locale: "ja", kind: "metadata" },
  { query: "登録されている講座の説明文を見せて", locale: "ja", kind: "metadata" },
  { query: "What is NAND?", locale: null, kind: "content" },
  { query: "Summarize what Lecture 7 teaches.", locale: null, kind: "lecture" },
  { query: "How many videos are in this course?", locale: null, kind: "metadata" },
];

afterEach(() => vi.clearAllMocks());

describe.skipIf(!enabled).each([false, true])("実モデルの検索選択（stream=%s）", (stream) => {
  it.each(scenarios)("$query → $kind", async ({ query, locale, kind }) => {
    // ストリームでは説明あり、非ストリームでは説明なし。同じ質問でも両方で検索が必要。
    const course = stream ? {
      ...COURSE,
      description: "論理ゲートと順序回路を学ぶ講座。",
      videos: COURSE.videos.map((video, i) => ({ ...video, description: SCENES[i].content })),
    } : COURSE;
    vi.mocked(getCourseInfo).mockImplementation(async (_env, _id, _owner, options) => ({
      ...course,
      videos: course.videos.slice(options?.videoOffset ?? 0,
        (options?.videoOffset ?? 0) + (options?.videoLimit ?? 20)),
    }));
    const params = {
      messages: [{ role: "user", content: query }],
      ownerUserId: "00000000-0000-4000-8000-000000000005",
      courseId: 3, videoIds: [60, 61], locale,
    };
    const result = stream ? await (async () => {
      let content = "";
      for await (const chunk of streamRag(env, params)) {
        if ("part" in chunk && chunk.part.type === "text") content += chunk.part.text;
        if ("final" in chunk) {
          expect(content).toBe(chatAnswerText(chunk.final.answer));
          return chunk.final;
        }
      }
      throw new Error("Missing final stream chunk");
    })() : await runRag(env, params);

    expect(chatAnswerText(result.answer).trim()).not.toBe("");
    if (kind === "metadata") {
      expect(getCourseInfo).toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(result.answer.sources).toEqual([]);
      expect(chatAnswerText(result.answer)).not.toMatch(/\[\d+\]/);
    } else {
      expect(search).toHaveBeenCalled();
      expect(result.answer.sources.length).toBeGreaterThan(0);
      const markers = result.answer.segments.flatMap(segment => segment.sourceIds);
      expect(markers.length).toBeGreaterThan(0);
      expect(markers.every((id) => result.answer.sources.some(source => source.id === id))).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      if (kind === "lecture" || kind === "mixed") expect(getCourseInfo).toHaveBeenCalled();
      if (kind === "lecture") {
        expect(search.mock.calls.map((args) => args[1])).toEqual(search.mock.calls.map(() => [60]));
      }
    }
  }, 180_000);
});
