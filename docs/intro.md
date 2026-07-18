# launchd plist 入門

launchd で「定期的にコマンドを実行する」ための最小限の知識だけをまとめる。
詳しい仕組みは [guide.md](guide.md)(実用ガイド)、全キーの解説は
[reference.md](reference.md)(網羅的リファレンス)を参照。

## launchd とは(3 行で)

- macOS の全プロセスの親玉(Linux の systemd 相当)。cron の後継でもある
- 「いつ・何を実行するか」を **plist ファイルに書いて登録する**と、あとは launchd が面倒を見てくれる
- cron と違い、**スリープ中に逃した予定は起床後に 1 回実行してくれる**

## 手順は 3 ステップ

### 1. plist ファイルを書く

置き場所は `~/Library/LaunchAgents/`。ファイル名は `Label` と同じにする。

`~/Library/LaunchAgents/com.example.hello.plist` を次の内容で作る。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ジョブの名前(一意なら何でもよい。逆DNS形式が慣習) -->
    <key>Label</key>
    <string>com.example.hello</string>

    <!-- 実行するコマンド。絶対パスで、引数は1つずつ分けて書く -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/date</string>
    </array>

    <!-- 毎朝 9:00 に実行 -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>0</integer>
    </dict>

    <!-- 出力をログに残す(デバッグに必須) -->
    <key>StandardOutPath</key>
    <string>/tmp/hello.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/hello.err.log</string>
</dict>
</plist>
```

### 2. 登録する

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.hello.plist
```

### 3. テスト実行して確認する

```sh
# スケジュールを待たずに今すぐ実行
launchctl kickstart -k gui/$(id -u)/com.example.hello

# 結果を確認
cat /tmp/hello.log
```

## 最低限のコマンド

```sh
launchctl bootstrap gui/$(id -u) <plistファイル>   # 登録
launchctl bootout   gui/$(id -u)/<Label>          # 解除
launchctl kickstart -k gui/$(id -u)/<Label>       # 今すぐ実行
launchctl print     gui/$(id -u)/<Label>          # 状態確認
```

plist を編集したら、いったん `bootout` してから `bootstrap` し直して再登録する(編集しただけでは反映されない)。

## ハマりどころ 3 つ

1. **`PATH` が最小限**(`/usr/bin:/bin:/usr/sbin:/sbin` のみ)。
   コマンドは絶対パスで書く。`which コマンド名` で調べられる。
2. **`~` や `$HOME` は展開されない**。パスはすべて絶対パスで。
3. **パイプやリダイレクトは書けない**。シェル機能が必要なら
   スクリプトファイルに切り出して、それを `ProgramArguments` で呼ぶ。

## よく使うトリガー早見表

| やりたいこと | キー | 書き方 |
|---|---|---|
| 毎日決まった時刻 | `StartCalendarInterval` | `Hour`/`Minute` を指定 |
| N 秒ごと | `StartInterval` | `<integer>300</integer>`(5分ごと) |
| ログイン時に 1 回 | `RunAtLoad` | `<true/>` |
| ファイル変更を検知 | `WatchPaths` | 監視パスの配列 |
| 常駐(死んだら再起動) | `KeepAlive` | `<true/>` |

次のステップとして、[guide.md](guide.md) で仕組みと Claude Code 連携の実践例に進もう。
