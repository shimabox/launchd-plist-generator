# はじめての launchd 〜 Mac に「自動でやっといて」をお願いする方法 〜

このガイドは、[intro.md](intro.md)・[guide.md](guide.md)・[reference.md](reference.md) の
3 つの記事を、はじめての人でも読めるようにやさしくまとめたものです。
読み終わるころには、**自分の Mac に「毎日決まった時間にしゃべらせる」設定**が自分で作れるようになります。

## 1. launchd(ローンチディー)ってなに?

Mac の中には、**launchd** という「執事(しつじ)」のようなプログラムがずっと働いています。

執事にお願いできることは、たとえばこんなことです。

- 「**毎朝 7 時に**このプログラムを動かして」(目覚まし係)
- 「**5 分ごとに**チェックして」(見回り係)
- 「**このフォルダにファイルが入ったら**教えて」(見張り係)
- 「このプログラムが**止まっちゃったら、もう一度動かして**」(復活係)

自分で夜中に起きてボタンを押さなくても、執事が代わりにやってくれる。
これが launchd です。

### お願いは「お願いごとカード」に書く

執事へのお願いは、口で言うのではなく **1 枚のカード(ファイル)に書いて渡します**。
このカードのことを **plist(ピーリスト)** と呼びます。

カードに書くことは、基本この 3 つだけです。

| カードに書くこと | 意味 |
|---|---|
| **名前**(Label) | お願いごとの名前。ほかとかぶらないようにする |
| **なにをするか**(ProgramArguments) | 動かすプログラム |
| **いつやるか**(StartCalendarInterval など) | 時間や条件 |

## 2. 「毎日 19 時に Mac がしゃべる」を作ってみよう

Mac には `say`(セイ)という「文章を声に出して読むコマンド」が最初から入っています。
これを launchd に毎日動かしてもらいましょう。

### まずはターミナルを開く

「ターミナル」は、Mac に文字で命令するアプリです。

1. キーボードで `command + スペース` を押す(検索が開く)
2. 「ターミナル」と入力して Enter

黒っぽい(または白い)画面が開けば OK。ここに命令を打ち込んでいきます。

> 💡 これから出てくる命令は、**1 行ずつコピーして貼り付けて Enter** すれば大丈夫です。

### ステップ 1 しゃべる練習(まず手動で)

いきなり自動化する前に、コマンドが動くことを確かめます。ターミナルにこれを貼り付けて Enter を押してみてください。

```sh
say "こんにちは。わたしはあなたのMacです"
```

Mac がしゃべったら成功です!(音量が 0 だと聞こえないので注意)

### ステップ 2 お願いごとカード(plist)を作る

カードを置く場所は決まっています。自分専用のお願いは
`ホーム/Library/LaunchAgents/` というフォルダに置きます。

下のかたまりを**まるごと全部コピーして**、ターミナルに貼り付けて Enter してください。
(フォルダを作って、その中にカードのファイルを書き込む命令です)

```sh
mkdir -p ~/Library/LaunchAgents

cat > ~/Library/LaunchAgents/com.watashi.oshaberi.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ① 名前: お願いごとの名前 -->
    <key>Label</key>
    <string>com.watashi.oshaberi</string>

    <!-- ② なにをするか: sayコマンドでしゃべる -->
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/say</string>
        <string>19時になりました。そろそろ休憩しませんか</string>
    </array>

    <!-- ③ いつやるか: 毎日19時0分 -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>19</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
</dict>
</plist>
EOF
```

カードの中身を見ると、さっきの表の ①名前 ②なにをするか ③いつやるか が
そのまま書いてあるのがわかると思います。

> 💡 `<string>` の中の「19時になりました〜」の部分は、好きなセリフに変えて OK です。

### ステップ 3 カードを執事に渡す(登録)

カードは作っただけでは効きません。この命令で執事(launchd)に渡します。

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.watashi.oshaberi.plist
```

**何も表示されなければ成功**です(ターミナルは成功のとき静かなことが多い)。

- `launchctl`(ローンチコントロール)= 執事と話すための窓口
- `bootstrap` = 「このカードお願いします」と渡すこと
- `gui/$(id -u)` = 「今ログインしている自分の担当執事に」という意味

### ステップ 4 19 時まで待たずにテストする

ちゃんと登録できたか、この命令で今すぐ動かして確かめられます。

```sh
launchctl kickstart -k gui/$(id -u)/com.watashi.oshaberi
```

Mac がしゃべったら、設定はすべて完成です! 🎉
あとは毎日 19 時になると、Mac が勝手にしゃべります。
(Mac がスリープ中だった場合は、次にフタを開けたときにまとめて 1 回しゃべります)

### ステップ 5 変えたいとき・やめたいとき

**セリフや時間を変えたいとき**は、ステップ 2 の命令をもう一度(中身を変えて)実行してから、
いったんカードを返してもらって渡し直します。

```sh
launchctl bootout gui/$(id -u)/com.watashi.oshaberi
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.watashi.oshaberi.plist
```

**完全にやめたいとき**は、カードを返してもらってファイルも消します。

```sh
launchctl bootout gui/$(id -u)/com.watashi.oshaberi
rm ~/Library/LaunchAgents/com.watashi.oshaberi.plist
```

## 3. しくみのおさらい

いま何をしたのか、流れを図にするとこうなります。

```
あなた                     執事 (launchd)
  │                           │
  │ ① plistカードを書く        │
  │ ② bootstrap で渡す ──────▶│ カードを受け取って覚える
  │                           │
  │        (毎日19:00になると) │
  │                           ├──▶ say を動かす 🗣
  │                           │
  │ ③ bootout で返してもらう ─▶│ もうやらない
