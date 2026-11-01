import promptConfig from "./prompts.json";

/**
 * VideoQ の RAG プロンプトを `prompts.json` から構築する。
 * 各言語は完全な設定を持ち、構造をビルド時に検証する。
 * 候補は `locale` → `locale` のハイフン前 → default の順で選ぶ。
 */
type PromptConfig = typeof promptConfig.rag.default;
const localeConfigs: ReadonlyMap<string, PromptConfig> = new Map(Object.entries(promptConfig.rag));

function resolveLocaleConfig(locale?: string | null): PromptConfig {
  return (locale && (localeConfigs.get(locale) ?? localeConfigs.get(locale.split("-", 1)[0])))
    || promptConfig.rag.default;
}

/** RAG の名前付きプレースホルダを置換する。 */
function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
}

/**
 * header / rules までの共通部分を組み立てる。
 * 末尾（参照なしの案内 or 検索の指示）だけが呼び出し側で変わる。
 */
function buildPromptBase(config: PromptConfig): string[] {
  const { header: headerTemplate, role, background, request, rules } = config;
  const rulesLabel = config.section_titles.rules;

  const header = formatTemplate(headerTemplate, {
    role,
    background,
    request,
  });

  const lines: string[] = [header.trim()];

  lines.push("", rulesLabel);
  if (rules.length > 0) {
    rules.forEach((rule, i) => lines.push(`${i + 1}. ${rule}`));
  } else {
    lines.push("1. Follow common-sense safety best practices.");
  }

  return lines;
}

function appendAnswerFormat(lines: string[], config: PromptConfig): string {
  lines.push("", config.section_titles.format, config.format_instruction.trim());
  return lines.join("\n");
}

/** 講座未指定の Q&A 用。参照シーンがないことを明示する。 */
export function buildNoCourseSystemPrompt(locale?: string | null): string {
  const config = resolveLocaleConfig(locale);
  const referenceLabel = config.section_titles.reference;
  const lines = buildPromptBase(config);

  lines.push("", referenceLabel);
  if (config.reference.empty) lines.push(config.reference.empty);

  return appendAnswerFormat(lines, config);
}

/**
 * ReAct エージェント用の system prompt。
 * 参照シーンは実行前には決まらないので、代わりに検索ツールの使い方を指示する。
 */
export function buildAgentSystemPrompt(
  locale: string | null | undefined,
  maxSearches: number,
  maxCourseInfoCalls: number,
): string {
  const config = resolveLocaleConfig(locale);
  const searchLabel = config.section_titles.search;
  const lines = buildPromptBase({ ...config, ...config.agent });

  lines.push("", searchLabel);
  lines.push(
    ...config.agent.instructions.map((instruction) =>
      formatTemplate(instruction, {
        max_searches: String(maxSearches),
        max_course_info_calls: String(maxCourseInfoCalls),
      }),
    ),
  );

  return appendAnswerFormat(lines, config);
}
