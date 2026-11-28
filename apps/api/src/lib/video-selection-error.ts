/** User-correctable selection failure; never includes inaccessible IDs or titles. */
export class VideoSelectionError extends Error {
  readonly name = "VideoSelectionError";
  constructor(readonly reason: "unresolved" | "out_of_scope", locale: string | null) {
    super(locale === "ja"
      ? "指定された動画を検索対象として確認できませんでした。利用できる動画の名前または動画IDを指定してください。"
      : "The requested video could not be selected. Please specify an available video title or video ID.");
  }
}
