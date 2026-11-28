# 講座SkillsのMCP配信検証

対象: Issue #1746。Skills拡張の公式概要と2026年7月28日版のstateless HTTP形式を参照した。

導入済みMCP SDK 1.32.2の標準プロトコルは2025年11月25日版のため、新形式を扱うHTTPアダプターを認証済みの同一エンドポイントに追加する。既存のinitialize経路は維持する。新形式ではserver/discover、skills/list、skills/get、resources/readを提供し、tools/listとtools/callは実SDKの登録済みハンドラーを内部接続で再利用する。

リクエストごとのprotocolVersion・clientCapabilitiesとHTTPヘッダーの一致を検査する。Skills拡張はクライアント側の宣言も要求する。非対応プロトコル、未知メソッド、失効・権限外のURIは規定のエラーで拒否する。書き込み権限と既存ツールの利用枠を再利用し、Skill取得にも読み取り上限を適用する。

一覧取得ではファイル本文を先読みしない。manifestはすべてのファイルを含む。本文と参照資料は必要時だけ返し、キャッシュはprivate、TTLは60秒とする。ページ間の変更は最新状態で再認可し、完全な一括スナップショット取得が必要なクライアントは先頭から再取得する。

新形式の契約テストと既存MCPの回帰を実行する。ホストによる自動選択・有効化・キャッシュの破棄はホストの責務であり、Claude・Codexの実製品での自動Skill読み込みを、この契約テストの成功だけで保証しない。

参照: [Skills](https://modelcontextprotocol.io/extensions/skills/overview)、[Discovery](https://modelcontextprotocol.io/specification/draft/server/discover)、[Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)。
