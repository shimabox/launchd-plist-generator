# launchd.plist 網羅的リファレンス

`man launchd.plist` に載っている主要キーをほぼすべてカバーする長編リファレンス。
初めての人は [intro.md](intro.md)、実践的な使い方は [guide.md](guide.md) から読むこと。

【必須】は必須キー、【D】は LaunchDaemon 専用または Daemon で主に意味を持つキーを表す。

## 目次

1. [識別・基本](#1-識別基本)
2. [実行対象](#2-実行対象)
3. [起動トリガー](#3-起動トリガー)
4. [常駐・再起動制御 (KeepAlive)](#4-常駐再起動制御-keepalive)
5. [実行コンテキスト(ユーザー・ディレクトリ・環境変数)](#5-実行コンテキストユーザーディレクトリ環境変数)
6. [入出力・ログ](#6-入出力ログ)
7. [リソース制限・優先度](#7-リソース制限優先度)
8. [ライフサイクル・タイムアウト](#8-ライフサイクルタイムアウト)
9. [読み込み条件 (LimitLoadTo...)](#9-読み込み条件-limitloadto)
10. [オンデマンド起動 (Sockets / MachServices)](#10-オンデマンド起動-sockets--machservices)
11. [その他のキー](#11-その他のキー)
12. [launchctl サブコマンド一覧](#12-launchctl-サブコマンド一覧)
13. [ドメインとセッションの詳細](#13-ドメインとセッションの詳細)

## 1. 識別・基本

### `Label`(string)【必須】

ジョブの一意な識別子。ドメイン内で重複不可。逆 DNS 形式(`com.username.jobname`)が慣習。
plist のファイル名は `<Label>.plist` に揃えるのが強く推奨される(必須ではないが、
ツールや人間の期待を裏切らないため)。

### `Disabled`(boolean、既定は false)

plist 自体に書く「無効フラグ」。ただし現在は **`launchctl enable/disable` が管理する
override データベースが優先される**ため、このキーはヒントに過ぎない。
新規に書く plist では通常使わない。無効化したいなら次のようにする。

```sh
launchctl disable gui/$(id -u)/com.example.myjob
```

override の状態確認は `launchctl print-disabled gui/$(id -u)`。

## 2. 実行対象

### `ProgramArguments`(array of strings)

実行するコマンドの argv をそのまま配列にしたもの。`Program` とどちらか一方が必須。

```xml
<key>ProgramArguments</key>
<array>
    <string>/usr/bin/rsync</string>
    <string>-av</string>
    <string>/src/</string>
    <string>/dst/</string>
</array>
```

重要な性質は次のとおり。

- **シェルを介さない**(`execvp` 直接呼び出しに近い)。パイプ、リダイレクト、
  グロブ(`*.txt`)、変数展開(`$HOME`)、チルダ展開(`~/`)はすべて使えない
- 第 1 要素は `PATH` から検索される(`Program` と違い絶対パスでなくても動く)が、
  launchd の `PATH` は最小限なので**実務上は絶対パスで書くべき**
- シェル機能が必要な場合は明示的にシェルを噛ませる。

```xml
<array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>cd ~/project && make build 2>&1 | tee -a ~/build.log</string>
</array>
```

### `Program`(string)

実行ファイルの絶対パスのみを指定する場合に使う。`ProgramArguments` と併用した場合、
`Program` が実行ファイル、`ProgramArguments` が argv(argv[0] 含む)になる。
通常は `ProgramArguments` だけで足りる。

### `BundleProgram`(string)

バンドル(.app 等)内の相対パスで実行ファイルを指定する。`SMAppService` 等で
アプリに同梱するヘルパーを登録する場合に使う。手書きの plist ではほぼ使わない。

## 3. 起動トリガー

トリガーは複数併用できる(例: `RunAtLoad` + `StartCalendarInterval`)。
いずれのトリガーでも、**すでに実行中のジョブは二重起動されない**(1 Label = 最大 1 プロセス)。

### `RunAtLoad`(boolean、既定は false)

ジョブがドメインに読み込まれた時点で 1 回起動する。
「読み込まれた時点」とは、ログイン時(LaunchAgent)、システム起動時(LaunchDaemon)、
または手動で `launchctl bootstrap` した瞬間を指す。

### `StartInterval`(integer、秒)

N 秒ごとに起動する。前回の**起動時刻**基準(終了時刻ではない)。
実行に間隔以上の時間がかかった場合、次の分はスキップされる(キューに積まれない)。
**スリープ中に迎えた発火は失われる**(man launchd.plist いわく kqueue の制約による)。
起床後の補完実行があるのは `StartCalendarInterval` だけで、こちらにはない。

### `StartCalendarInterval`(dict または array of dicts)

カレンダー(cron)方式。指定できるフィールドは次のとおり。

| フィールド | 範囲 | 備考 |
|---|---|---|
| `Minute` | 0–59 | |
| `Hour` | 0–23 | |
| `Day` | 1–31 | 存在しない日(2/30 等)は発火しない |
| `Weekday` | 0–7 | 0 と 7 はどちらも日曜 |
| `Month` | 1–12 | |

- **省略したフィールドはワイルドカード**。`{Minute: 0}` だけなら「毎時 0 分」
- cron の `*/5`(N 分おき)に相当する記法は**ない**。配列で列挙するか `StartInterval` を使う
- 複数スケジュールは dict の array で指定
- **`Day` と `Weekday` を同時に指定すると AND ではなく OR になる**。
  「毎月 1 日かつ月曜」ではなく「毎月 1 日と、毎週月曜の両方」で実行される
- スリープ中に逃した発火は、起床後に **1 回に集約されて**実行される。
  電源オフ中に逃した分は実行されない(anacron 的な補完はない)

```xml
<!-- 毎時 0 分と 30 分 -->
<key>StartCalendarInterval</key>
<array>
    <dict><key>Minute</key><integer>0</integer></dict>
    <dict><key>Minute</key><integer>30</integer></dict>
</array>
```

### `WatchPaths`(array of strings)

指定パスに変更(作成・削除・書き込み・属性変更)があったら起動する。
パスがディレクトリの場合、直下のエントリの増減で発火する(再帰監視ではない)。
発火が高頻度になり得るので、ジョブ側は冪等に書くこと。

### `QueueDirectories`(array of strings)

指定ディレクトリが「空でない」限りジョブを起動し続ける、ジョブキュー向けのキー。
ジョブは処理したファイルを**削除または移動する責務を負う**。空にしないと
`ThrottleInterval` 間隔で延々と再起動される。

### `StartOnMount`(boolean、既定は false)

ファイルシステムがマウントされたとき(USB ドライブ接続、ディスクイメージのマウント等)に起動する。

### `LaunchOnlyOnce`(boolean、既定は false)

ジョブの生存期間中に 1 回しか実行できないことを宣言する。実行後は再読み込みまで二度と起動しない。

## 4. 常駐・再起動制御 (KeepAlive)

### `KeepAlive`(boolean または dict、既定は false)

**boolean 形式**で指定した場合の動作は次のとおり。

- `true`: 無条件常駐。プロセスが終了したら(理由を問わず)再起動する
- `false`(既定): オンデマンド。トリガー成立時のみ起動

**dict 形式**は条件付きの再起動制御になる。複数条件は AND ではなく「いずれかが再起動を要求すれば再起動」と解釈される。

| サブキー | 型 | 意味 |
|---|---|---|
| `SuccessfulExit` | boolean | `true`: 正常終了(exit 0)のとき再起動 / `false`: **異常終了のとき**再起動(こちらが典型) |
| `Crashed` | boolean | `true`: クラッシュ(シグナル死)したとき再起動 / `false`: クラッシュしなかったとき再起動 |
| `PathState` | dict of booleans | パス → bool。`true`: そのパスが**存在する間**生かす / `false`: 存在しない間生かす |
| `OtherJobEnabled` | dict of booleans | Label → bool。他ジョブの有効/無効状態に連動 |
| `NetworkState` | boolean | **非推奨**。ネットワーク到達性での制御は当てにならない。アプリ側でリトライすべき |

```xml
<!-- 異常終了したときだけ再起動(サーバープロセスの定番) -->
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key>
    <false/>
</dict>
```

> `KeepAlive` と `ThrottleInterval`(後述)はセットで理解する。
> 即死するジョブを `KeepAlive: true` にすると 10 秒間隔の再起動ループになる。

## 5. 実行コンテキスト(ユーザー・ディレクトリ・環境変数)

### `UserName` / `GroupName`(string)【D】

実行ユーザー/グループ。**LaunchDaemon 専用**(Agent はセッションの所有者で動くため指定不可)。
`UserName` を指定して `GroupName` を省略すると、そのユーザーのプライマリグループになる。

### `InitGroups`(boolean、既定は true)【D】

`UserName` 指定時に `initgroups(3)` を呼んで補助グループを設定するか。

### `WorkingDirectory`(string)

`chdir(2)` 先。未指定時は `/`(Daemon)またはセッション依存。
相対パスでファイルを扱うジョブでは必ず指定する。

### `RootDirectory`(string)【D】

`chroot(2)` 先。使う場面はまれ。

### `EnvironmentVariables`(dict of strings)

環境変数。値の中で他の変数は展開されない(`$HOME` と書いても文字列のまま)。

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key>
    <string>ja_JP.UTF-8</string>
</dict>
```

launchd から渡される既定の環境は最小限で、`PATH=/usr/bin:/bin:/usr/sbin:/sbin`、
`HOME`、`SHELL`、`USER`、`LOGNAME`、`TMPDIR` 程度しかない。`~/.zshrc` 等は一切読まれない。

### `Umask`(integer)

umask 値。**plist の integer は 10 進として解釈される**点に注意。
umask 022 を設定したいなら 8 進の 022 = 10 進の 18 を書く…のは分かりにくいので、
`launchctl` 経由ではなくスクリプト内で `umask` する方が事故が少ない。

### `SessionCreate`(boolean、既定は false)

新しいセキュリティセッションを作るか。通常は不要。

## 6. 入出力・ログ

### `StandardOutPath` / `StandardErrorPath`(string)

stdout / stderr の書き出し先ファイル(**追記**モードで開かれる)。
ローテーションはされないので、肥大化が気になるなら `newsyslog.d` を併用するか
スクリプト側でログ管理する。ディレクトリが存在しないと出力されないので注意。

### `StandardInPath`(string)

stdin として開くファイル。ほぼ使わない。

### os_log との関係(補足)

`StandardOutPath` を指定しない場合、stdout/stderr は基本的に捨てられる
(一部は統合ログに乗ることもあるが当てにしない)。**デバッグ可能性のため、
非自明なジョブでは必ず両方指定する**のが定石。

## 7. リソース制限・優先度

### `Nice`(integer、-20〜20)

スケジューリング優先度。正の値で低優先度。

### `ProcessType`(string)

ジョブの性格を宣言し、OS のリソース管理(App Nap 的なスロットリング)に反映される。

| 値 | 意味 |
|---|---|
| `Standard` | 既定 |
| `Background` | ユーザーが直接見ないバッチ処理。省電力優先で CPU/IO を絞られる |
| `Adaptive` | XPC サービス向け。呼び出し元アプリの優先度に追従 |
| `Interactive` | ユーザー体験に直結する処理。絞られない(乱用しない) |

### `LowPriorityIO` / `LowPriorityBackgroundIO`(boolean)

ディスク I/O を低優先度にする。バックアップ系ジョブに向く。

### `SoftResourceLimits` / `HardResourceLimits`(dict)

`setrlimit(2)` 相当。サブキーは
`Core`, `CPU`, `Data`, `FileSize`, `MemoryLock`, `NumberOfFiles`,
`NumberOfProcesses`, `ResidentSetSize`, `Stack`(いずれも integer)。

```xml
<!-- 開けるfd数を増やす例 -->
<key>SoftResourceLimits</key>
<dict>
    <key>NumberOfFiles</key>
    <integer>4096</integer>
</dict>
```

## 8. ライフサイクル・タイムアウト

### `ThrottleInterval`(integer、秒、既定は 10)

同一ジョブの再起動間の最短間隔。これより早く終了したジョブの次回起動は残り時間ぶん遅延され、
統合ログに "respawning too quickly" 系のメッセージが出る。
**0 にして高速ループさせる用途には使わない**こと(それはジョブ側の設計で解決する)。

### `ExitTimeOut`(integer、秒、既定は 20)

ジョブ停止時、launchd は SIGTERM を送り、この秒数待っても生きていれば SIGKILL する。
クリーンアップに時間がかかるジョブでは延ばす。

### `TimeOut`(integer、秒)

アイドルタイムアウトのヒント(オンデマンドジョブ向け)。現代ではほぼ意味を持たない。

### `AbandonProcessGroup`(boolean、既定は false)

通常、launchd はジョブ終了時に**同じプロセスグループの子プロセスも SIGKILL する**。
`true` にすると子孫を殺さず放置する。「ジョブがバックグラウンドの孫プロセスを
起動して自分は終了する」パターン(本来は launchd では避けるべき設計)で必要になる。

### `EnableTransactions` / `EnablePressuredExit`(boolean)

XPC トランザクション/メモリ圧による自動終了への協調。XPC を使うプログラム向けで、
シェルスクリプトのジョブでは無関係。

### `LegacyTimers`(boolean、既定は false)

`true` にするとタイマー(`StartInterval` 等)の省電力的な発火揺らぎ(coalescing)を無効化し、
できるだけ正確な時刻に発火させる。バッテリー消費と引き換えなので、秒単位の精度が
本当に必要なときだけ使う。

## 9. 読み込み条件 (LimitLoadTo...)

### `LimitLoadToSessionType`(string または array)

Agent をどのセッション種別で読み込むか。

| 値 | 意味 |
|---|---|
| `Aqua` | GUI ログインセッション(既定・通常はこれ) |
| `Background` | ユーザーのバックグラウンドセッション(SSH のみのログインでも読み込まれる) |
| `LoginWindow` | ログイン画面のコンテキスト |
| `StandardIO` | 非 GUI コンテキスト |

### `LimitLoadToHardware` / `LimitLoadFromHardware`(dict)

ハードウェアモデル(`hw.model` 等)で読み込みを制限/除外する。

## 10. オンデマンド起動 (Sockets / MachServices)

「接続が来るまでプロセスを起動しない」ための仕組み。スケジュール実行では使わないが、
launchd の中核機能なので概観だけ押さえる。

### `Sockets`(dict)

launchd が代理でソケットを listen し、接続到来時にジョブを起動して
`launch_activate_socket(3)` API 経由で fd を引き渡す。主なサブキーは次のとおり。

| サブキー | 意味 |
|---|---|
| `SockServiceName` | ポート番号またはサービス名(`/etc/services`) |
| `SockType` | `stream`(既定)/ `dgram` / `seqpacket` |
| `SockFamily` | `IPv4` / `IPv6` / `IPv4v6` / `Unix` |
| `SockNodeName` | bind するアドレス |
| `SockPathName` | UNIX ドメインソケットのパス |
| `SockPathMode` | 同パーミッション(**10 進**で書く点に注意) |
| `SockPassive` | listen する(true、既定)か connect する(false)か |
| `Bonjour` | Bonjour 広告(boolean / string / array) |
| `MulticastGroup` | 参加するマルチキャストグループ |

### `inetdCompatibility`(dict)

inetd 互換モード。`Wait`(boolean)で wait / nowait 方式を選ぶ。
nowait なら接続ごとにプロセスが起動され stdin/stdout がソケットになる。
レガシープログラムの延命用。

### `MachServices`(dict)

XPC / Mach IPC のサービス名を登録する。メッセージ到来でジョブが起動される。
サブキーに `ResetAtClose`、`HideUntilCheckIn`。ネイティブアプリ開発の領域。

## 11. その他のキー

| キー | 型 | 説明 |
|---|---|---|
| `Debug` | boolean | このジョブに関する launchd のログレベルを LOG_DEBUG に上げる |
| `WaitForDebugger` | boolean | 起動直後にデバッガのアタッチを待って停止する |
| `MaterializeDatalessFiles` | boolean | dataless ファイル(iCloud 未ダウンロード等)へのアクセス時に実体化するか |
| `AssociatedBundleIdentifiers` | string/array | システム設定の「ログイン項目」にどのアプリの項目として表示するかを紐付ける(Ventura 以降の UI 表示用) |

> **廃止・非推奨キー**: `OnDemand`(→ `KeepAlive` で置換)、`ServiceIPC`、
> `HopefullyExitsFirst` / `HopefullyExitsLast`。古い記事で見かけても新規には使わない。

## 12. launchctl サブコマンド一覧

### ジョブ管理(モダン)

| コマンド | 説明 |
|---|---|
| `bootstrap <domain> <plist...>` | plist をドメインに登録 |
| `bootout <domain>/<label>` または `bootout <domain> <plist>` | 登録解除 |
| `enable <service-target>` | 有効化(再起動後も持続する override) |
| `disable <service-target>` | 無効化(同上) |
| `kickstart [-k] [-p] <service-target>` | 即時起動。`-k` は実行中なら kill して再起動、`-p` は起動した PID を表示 |
| `kill <signal> <service-target>` | ジョブにシグナル送信 |
| `attach <service-target>` | デバッガ的にアタッチ |
| `blame <service-target>` | **なぜ現在実行中なのか**(どのトリガーで起動したか)を表示 |
| `print <domain>` / `print <service-target>` | ドメイン/ジョブの詳細状態 |
| `print-disabled <domain>` | disable の override 一覧 |
| `runstats <service-target>` | 実行統計 |

### 環境・ユーティリティ

| コマンド | 説明 |
|---|---|
| `getenv <key>` / `setenv <key> <value>` / `unsetenv <key>` | launchd グローバル環境変数の取得/設定 |
| `limit` | launchd 自体の resource limits |
| `plist <file>` | バイナリ plist の中身を表示 |
| `hostinfo` | ホスト情報 |
| `error <code>` | エラーコードの意味を表示(例: `launchctl error 125`) |

### レガシー(deprecated だが現役でよく見る)

| コマンド | モダン相当 |
|---|---|
| `load [-w] <plist>` | `bootstrap` (+ `-w` は `enable`) |
| `unload [-w] <plist>` | `bootout` (+ `-w` は `disable`) |
| `start <label>` | `kickstart` |
| `stop <label>` | `kill SIGTERM` |
| `list [label]` | `print`(ただし一覧表示は今も `list` が手軽) |

## 13. ドメインとセッションの詳細

### ドメインターゲットの書式

```
system                     → システムドメイン(Daemon)
user/<uid>                 → ユーザードメイン(GUI 不要のユーザージョブ)
gui/<uid>                  → GUI セッションドメイン(LaunchAgent の既定)
login/<asid>               → ログインセッション(監査セッション ID 指定)
pid/<pid>                  → 特定プロセスのドメイン
```

サービスターゲットはドメインターゲットに `/<label>` を付けたもので、
`gui/501/com.example.myjob` のようになる。

### `user/<uid>` と `gui/<uid>` の違い

- `gui/<uid>`: GUI ログイン中のみ存在。ウィンドウサーバー・キーチェーン・
  Aqua セッションにアクセスできる。**`~/Library/LaunchAgents` の plist は
  ログイン時にここへ自動読み込みされる**
- `user/<uid>`: ユーザーが何らかの形でログインしていれば存在(SSH のみでも可)。
  GUI リソースには触れない

### 読み込みの流れ(LaunchAgent の場合)

1. ユーザーがログイン → launchd が `gui/<uid>` ドメインを生成
2. `/System/Library/LaunchAgents`、`/Library/LaunchAgents`、`~/Library/LaunchAgents`
   の plist を読み込み(disable override されているものは除外)
3. `RunAtLoad: true` のジョブを起動、その他はトリガー待ちで待機
4. ログアウトでドメインごと破棄(ジョブも終了)

## 付録 終了コード早見表

`launchctl list` の 2 列目や `launchctl print` の `last exit code` で見る値は次のとおり。

| コード | 意味 |
|---|---|
| 0 | 正常終了 |
| 1〜 | プログラム自身が返したエラーコード |
| 78 (EX_CONFIG) | plist の設定不備(実行ファイルが存在しない等)で spawn 自体に失敗 |
| 126 | 実行権限がない |
| 127 | コマンドが見つからない(PATH 問題の典型) |
| `(never exited)` / PID あり | 現在実行中 |

シグナル死の場合は `last exit code = (SIGxxx)` 形式で表示される。
