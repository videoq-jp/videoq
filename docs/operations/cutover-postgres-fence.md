# AWS保守hold内の管理ログイン停止と復帰

固定main workflowの `install-fence` / `release-fence` は、同じhold・source・activity actionで既存のAWS rotation jobを使用する。DB管理者URLはAWS内の親が取得し、AWS/GitHub/Cloudflare資格情報を含まない子プロセスへだけ渡す。対象は固定Neon host/databaseと既存の管理role prefixであり、任意SQL・接続先・コマンドを受け付けない。

API停止の実503応答、実Lambda mapping停止、同じglobal owner、元のconsumer/backend計画を確認する。読み取り監査で不変保存した最初のLOGIN計画を必須とし、後のNOLOGIN状態から復旧計画を作り直さない。元々NOLOGINだったroleは再開しない。

インストール前に、専用READ ONLY transactionで全業務処理カウントが0であることを確認する。残件があればLOGINを変更せず、拒否結果を永続化してnative taskを完了させる。workflowは照合が必要と報告するが、停止前abortへ戻れる。0はこの前提の確認であり、キュー・外部サービス全体のdrain証明とは呼ばない。

実LOGIN変更の前に、同じrevision・original plan hash・action・ownerを条件とするDynamoDB transactionでintentを保存して読み戻す。子は既存の検証済みfence CLIを使い、NOLOGINのcommit、既存writer接続の終了、実catalog/sessionの照合を行う。完了も同じ条件で保存する。応答喪失時は同じoriginal planで再試行し、元の状態を上書きしない。

保守のnative `TaskSucceeded` が確認できるまで次へ進めない。未完了intent・fenced状態・改変されたreceiptがあれば、API/consumer/deployment admissionの復帰とhold解除を拒否する。停止処理が途中で失敗した場合は、buildの終了と同一executionのredrive可能性を確認し、`release-fence` で同じactionを明示的に復旧できる。自動でLOGINへ戻したり、別executionを開始したりしない。

`database_mutations_started` はアプリケーションデータ移行のguardとして維持し、リセットしない。LOGIN変更は独立した `postgres_fence_state` intent/receiptで追跡する。データ移行開始後の復帰はこの停止前ツールの対象外であり、検証済み逆移行/handoffが必要である。

検証: 50件の実DynamoDB Local契約テスト（AWS/Cloudflare transportsはmock）、465件のNode security、16件のPython request client、実operator ZIPと専用loopback PostgreSQLでのinstall/releaseの反復、backup LOGINとretired NOLOGINの維持、秘密値非出力を確認した。AWSのstate-machine定義検証もOKだった。本番LOGIN変更・停止・D1切り替えの実績とは扱わない。

## Production inverse-transaction primitive

`restoreProductionPostwriteSnapshot` is a separate trusted-operator entry into the same recovery implementation. The rehearsal entry remains loopback-only. The new entry requires the fixed production original fence plan and pinned snapshot/mapping hashes, copies inputs before waiting, fixes schemas to public/chat_memory and owns a verified direct-Neon fenced transaction. It does not start a nested transaction or accept a caller-selected SQL callback. It leaves the global/application/D1 admission verification to its AWS parent and retains `productionSafe:false`; this primitive alone is not a production recovery CLI or complete handoff.

Validation: API and D1-tools typechecks, focused lint and 35 tests across five files passed, including actual isolated PG/D1 recovery, authentication/job continuity, identity floors and fence transaction behavior. Three new entry-boundary cases mock the verified transaction to check target/input binding, fixed schemas and independent copies. They are not a real production TLS or Neon restore test.