```

覚えることは実はこれだけです。

| 命令 | 意味 |
|---|---|
| `launchctl bootstrap gui/$(id -u) カードのファイル` | お願いを**登録** |
| `launchctl bootout gui/$(id -u)/名前` | お願いを**解除** |
| `launchctl kickstart -k gui/$(id -u)/名前` | **今すぐ**動かしてテスト |
| `launchctl print gui/$(id -u)/名前` | 今どうなってるか**確認** |

## 4. 「いつやるか」のバリエーション

カードの ③ の部分を書きかえると、いろいろなタイミングにできます。

**朝 7 時 30 分**に動かしたいとき(目覚まし)は、こう書きます。

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>30</integer>
</dict>
```

**30 分ごと**にくり返したいとき(休憩リマインダー)は、こう書きます。

```xml
<key>StartInterval</key>
<integer>1800</integer>
```

(1800 は秒数です。60 秒 × 30 分 = 1800)

**日曜日の 20 時**に週 1 回だけ動かしたいときは、こう書きます。

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>20</integer>
    <key>Minute</key><integer>0</integer>
</dict>
```

(Weekday は 0 が日曜、1 が月曜、…、6 が土曜)

## 5. うまくいかないときの 3 つのチェック

### チェック 1 カードの書き方が正しいか

```sh
plutil -lint ~/Library/LaunchAgents/com.watashi.oshaberi.plist
```

`OK` と出れば書き方は正しい。エラーが出たら、コピーのしそこないがないか確認して
ステップ 2 をやり直します。

### チェック 2 すでに登録済みじゃないか

`Bootstrap failed: 5: Input/output error` と出たら、たいてい「もう登録されてるよ」という意味。
いったん `bootout` してから `bootstrap` し直します。

### チェック 3 プログラムの場所が正しいか

執事はプログラムを**フルネーム(絶対パス)**で教えないと見つけられません。
`say` ではなく `/usr/bin/say` と書くのはそのためです。
プログラムのフルネームは、ターミナルで `which say` のように聞くと教えてくれます。

> 💡 これは少し上級の話ですが、執事の世界では「`~`(ホームの略記号)」も通じません。
> ファイルの場所は全部 `/Users/自分の名前/...` のように書きます。

## 6. 気をつけること(だいじ)

- **人からもらった plist をそのまま入れない。** plist は「自動でプログラムを動かす」ファイルなので、
  中身がわからないものを登録すると、知らないプログラムが裏で動き続けることになります。
  入れる前に中の `ProgramArguments` を見て、何を動かすのか確認するクセをつけよう
- **消し方(ステップ 5)を先に覚えてから遊ぶ。** 何かおかしくなっても、
  `bootout` してファイルを消せば必ず元に戻せます
- **短い間隔でくり返す設定は慎重に。** 「1 秒ごとに」みたいなお願いは Mac に負担をかけます
  (執事も 10 秒より短い連続実行は断ってきます)

## 7. AI に仕事をたのむこともできる

この 3 つの記事の後半では、`say` の代わりに **Claude Code という AI** を
執事に動かしてもらう方法を説明しています。たとえば「毎朝 9 時に、AI がプロジェクトの
レポートを書いておいてくれる」みたいなことができます。

ただし、これは少しだけ大人向けの話です。

- **お金がかかる**(Claude の有料プラン、月 $20〜が必要。無料では使えない)
- **AI が勝手に動くぶん、やっていいことを厳しく制限する必要がある**
  (人間が見ていない間に動くので、「読むだけ」「このフォルダだけ」のように権限を絞る)

くわしくは [guide.md](guide.md) の 7 章に書いてあります。

## 8. 次に読むもの

| 読むもの | どんなとき |
|---|---|
| [intro.md](intro.md) | 今日やったことを、もう少しだけ専門用語で復習したいとき |
| [guide.md](guide.md) | しくみを深く知りたい・AI の自動実行をやってみたいとき |
| [reference.md](reference.md) | 「こういう設定はできる?」を全部調べたいとき(辞書として) |

まずは今日作った「おしゃべり Mac」のセリフと時間を、自分の生活に合わせて
変えてみるところから始めてみてください。
