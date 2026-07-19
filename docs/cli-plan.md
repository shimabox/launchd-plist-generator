# CLI 計画 (check / doctor)

launchd plist のトラブルシューティングに特化した CLI の計画。段階 1・2 (`bin/launchd-plist` の
`check`/`doctor` サブコマンド、guide.md への誘導リンク) は実装済み。段階 3 (配布整備) は未着手。

## 使い方 (実装済み)

```sh
node bin/launchd-plist check <file.plist>   # 静的検証のみ
node bin/launchd-plist doctor <file.plist>  # check + 実行環境・登録状態の診断 (読み取り専用)

# オプション
node bin/launchd-plist check <file.plist> --json    # issue を JSON 配列で出力
node bin/launchd-plist check <file.plist> --strict  # 警告のみでも exit code を 1 にする
node bin/launchd-plist --help
```

macOS 限定 (`plutil`/`launchctl` を利用)。macOS 以外で実行するとその旨のエラーを出して終了する。

## 背景と立ち位置

- 生成だけの CLI は需要が薄い。CLI を使う層は plist を手で書けるうえ、生成はブラウザ版が主役
- 需要があるのは診断。手練れでも毎回 `launchctl print` の出力と睨めっこしている領域を一発にする
- 既存ツール (mklaunchd 等) との差別化は「日本語の診断メッセージ」と「エラーごとに
  [guide.md](guide.md) の該当節へ誘導する」こと。「初心者が launchd で詰まらない」という
  このリポジトリの方向性に合わせる

## スコープ

MVP は次の 2 コマンドを最初から両方出す。doctor は内部的に check + 環境診断なので、
分離して出すコストは最初からほぼゼロであり、CI で使える check を早く出せる利点が勝つ。

| コマンド | 確認対象 | 主な用途 |
|---|---|---|
| `check <file.plist>` | plist の内容だけ (静的検査) | 生成直後の確認、CI、コミット前 |
| `doctor <file.plist>` | plist + ファイルシステム + launchd の状態 | 登録できない・実行されない原因の調査 |

生成機能 (フォーム相当のオプション群) はスコープ外。ブラウザ版と役割を分ける。

## 診断項目

### check (静的検査)

既存の `validate()` が返す issue をそのまま使う。

- XML 構文 (plutil -lint 相当)
- Label の必須・文字種
- ProgramArguments の有無、絶対パス、`~` の不展開、シェル記号
- カレンダー値の範囲、Day と Weekday の OR 条件
- StartInterval の下限 (ThrottleInterval との関係)
- `/Users/USERNAME/` プレースホルダの書き換え忘れ
- トリガーなし、エラーログ未設定などの助言

### doctor (check + 実行環境)

- 実行ファイル (argv[0]) が存在し、実行権限があるか
- WorkingDirectory・ログの親ディレクトリが存在するか
- 同じ Label が launchd に登録済みか (`launchctl print gui/$UID/<label>`)
- 現在のジョブ状態と最終終了コード (127 なら PATH 問題の案内、など)
- 登録済み設定と手元の plist が食い違っていないか (要 bootout → bootstrap の検出)
- plist の配置場所 (`~/Library/LaunchAgents/` にあるか) とパーミッション

doctor は**読み取り専用に徹する**。bootstrap や bootout の実行はせず、必要なコマンドを
表示するだけにする (勝手にジョブを再起動しない)。

## 実装方針

- `bin/` に依存ゼロの Node.js スクリプト 1 本。check / doctor はサブコマンドで同居
- XML 解析は自前で持たない。`plutil -convert json -o - <file>` に丸投げして JSON で受け、
  既存の `plistDictToConfig()` → `validate()` に流す。ブラウザ専用の `parsePlistXml`
  (DOMParser 依存) は使わない。副産物としてバイナリ plist もそのまま読める
- 環境診断は child_process の薄いラッパー (`launchctl print`、fs.access 等)
- macOS 前提 (plutil と launchctl が必須)。CI の ubuntu ジョブでは環境依存部分を
  モック化した単体テストのみ実行する

## 出力形式

人間向けの一覧 + 終了コード。CI 判定は終了コードで行う。

```
$ launchd-plist doctor ~/Library/LaunchAgents/sh.orukubami.sample_job.plist
✓ XML 構文は正常
✕ /Users/USERNAME は存在しません (プレースホルダの書き換え忘れ?)
    → 直し方は docs/guide.md 8.2 を参照
⚠ sh.orukubami.sample_job はすでに登録されています
ℹ plist が登録時から変更されています。反映するには bootout → bootstrap が必要です
    launchctl bootout gui/501/sh.orukubami.sample_job
    launchctl bootstrap gui/501 ~/Library/LaunchAgents/sh.orukubami.sample_job.plist
```

- 終了コードは、エラーありで 1、警告のみは 0。`--strict` で警告も 1 にする (CI 向け)
- `--json` で issue を JSON 出力する (エディタ連携・スクリプト向け)。既存 validate() の
  `{level, message, field}` をそのまま出せる

## 段階

1. `check` と `doctor` の骨格 (このリポジトリの bin/ に同居、`node bin/...` で実行)
2. 診断メッセージへの guide.md 該当節の紐付け
3. 配布の整備 (npx 実行、または Homebrew tap)。需要を見てから

## 未決事項

- コマンド名。`launchd-plist-generator` は CLI 名として長い。`launchd-plist` や短縮名の検討
- 登録済み設定との差分検出の精度 (`launchctl print` の出力パースにどこまで踏み込むか)
- check の対象に「このツールで表現できないキー」への言及を含めるか
  (CLI 利用者にとって Sockets 入り plist は正常なので、警告の出し分けが必要)
