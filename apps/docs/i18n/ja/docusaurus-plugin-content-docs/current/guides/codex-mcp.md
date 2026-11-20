---
title: CodexからVideoQを使う
description: MCPでCodexをVideoQに接続し、シーン検索と映像確認を使います。
---

# CodexからVideoQを使う

CodexからMCP経由でVideoQのツールを直接使えます。この外部接続では、VideoQ内部のLangGraphエージェントを経由しません。CodexのモデルはCodex自身のログインを使い、VideoQのキーは講座やツールへのアクセス認証に使います。

## 接続する

1. VideoQにログインして**設定**を開き、読み取り専用の連携APIキーを作成します。
2. [Codex CLI](https://developers.openai.com/codex/cli)をインストールし、`codex login`でログインします。既存のCodexログインも使えます。
3. `~/.codex/config.toml`に次の設定を追加します。独自の`CODEX_HOME`を使う場合は、その中の`config.toml`です。

```toml
[mcp_servers.videoq]
url = "https://videoq.jp/api/mcp"
env_http_headers = { "X-API-Key" = "VIDEOQ_API_KEY" }
required = true
startup_timeout_sec = 30
tool_timeout_sec = 180
enabled_tools = [
  "list_courses", "get_course_info", "search_scenes", "read_video_window",
  "overview_video", "skim_video", "inspect_clip", "focus_clip"
]
```

オンプレミス環境では、`https://videoq.jp`を利用環境のオリジンに置き換えてください。画像確認を無効にした環境では、許可リストから`inspect_clip`と`focus_clip`を外します。

4. Bashのターミナルでキーを非表示入力し、同じターミナルからCodexを起動します。

```bash
read -r -s -p "VideoQ API key: " VIDEOQ_API_KEY
printf '\n'
export VIDEOQ_API_KEY
codex
```

設定ファイルに書くのは環境変数の名前だけです。キー自体をプロンプト、設定ファイル、シェル履歴、Gitに保存しないでください。デスクトップクライアントを使う場合は、その起動環境にも変数が必要です。ターミナルでの`export`は、そのターミナルから起動したクライアントに適用されます。

`env_http_headers`やツールの許可リストは[Codex公式のMCP設定](https://developers.openai.com/codex/mcp)を参照してください。

## 検索・映像確認を使う

まず、次のように講座IDを確認します。

> VideoQ MCPで、アクセスできる講座の名前とIDを一覧にしてください。

`list_courses`で得たIDを使って質問します。

> course_id 42で、標本化と量子化の違いを字幕検索して説明してください。それぞれの説明に、根拠となる動画タイトルと実際の時刻を付けてください。取得した根拠だけを使ってください。

特定動画の画面を確認する場合の例です。

> course_id 42で、get_course_infoをvideo_limit 20で使い、「第1回」という動画を特定してください。11分52秒から12分までの画像を実際に確認して、何が映っているか、観察時刻を引用して説明してください。映像が利用できない場合はそう伝えてください。

例のID、タイトル、時刻を自分の講座に置き換えてください。外部の根拠取得ツールには毎回`course_id`が必要で、動画IDもその講座に属している必要があります。`get_course_info`は1ページ最大20件です。続きがある場合は`videos_meta.next_offset`で次のページを取得します。

発話の検索には`search_scenes`、前後の字幕には`read_video_window`を使います。既知の映像区間には`inspect_clip`（180秒以内）か`focus_clip`（16秒以内）、場所の探索には`overview_video`や`skim_video`を使います。詳しい上限は[映像の根拠取得](visual-evidence.md)を参照してください。

対話画面を開かずに1回だけ実行する例です。

```bash
codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json \
  'VideoQ MCPだけを使って、アクセスできる講座の名前とIDを一覧にしてください。ファイルは編集しないでください。'
```

`--json`ではツール呼び出しや利用量のイベントがJSON Linesで出力されます。講座情報、字幕、映像観察の内容を含むことがあるため、保存した出力は非公開で管理してください。`--ephemeral`はCodexのセッション保存を省きますが、自分で保存した出力は削除しません。

## 上限とトラブルへの対処

- `401`：Codex起動前に環境変数を設定したか、キーが失効していないか、接続先が正しいかを確認します。
- `403`：キーの権限や講座へのアクセス権が不足しています。ツールの許可リストはCodexに見せるツールを絞る設定であり、アクセス権を付与しません。
- `429`：`Retry-After`に従って待ちます。キーのリクエスト上限とアカウント・ツールの上限は別で、初期接続やツール一覧の取得もリクエストになります。
- `video_limit`の検証エラー：20以下を指定し、ページングします。
- `VISUALS_NOT_PREPARED`：講座の所有者や管理者に画像キャッシュの準備を依頼します。字幕から画面の内容を推測しないでください。

外部の検索・画像確認は、1ツール呼び出しにつき講座所有者のAI利用枠を消費します。メタ情報と字幕だけの取得はAI枠を消費しません。Codexのモデル利用量は別です。VideoQのチャットとはモデル、指示、起動時間が異なるため、応答時間やトークン数だけでエージェント基盤の優劣を判断しないでください。

一時的な検証が終わったら、VideoQの設定から検証用キーを失効させ、ターミナルで`unset VIDEOQ_API_KEY`を実行してください。接続設定も不要になった場合は、`mcp_servers.videoq`のテーブルを削除します。
