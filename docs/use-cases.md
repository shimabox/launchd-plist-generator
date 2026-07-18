# launchd ユースケース集

launchd で実際に何を自動化すると便利なのか、実用的なユースケースを 6 つまとめる。
いずれもリポジトリルートの generator(`index.html`)でベースの plist を作り、
必要ならスクリプトを足すだけで実現できる。キーの詳細は [guide.md](guide.md) と
[reference.md](reference.md) を参照。

## 1. 生成 AI をスケジュール起動する

Claude Code のヘッドレスモード(`claude -p`)を launchd から起動すると、
「毎朝、AI がローカルの成果物を作っておいてくれる」仕組みが作れる。

おすすめの形は、やらせたい仕事を**スキル(カスタムスラッシュコマンド)として
プロジェクト側に用意しておき、plist からはそれを呼ぶだけ**にすること。
プロンプトの中身はリポジトリ内のスキル定義(`.claude/` 配下)で管理できるので、
plist を再登録せずに仕事の内容を改善していける。

```xml
<key>ProgramArguments</key>
<array>
    <string>/Users/username/.local/bin/claude</string>
    <string>-p</string>
    <string>/daily-report</string>
    <string>--allowedTools</string>
    <string>Bash(git log:*) Bash(git diff:*) Read Write</string>
</array>
<key>WorkingDirectory</key>
<string>/Users/username/projects/myrepo</string>
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>30</integer>
</dict>
```

### クラウド側のスケジュール実行との使い分け

Claude Code 自体にもクラウドで動くスケジュール機能(`/schedule` によるルーチン)がある。
launchd 起動が勝つのは「ローカルの世界」を触る仕事、クラウドが勝つのは
「マシンの電源に左右されたくない」仕事である。

| 観点 | launchd(ローカル起動) | クラウドルーチン |
|---|---|---|
| ローカルファイル・ローカル DB | 触れる | 触れない |
| プライベートな社内・VPN 内リソース | 触れる | 基本触れない |
| brew の CLI・Docker などローカルツール | そのまま使える | 使えない |
| 成果物の置き場所 | ローカルに直接書ける(Obsidian の vault など) | クラウド側 |
| ファイル駆動トリガー(下記 3 のような) | WatchPaths / QueueDirectories で可能 | なし |
| マシンの電源・スリープ | 起きている必要がある([guide.md](guide.md) 6 章参照) | 無関係 |

とくに強いのが QueueDirectories との組み合わせで、
「このフォルダに PDF を放り込んだら AI が要約してメモに追記する」のような
**ファイルを置くだけで AI が動く仕組み**はローカルならでは。
無人実行なので、権限は `--allowedTools` で必ず絞ること([guide.md](guide.md) 7.6 参照)。

## 2. 夜間バックアップ

`rsync` や `restic` で外付けディスクや NAS へ毎晩バックアップする。
cron と違い、スリープで時刻を逃しても起床後に 1 回実行されるのが
ラップトップ運用に効く。

- トリガーは `StartCalendarInterval`(深夜または昼休みなど確実に起きている時間帯)
- `LowPriorityIO` を true にしておくと、作業中に走っても体感への影響が小さい
- 蓋を閉じたまま夜間に確実に走らせたい場合は `pmset` の併用([guide.md](guide.md) 6 章)

## 3. ダウンロードフォルダの自動整理

`WatchPaths` で `/Users/username/Downloads` を監視し、変更があったら整理スクリプトを起動する
(plist 内では `~` が使えないので絶対パスで書く)。
拡張子ごとのサブフォルダへの振り分け、スクリーンショットのリネーム、
30 日以上前のファイルの退避などを自動化できる。

- 発火が高頻度になるので、スクリプトは何度動いても安全なように(冪等に)書く
- 「処理したら消す」形のジョブなら `QueueDirectories` の方が向く

## 4. 開発環境の定期メンテナンス

平日の朝イチや週末に、環境の手入れを済ませておく。

- `brew update && brew upgrade && brew cleanup`
- `docker system prune -f`(肥大化しがちなイメージ・キャッシュの掃除)
- 関わっているリポジトリ群への `git fetch`(レビュー前に最新化しておく)

トリガーは `StartCalendarInterval` の `Weekday` 指定。まとめてラッパースクリプトにして、
`StandardOutPath` のログで実行結果を確認できるようにしておくとよい。

## 5. 休憩・退勤リマインダー

`say` や macOS の通知で、時間を声・バナーで知らせる。plist 1 枚で完結する
いちばん手軽なユースケースで、最初の練習題材にも向く
([hajimete-no-launchd.md](hajimete-no-launchd.md) はこれを題材にしている)。

```sh
# 通知センターにバナーを出す場合
osascript -e 'display notification "そろそろ休憩" with title "リマインダー"'
```

- 毎時 50 分に休憩通知なら `StartCalendarInterval` で `Minute` だけ指定
- 50 分おきのポモドーロ風なら `StartInterval` に 3000 を指定

## 6. ローカル常駐サービスの自動復活

開発用のモック API サーバーや Syncthing のようなローカル常駐プロセスを、
ログイン時に起動して、落ちたら自動で再起動させる。

```xml
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key>
    <false/>
</dict>
```

- 「異常終了したときだけ再起動」にしておくと、自分で止めたときは止まったままにできる
- すぐ死ぬ状態で放置すると約 10 秒間隔の再起動ループになるので、
  まず手動起動で安定してから plist 化する([guide.md](guide.md) 4.2 の ThrottleInterval 参照)
