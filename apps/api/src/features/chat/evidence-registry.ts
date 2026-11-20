import type { ChatSource } from '../../application/models';
import type { SceneHit } from '../../persistence/contracts/scene-search';

/** 最新の user メッセージ本文を抽出する。 */
export function extractLatestUserQuery(messages: readonly { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.content) return m.content;
  }
  if (messages.length > 0) return messages[messages.length - 1].content ?? "";
  return "";
}

const sceneKey = (hit: SceneHit) => `${hit.evidenceType ?? "transcript"}|${hit.videoId}|${hit.startTime}|${hit.endTime}`;

/** Assign stable source IDs across searches and persisted agent turns. */
export class SceneCollector {
  constructor(private readonly allowed: readonly number[]) {}

  restore(sources: readonly ChatSource[]) {
    for (const source of sources) this.add({
      videoId: source.video_id, videoTitle: source.title, startTime: source.start_time ?? "",
      endTime: source.end_time ?? "", content: "", evidenceType: source.evidence_type,
    });
  }

  private readonly order: SceneHit[] = [];
  private readonly seen = new Map<string, number>();
  readonly courseContexts = new Set<string>();

  /** 既出なら既存の番号を、新規なら末尾に足して新しい番号を返す（1 始まり）。 */
  add(hit: SceneHit): number {
    const key = sceneKey(hit);
    const known = this.seen.get(key);
    if (known !== undefined) {
      // A new frame observation or a freshly edited subtitle window can carry
      // additional evidence at an existing timestamp. Preserve it in history.
      const prior = this.order[known - 1];
      prior.videoTitle = hit.videoTitle;
      if (!prior.content.includes(hit.content)) {
        prior.content += `\n${hit.content}`;
      }
      return known;
    }
    this.order.push(hit);
    const index = this.order.length;
    this.seen.set(key, index);
    return index;
  }

  get hits(): readonly SceneHit[] {
    return this.order.filter(hit => hit.content);
  }

  get sources(): ChatSource[] {
    return this.savedSources.filter(source => this.allowed.includes(source.video_id));
  }

  get savedSources(): ChatSource[] {
    return this.order.map((hit, index) => ({
      id: index + 1, video_id: hit.videoId, title: hit.videoTitle,
      start_time: hit.startTime, end_time: hit.endTime,
      ...(hit.evidenceType ? { evidence_type: hit.evidenceType } : {}),
    }));
  }
}

