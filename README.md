# launchd plist 実用ガイド

macOS のジョブ管理システム **launchd** と、その設定ファイルである **plist** の仕組みを解説する。
後半では実践例として **Claude Code (`claude -p`) をスケジュール実行する** 手順をまとめる。

- 対象: macOS (動作確認環境: macOS 26.x / Apple Silicon)
- `launchctl` はモダン構文 (`bootstrap` / `bootout` / `kickstart`) を基本とし、レガシー構文 (`load` / `unload`) は補足として扱う

## このリポジトリの構成

詳しさの段階別に 3 ファイルに分かれている。

| ファイル | レベル | 内容 |
|---|---|---|
| [intro.md](intro.md) | 入門 | 最初の一歩。最小の plist と 3 ステップの手順、ハマりどころだけ |
| **README.md**(このファイル) | 実用 | 仕組みの解説 + よく使うキー + Claude Code スケジュール実行の実践例 |
| [reference.md](reference.md) | 網羅 | `man launchd.plist` 相当の全キー解説、launchctl 全サブコマンド、ドメインの詳細 |

---

## 目次

1. [launchd とは](#1-launchd-とは)
2. [Daemon と Agent の違いと plist の配置場所](#2-daemon-と-agent-の違いと-plist-の配置場所)
3. [plist の基本構造](#3-plist-の基本構造)
4. [主要キーリファレンス](#4-主要キーリファレンス)
5. [launchctl コマンド](#5-launchctl-コマンド)
6. [cron との違い](#6-cron-との違い)
7. [実践: Claude Code をスケジュール実行する](#7-実践-claude-code-をスケジュール実行する)
8. [トラブルシューティング](#8-トラブルシューティング)
9. [参考資料](#9-参考資料)

---

## 1. launchd とは

launchd は macOS の **PID 1**、つまりカーネルが最初に起動するプロセスであり、システム上の
すべてのプロセスの祖先にあたる。Linux でいう systemd に相当し、以下を一手に担う。

- システム起動時のデーモン起動(従来の init / rc スクリプトの置き換え)
- ユーザーログイン時のエージェント起動
- **スケジュール実行**(従来の cron の置き換え)
- ファイル・ディレクトリ監視によるオンデマンド起動
- ソケット待ち受けによるオンデマンド起動(従来の inetd の置き換え)
- クラッシュしたプロセスの自動再起動

### 基本的な考え方: 「ジョブは宣言する。launchd が起動する」

launchd では「いつ・何を・どう実行するか」を **plist(Property List)ファイルに宣言**し、
launchd に登録(bootstrap)する。プロセスを自分で fork & exec したりバックグラウンド化
したりするのではなく、**起動のタイミング判断はすべて launchd に任せる**のが設計思想。

```
┌─────────────────────────────┐
│  plist (宣言)                │
│  ・Label: ジョブの一意な名前  │
│  ・何を実行するか            │
│  ・いつ実行するか(トリガー)  │
└──────────┬──────────────────┘
           │ launchctl bootstrap で登録
           ▼
┌─────────────────────────────┐
│  launchd (PID 1)            │──▶ トリガー成立時にプロセスを起動
│  ジョブの状態・履歴を管理     │──▶ 終了コード・クラッシュを監視
└─────────────────────────────┘
```

---

## 2. Daemon と Agent の違いと plist の配置場所

launchd のジョブは大きく 2 種類に分かれる。

| 種類 | 実行ユーザー | 実行タイミング | GUI アクセス | 典型用途 |
|---|---|---|---|---|
| **LaunchDaemon** | root(または指定ユーザー) | システム起動時から。ログイン不要 | 不可 | サーバー、システム常駐処理 |
| **LaunchAgent** | ログイン中のユーザー | ユーザーログイン後 | 可 | ユーザー単位の定期処理、メニューバー常駐 |

**個人のスケジュールタスク(Claude Code の定期実行など)は LaunchAgent が適切**。
ユーザーの環境(`HOME`、キーチェーン、GUI セッション)にアクセスでき、root 権限も不要なため。

### plist の配置場所

| パス | 種類 | 用途 |
|---|---|---|
| `~/Library/LaunchAgents/` | Agent | **自分用のジョブはここに置く** |
| `/Library/LaunchAgents/` | Agent | 全ユーザー共通のエージェント(管理者がインストール) |
| `/Library/LaunchDaemons/` | Daemon | サードパーティのデーモン |
| `/System/Library/LaunchAgents/` | Agent | macOS 本体のもの。**触らない** |
| `/System/Library/LaunchDaemons/` | Daemon | macOS 本体のもの。**触らない** |

> **注意(パーミッション)**: `/Library/LaunchDaemons/` に置く plist は
> `root:wheel` 所有・`644` でなければ launchd に拒否される。
> `~/Library/LaunchAgents/` は自分の所有で問題ないが、グループ・他者書き込み可(662 など)だと拒否される。

### ドメインという概念

モダンな `launchctl` では、ジョブは「ドメイン」に所属する。

| ドメイン | 意味 | 例 |
|---|---|---|
| `system` | システム全体(Daemon) | `system/com.example.mydaemon` |
| `gui/<UID>` | ユーザーの GUI セッション(Agent) | `gui/501/com.example.myagent` |
| `user/<UID>` | ユーザーのバックグラウンドセッション | SSH ログインのみでも有効 |

自分の UID は `id -u` で確認できる(最初のユーザーは通常 `501`)。
**GUI アプリやキーチェーンに触るエージェントは `gui/<UID>` に登録する**のが基本。

---

## 3. plist の基本構造

plist は XML 形式の辞書(dict)。最小構成は「名前」と「何を実行するか」の 2 つ。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ジョブの一意な識別子。ファイル名は <Label>.plist に揃えるのが慣習 -->
    <key>Label</key>
    <string>com.example.hello</string>

    <!-- 実行するコマンド。argv をそのまま配列で書く -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/echo</string>
        <string>hello</string>
    </array>

    <!-- トリガー: 60秒ごとに実行 -->
    <key>StartInterval</key>
    <integer>60</integer>
</dict>
</plist>
```

### 重要な原則

- **`ProgramArguments` はシェルを介さない**。パイプ・リダイレクト・`~` 展開・環境変数展開は
  使えない。シェル機能が必要なら `/bin/zsh -c '...'` を明示的に噛ませる(後述の実践例参照)。
- **パスは絶対パスで書く**。launchd から起動されるプロセスの `PATH` は
  `/usr/bin:/bin:/usr/sbin:/sbin` のみ。`~/.zshrc` は読まれない。
- 書式チェックは `plutil -lint ファイル.plist` で行える。

---

## 4. 主要キーリファレンス

### 4.1 実行対象を指定するキー

| キー | 型 | 説明 |
|---|---|---|
| `Label` | string | **必須**。ジョブの一意な識別子。逆 DNS 形式(`com.ユーザー名.ジョブ名`)が慣習 |
| `ProgramArguments` | array of string | 実行コマンドと引数(argv)。通常はこちらを使う |
| `Program` | string | 実行ファイルパスのみ指定する場合。`ProgramArguments` とどちらか必須 |

### 4.2 起動トリガーを指定するキー

#### `StartCalendarInterval` — カレンダー指定(cron 相当)

指定できるキー: `Minute` / `Hour` / `Day` / `Weekday`(0 と 7 が日曜) / `Month`。
**省略したフィールドはワイルドカード扱い**(cron の `*` と同じ)。

```xml
<!-- 毎朝 9:00 に実行 -->
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

複数のスケジュールは dict の配列で書く。

```xml
<!-- 平日(月曜と金曜)の 9:00 と 18:00 -->
<key>StartCalendarInterval</key>
<array>
    <dict>
        <key>Weekday</key><integer>1</integer>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
        <key>Weekday</key><integer>5</integer>
        <key>Hour</key><integer>18</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
</array>
```

> **スリープ時の挙動(cron との最大の違い)**:
> スリープ中に予定時刻を過ぎた場合、**次に起きたときに 1 回だけまとめて実行される**
> (複数回分逃していても 1 回に集約)。ただし**電源オフ中に逃した分は実行されない**。

#### `StartInterval` — 一定間隔

```xml
<!-- 300秒(5分)ごと -->
<key>StartInterval</key>
<integer>300</integer>
```

前回の起動時刻からの間隔。スリープ中はカウントが進まない扱いになり、起床後に必要なら 1 回実行される。

#### `RunAtLoad` — 登録時に即実行

```xml
<key>RunAtLoad</key>
<true/>
```

ジョブが launchd に登録された時点(= ログイン時、または `launchctl bootstrap` した瞬間)に 1 回実行する。
スケジュールキーと併用可。

#### `WatchPaths` / `QueueDirectories` — ファイル監視

```xml
<!-- このファイル/ディレクトリが変更されたら起動 -->
<key>WatchPaths</key>
<array>
    <string>/Users/me/Dropbox/inbox</string>
</array>

<!-- ディレクトリが「空でなくなったら」起動(処理してファイルを消す前提のジョブキュー向け) -->
<key>QueueDirectories</key>
<array>
    <string>/Users/me/queue</string>
</array>
```

#### `KeepAlive` — 常駐・自動再起動

```xml
<!-- 無条件に常駐(死んだら即再起動) -->
<key>KeepAlive</key>
<true/>

<!-- 条件付き: 異常終了(非ゼロ exit)のときだけ再起動 -->
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key>
    <false/>
</dict>
```

dict で指定できる条件には `SuccessfulExit`(終了コードによる)、`Crashed`(クラッシュ時のみ)、
`PathState`(特定パスの存在)などがある。

> **再起動ループ対策**: launchd は `ThrottleInterval`(デフォルト **10 秒**)より短い間隔での
> 再起動を抑制する。10 秒未満で死ぬジョブは "respawning too quickly" として遅延される。

### 4.3 実行環境を指定するキー

| キー | 型 | 説明 |
|---|---|---|
| `WorkingDirectory` | string | 実行時のカレントディレクトリ |
| `EnvironmentVariables` | dict | 環境変数。`PATH` をここで補うのが定番 |
| `StandardOutPath` | string | 標準出力の書き出し先(追記)。**ログはこれで取る** |
| `StandardErrorPath` | string | 標準エラーの書き出し先(追記) |
| `UserName` / `GroupName` | string | 実行ユーザー(**LaunchDaemon 専用**。Agent では使わない) |
| `Nice` | integer | 優先度(-20〜20) |
| `ProcessType` | string | `Background` / `Standard` / `Interactive` / `Adaptive`。バッチ処理は `Background` にすると省電力優先でスロットリングされる |
| `ThrottleInterval` | integer | 再起動の最短間隔(秒)。デフォルト 10 |
| `ExitTimeOut` | integer | 停止時に SIGTERM から SIGKILL までの猶予(秒)。デフォルト 20 |
| `LimitLoadToSessionType` | string/array | Agent の読み込み対象セッション。通常は `Aqua`(GUI) |

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
<key>StandardOutPath</key>
<string>/Users/me/Library/Logs/myjob.log</string>
<key>StandardErrorPath</key>
<string>/Users/me/Library/Logs/myjob.err.log</string>
```

### 4.4 オンデマンド起動(参考)

`Sockets` キーでポートを宣言すると、launchd がソケットを listen し、接続が来た瞬間に
プロセスを起動して fd を引き渡す(inetd 方式)。`MachServices` は XPC サービス用。
スケジュール実行が目的なら使わないが、「普段はプロセスが存在せず、必要な瞬間だけ起動する」
という launchd の思想を象徴する機能。

---

## 5. launchctl コマンド

### モダン構文(macOS 10.11+、推奨)

`gui/$(id -u)` の部分が「どのドメインに対する操作か」を表す。

```sh
# 登録(旧 load)。plist ファイルを指定
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.myjob.plist

# 解除(旧 unload)。ドメイン/Label を指定
launchctl bootout gui/$(id -u)/com.example.myjob

# 今すぐ実行(スケジュールを待たずにテストするとき)。-k は実行中なら再起動
launchctl kickstart -k gui/$(id -u)/com.example.myjob

# 状態の詳細表示(実行回数、最終終了コード、有効なトリガーなどが見える)
launchctl print gui/$(id -u)/com.example.myjob

# 無効化 / 有効化(bootout と違い、再起動・再ログイン後も無効が持続する)
launchctl disable gui/$(id -u)/com.example.myjob
launchctl enable  gui/$(id -u)/com.example.myjob
```

### plist を編集したら

**bootout → bootstrap で再読み込みが必要**。編集しただけでは反映されない。

```sh
launchctl bootout gui/$(id -u)/com.example.myjob
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.myjob.plist
```

### レガシー構文(参考)

古い記事では `load` / `unload` が使われている。今も動くが deprecated。

```sh
launchctl load   ~/Library/LaunchAgents/com.example.myjob.plist   # ≒ bootstrap
launchctl unload ~/Library/LaunchAgents/com.example.myjob.plist   # ≒ bootout
launchctl list | grep example   # 登録済みジョブ一覧(PID と最終終了コードが見える)
```

`launchctl list` は deprecated ながら「最終終了コードの一覧確認」に今でも便利。
出力は `PID / 最終終了コード / Label` の 3 列で、PID が `-` なら現在停止中。

---

## 6. cron との違い

macOS でも `crontab` は一応動くが、Apple は launchd への移行を推奨している。

| 観点 | cron | launchd |
|---|---|---|
| スリープ中に予定を逃した場合 | **スキップされる**(実行されない) | **起床後に 1 回実行される** |
| 秒・間隔指定 | 分単位のみ | `StartInterval` で秒単位の間隔指定可 |
| ファイル監視・ソケット起動 | 不可 | `WatchPaths` / `Sockets` などで可能 |
| ログ | 自前でリダイレクト | `StandardOutPath` で宣言的に指定 |
| 失敗時の再起動 | なし | `KeepAlive` で制御可能 |
| 環境変数 | crontab 内で設定 | `EnvironmentVariables` で宣言 |
| 設定の粒度 | 1 ファイルに全ジョブ | 1 ジョブ = 1 plist(管理・配布しやすい) |

ラップトップ運用の Mac では「スリープ中に予定を逃してもあとで実行される」性質が特に重要。
夜間バッチを cron で書くと、蓋を閉じていた日は一切実行されない。

---

## 7. 実践: Claude Code をスケジュール実行する

Claude Code はヘッドレスモード(`claude -p "プロンプト"`)を持つため、launchd から
定期起動して「毎朝のレポート生成」「定期的なリポジトリの健全性チェック」などを自動化できる。

### 7.1 押さえておくべきポイント

1. **`PATH` 問題**: launchd の `PATH` に `~/.local/bin`(claude の場所)は含まれない。
   絶対パスで呼ぶか、`EnvironmentVariables` で `PATH` を補う。
2. **認証**: Claude Code の認証情報はユーザーのキーチェーン等に保存されるため、
   **`gui/<UID>` ドメインの LaunchAgent** として動かす(LaunchDaemon にしない)。
   事前に一度、普通にターミナルで `claude` を起動してログイン済みにしておく。
3. **非対話実行の権限**: `-p` 実行では対話的な許可プロンプトに答えられない。
   `--allowedTools` で必要なツールだけ事前許可するのが安全
   (`--dangerously-skip-permissions` はその名の通り危険なので、まず allowedTools で絞る)。
4. **作業ディレクトリ**: `WorkingDirectory` で対象プロジェクトを指定する。
5. **ログ**: `StandardOutPath` / `StandardErrorPath` で必ず残す。デバッグの生命線。
6. **TCC(プライバシー保護)**: ジョブが `~/Documents` や `~/Desktop` など保護された
   ディレクトリを読む場合、初回にアクセス許可のダイアログが出る(バックグラウンドだと
   気づきにくい)。プロジェクトを保護対象外のパスに置くか、システム設定 →
   プライバシーとセキュリティでターミナル/該当バイナリに権限を付与しておく。

### 7.2 サンプル 1: 毎朝 9 時にプロジェクトの要約レポートを生成

`~/Library/LaunchAgents/com.shimabox.claude-daily-report.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.shimabox.claude-daily-report</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/takahiroshimabukuro/.local/bin/claude</string>
        <string>-p</string>
        <string>昨日から今日にかけての git log を確認し、変更内容の日次サマリーを reports/daily-$(実行日).md 形式で日本語で作成して</string>
        <string>--allowedTools</string>
        <string>Bash(git log:*) Bash(git diff:*) Read Write</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/takahiroshimabukuro/shimabox/github/launchd-plist</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/takahiroshimabukuro/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/takahiroshimabukuro/Library/Logs/claude-daily-report.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/takahiroshimabukuro/Library/Logs/claude-daily-report.err.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
```

登録と動作確認:

```sh
plutil -lint ~/Library/LaunchAgents/com.shimabox.claude-daily-report.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shimabox.claude-daily-report.plist

# スケジュールを待たずに今すぐテスト実行
launchctl kickstart -k gui/$(id -u)/com.shimabox.claude-daily-report

# 結果確認
tail -f ~/Library/Logs/claude-daily-report.log
```

### 7.3 サンプル 2: シェルスクリプトを噛ませるパターン(推奨)

プロンプトが長い・日付などの動的な値を使いたい・複数コマンドを組み合わせたい場合は、
plist にコマンドを直書きせず**ラッパースクリプトに切り出す**方が保守しやすい。

`~/bin/claude-daily-report.sh`:

```sh
#!/bin/zsh
set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
cd "$HOME/shimabox/github/launchd-plist"

TODAY=$(date +%Y-%m-%d)

claude -p "git log で昨日以降の変更を確認し、日次サマリーを reports/daily-${TODAY}.md に日本語で書いて" \
  --allowedTools "Bash(git log:*) Bash(git diff:*) Read Write" \
  --output-format text
```

```sh
chmod +x ~/bin/claude-daily-report.sh
```

plist 側はスクリプトを呼ぶだけにする:

```xml
<key>ProgramArguments</key>
<array>
    <string>/Users/takahiroshimabukuro/bin/claude-daily-report.sh</string>
</array>
```

こうすると **plist を再読み込みせずにスクリプト側だけ修正できる**(plist の編集は
bootout/bootstrap が必要だが、スクリプトの中身は次回実行時に自動で反映される)。

### 7.4 サンプル 3: ファイル監視で Claude を起動

「特定ディレクトリにファイルが置かれたら Claude に処理させる」パターン。

```xml
<key>QueueDirectories</key>
<array>
    <string>/Users/takahiroshimabukuro/claude-inbox</string>
</array>
```

スクリプト側で inbox 内のファイルを読んで処理し、**処理後に必ずファイルを移動 or 削除する**
(`QueueDirectories` はディレクトリが空でない限り再起動をかけ続けるため)。

### 7.5 補足: Claude Code 自身のスケジュール機能との使い分け

Claude Code には `/schedule`(クラウド上で cron 実行されるルーチン)などの組み込み
スケジュール機能もある。使い分けの目安:

- **launchd**: ローカルマシンのファイル・環境に依存する処理。マシンが起きている時だけ動けばよいもの
- **クラウドルーチン**: マシンの電源状態に依存させたくない処理、GitHub リポジトリ相手の定期処理

---

## 8. トラブルシューティング

### 8.1 まず見るもの

```sh
# ジョブの状態(state、最終終了コード、発火予定など)
launchctl print gui/$(id -u)/com.example.myjob

# 最終終了コードの一覧(0 以外なら失敗している)
launchctl list | grep example

# 標準エラーログ(StandardErrorPath を設定していれば)
tail -50 ~/Library/Logs/myjob.err.log

# launchd 自体のログ(登録失敗・spawn 失敗の理由が出る)
log show --last 30m --predicate 'process == "launchd"' | grep -i myjob
```

### 8.2 よくあるエラーと原因

| 症状 | 原因と対処 |
|---|---|
| `Bootstrap failed: 5: Input/output error` | すでに登録済み(→ 先に `bootout`)、または plist の書式・パーミッション不正(→ `plutil -lint`、ファイル権限を確認) |
| `Bootstrap failed: 125: Domain does not support specified action` | ドメイン指定ミス。Agent を `system` に入れようとした等。`gui/$(id -u)` を確認 |
| `Boot-out failed: 36: Operation now in progress` | 稀に停止処理と競合する。少し待って再実行 |
| 登録はできたが一度も実行されない | `disable` されている可能性 → `launchctl print-disabled gui/$(id -u)` で確認し `enable` する |
| 実行されるが即失敗(exit 127) | コマンドが見つからない。**PATH 問題**。絶対パスにするか `EnvironmentVariables` で PATH を設定 |
| 実行されるが即失敗(exit 78) | plist の設定不備(`Program` のパスが存在しない等) |
| "respawning too quickly" | `ThrottleInterval`(既定 10 秒)より速く死んでいる。ジョブ自体のエラーを先に直す |
| ファイルが読めない・書けない | TCC(プライバシー保護)。保護ディレクトリ(Documents/Desktop/Downloads 等)へのアクセス権を確認 |
| `~` や `$HOME` が展開されない | plist 内のパスはシェル展開されない。**絶対パスで書く** |

### 8.3 デバッグの定石

1. **まずターミナルで直接動かす**: `ProgramArguments` に書いたコマンドをそのまま実行して成功するか
2. **次に環境を launchd に近づけて動かす**: `env -i PATH=/usr/bin:/bin HOME=$HOME コマンド` で
   素の環境でも動くか確認(PATH・環境変数依存を炙り出せる)
3. **`kickstart -k` で即時実行**してスケジュールを待たずに検証する
4. **`StandardErrorPath` は必ず設定する**。これがないと失敗理由がほぼ追えない

---

## 9. 参考資料

- `man launchd.plist` — 全キーの正式なリファレンス
- `man launchctl` — コマンドリファレンス
- Apple: [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [launchd.info](https://launchd.info/) — 非公式だが網羅的でわかりやすい解説サイト
- Claude Code ヘッドレスモード: `claude --help` および公式ドキュメントの CLI リファレンス
