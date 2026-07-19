/*
 * bin/launchd-plist の darwin 限定の統合テスト。実行方法は `node test/cli-darwin.test.js`。
 * 実際に plutil / launchctl を子プロセスとして呼び出すため、各テストの先頭で
 * `if (process.platform !== 'darwin') return;` によりガードする (macOS 以外では
 * 何もせず成功扱いになる。test/generator.test.js の darwin 限定テストと同じ形式)。
 * 失敗があると非ゼロで終了する。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'launchd-plist');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok      ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAILED  ${name}`);
    console.error('        ' + e.message.split('\n')[0]);
  }
}

function writeTmpPlist(content) {
  const tmp = path.join(os.tmpdir(), `cli-darwin-test-${process.pid}-${Math.random().toString(36).slice(2)}.plist`);
  fs.writeFileSync(tmp, content);
  return tmp;
}

const GOOD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.clitest</string>
  <key>ProgramArguments</key>
  <array><string>/bin/echo</string><string>hello</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardErrorPath</key><string>__ERR_LOG__</string>
</dict>
</plist>
`;

const BAD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array><string>echo</string></array>
</dict>
</plist>
`;

const WARN_ONLY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.warnonly</string>
  <key>ProgramArguments</key>
  <array><string>/bin/echo</string><string>hi</string></array>
</dict>
</plist>
`;

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('check: 正常な plist は exit 0 で ✓ のみを出力する', () => {
  if (process.platform !== 'darwin') return;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-darwin-log-'));
  const plist = writeTmpPlist(GOOD_PLIST.replace('__ERR_LOG__', path.join(logDir, 'err.log')));
  try {
    const r = runCli(['check', plist]);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('✓'));
    assert.ok(!r.stdout.includes('✕'));
    assert.ok(!r.stdout.includes('⚠'));
  } finally {
    fs.unlinkSync(plist);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('check: Label 欠落等の不正な plist は exit 1 で guide.md リンク付きエラーを出力する', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(BAD_PLIST);
  try {
    const r = runCli(['check', plist]);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stdout.includes('✕'));
    assert.ok(r.stdout.includes('docs/guide.md#'));
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check --json: issue が JSON 配列として出力される', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(BAD_PLIST);
  try {
    const r = runCli(['check', plist, '--json']);
    assert.strictEqual(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.some((i) => i.level === 'error'));
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check --strict: 警告のみでも exit 1 になる (strict なしでは exit 0)', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(WARN_ONLY_PLIST);
  try {
    const normal = runCli(['check', plist]);
    assert.strictEqual(normal.status, 0);
    assert.ok(!normal.stdout.includes('✕'));
    assert.ok(normal.stdout.includes('⚠'));

    const strict = runCli(['check', plist, '--strict']);
    assert.strictEqual(strict.status, 1);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('doctor: 未登録の plist は実行ファイル・ディレクトリ・未登録状態を診断する', () => {
  if (process.platform !== 'darwin') return;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-darwin-log-'));
  const plist = writeTmpPlist(GOOD_PLIST.replace('__ERR_LOG__', path.join(logDir, 'err.log')));
  try {
    const r = runCli(['doctor', plist]);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('実行ファイル'));
    assert.ok(r.stdout.includes('登録されていません'));
    assert.ok(r.stdout.includes('読み取り可能'));
  } finally {
    fs.unlinkSync(plist);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('doctor: 登録済みの LaunchAgent は登録状態と bootout/bootstrap コマンド例を出力する', () => {
  if (process.platform !== 'darwin') return;
  // 環境依存の既存システム plist に頼らず、テストが自分で使い捨ての LaunchAgent を
  // gui ドメインに登録して確実に「登録済みケース」を検証する。
  // CLI 本体 (bin/launchd-plist) は bootstrap/bootout を一切実行しない (読み取り専用のまま)。
  const uid = process.getuid();
  const label = `com.example.clitest-doctor-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const plist = path.join(agentsDir, `${label}.plist`);
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/true</string></array>
</dict>
</plist>
`
  );

  let bootstrapped = false;
  try {
    const bootstrap = spawnSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
    assert.strictEqual(bootstrap.status, 0, bootstrap.stderr);
    bootstrapped = true;

    const r = runCli(['doctor', plist]);
    assert.ok(r.stdout.includes(label + ' は登録済みです'), r.stdout);
    assert.ok(r.stdout.includes('launchctl bootout'));
    assert.ok(r.stdout.includes('launchctl bootstrap'));
  } finally {
    if (bootstrapped) {
      spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    }
    fs.unlinkSync(plist);
  }
});

test('doctor: LaunchDaemon 配下の plist は「未登録」と断定せず gui ドメイン非対応を案内する (参考)', () => {
  if (process.platform !== 'darwin') return;
  // 実システムの LaunchDaemon を読み取り専用で診断するだけの参考テスト。
  // 個別のファイル名はOSバージョンによって存在しないことがあるため、
  // /System/Library/LaunchDaemons 配下から読み取り可能な plist を1つ動的に選ぶ。
  const daemonsDir = '/System/Library/LaunchDaemons';
  if (!fs.existsSync(daemonsDir)) return;
  const candidate = fs
    .readdirSync(daemonsDir)
    .find((f) => f.endsWith('.plist') && (() => {
      try {
        fs.accessSync(path.join(daemonsDir, f), fs.constants.R_OK);
        return true;
      } catch {
        return false;
      }
    })());
  if (!candidate) return;
  const daemonPlist = path.join(daemonsDir, candidate);

  const r = runCli(['doctor', daemonPlist]);
  // 「登録されていません (未登録)」という誤った断定をしていないことを確認する。
  assert.ok(!r.stdout.includes('登録されていません'), r.stdout);
  assert.ok(r.stdout.includes('per-user の LaunchAgent (gui ドメイン) のみに対応しています'), r.stdout);
});

test('doctor: 実行ファイルが存在しない plist はエラーとして報告される', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.missingexec</string>
  <key>ProgramArguments</key>
  <array><string>/no/such/executable-${process.pid}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`);
  try {
    const r = runCli(['doctor', plist]);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stdout.includes('見つかりません'));
    assert.ok(r.stdout.includes('docs/guide.md#82-'));
  } finally {
    fs.unlinkSync(plist);
  }
});

test('doctor: 読み取り権限のない plist は生の plutil エラーではなく guide.md リンク付きメッセージを出力する', () => {
  if (process.platform !== 'darwin') return;
  // root で実行されていると chmod 000 でも読み取れてしまい検証にならないためスキップする。
  if (process.getuid && process.getuid() === 0) return;
  const plist = writeTmpPlist(GOOD_PLIST.replace('__ERR_LOG__', '/tmp/does-not-matter.log'));
  try {
    fs.chmodSync(plist, 0o000);
    const r = runCli(['doctor', plist]);
    assert.strictEqual(r.status, 1);
    // 生の plutil エラー ("couldn't be opened because you don't have permission" 等) や
    // トップレベル catch のメッセージ ("エラー: plist を読み込めませんでした (plutil)") が
    // 出力されず、diagnoseReadPermission() の整形メッセージだけが出力されることを確認する。
    assert.ok(!r.stderr.includes('エラー: plist を読み込めませんでした'), r.stderr);
    assert.ok(r.stdout.includes(`「${plist}」の読み取り権限がありません。`), r.stdout);
    assert.ok(r.stdout.includes('docs/guide.md#83-'), r.stdout);
  } finally {
    fs.chmodSync(plist, 0o644);
    fs.unlinkSync(plist);
  }
});

test('check: バイナリ plist も読み込める', () => {
  if (process.platform !== 'darwin') return;
  const xmlPlist = writeTmpPlist(GOOD_PLIST.replace('__ERR_LOG__', '/tmp/does-not-matter.log'));
  const binPlist = xmlPlist + '.bin';
  try {
    const conv = spawnSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', binPlist, xmlPlist], { encoding: 'utf8' });
    assert.strictEqual(conv.status, 0, conv.stderr);
    const r = runCli(['check', binPlist]);
    assert.strictEqual(r.status, 0);
  } finally {
    fs.unlinkSync(xmlPlist);
    if (fs.existsSync(binPlist)) fs.unlinkSync(binPlist);
  }
});

test('--help はサブコマンドなしでも exit 0 で使い方を表示する', () => {
  if (process.platform !== 'darwin') return;
  const r = runCli(['--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('check'));
  assert.ok(r.stdout.includes('doctor'));
});

test('引数なしは exit 1 で使い方を stderr に表示する', () => {
  if (process.platform !== 'darwin') return;
  const r = runCli([]);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('使い方'));
});

test('存在しないファイルはエラーメッセージ付きで exit 1 になる', () => {
  if (process.platform !== 'darwin') return;
  const r = runCli(['check', '/tmp/definitely-does-not-exist-' + process.pid + '.plist']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('エラー'));
});

test('check --json: 存在しないファイルでも stdout は解析可能な JSON 配列になる', () => {
  if (process.platform !== 'darwin') return;
  const r = runCli(['check', '/tmp/definitely-does-not-exist-' + process.pid + '.plist', '--json']);
  assert.strictEqual(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some((i) => i.level === 'error'));
});

test('不明なオプション (タイプミス) は usage エラーになり黙って無視されない', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(WARN_ONLY_PLIST);
  try {
    const r = runCli(['check', plist, '--strcit']);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stderr.includes('不明なオプション'));
  } finally {
    fs.unlinkSync(plist);
  }
});

test('余分な位置引数は usage エラーになる', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(WARN_ONLY_PLIST);
  try {
    const r = runCli(['check', plist, 'extra-arg']);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stderr.includes('余分な引数'));
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check: Program と ProgramArguments (argv[0] が相対) の併用はクラッシュせず、絶対パス警告も出ない', () => {
  if (process.platform !== 'darwin') return;
  // com.apple.SafeEjectGPUAgent.plist を模した構成 (Program は絶対パス、
  // ProgramArguments[0] は Program と異なる相対名)。ProgramArguments[0] を実行ファイルと
  // 誤認すると「絶対パスで書くことを推奨」という的外れな警告が出てしまう。
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.programandargs</string>
  <key>Program</key><string>/bin/echo</string>
  <key>ProgramArguments</key>
  <array><string>echo</string><string>hi</string></array>
</dict>
</plist>
`);
  try {
    const r = runCli(['check', plist]);
    // 生の「読み込めませんでした」例外ではなく、通常どおり ✓/⚠ 系の結果が出ること
    assert.ok(!r.stderr.includes('エラー:'), r.stderr);
    assert.ok(r.stdout.includes('Program'), r.stdout);
    // ProgramArguments[0] ("echo", 相対) を実行ファイルとみなした誤った警告が出ないこと。
    // このケースにはトリガーが無いため「起動トリガーがない」警告自体は正しく残る。
    assert.ok(!r.stdout.includes('は絶対パスで書くことを強く推奨します'), r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check: Program のみ (ProgramArguments が空配列) は「実行コマンド未指定」エラーにならない', () => {
  if (process.platform !== 'darwin') return;
  // com.apple.IOUIAgent.plist を模した構成。
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.programonly</string>
  <key>Program</key><string>/bin/echo</string>
  <key>ProgramArguments</key>
  <array/>
</dict>
</plist>
`);
  try {
    const r = runCli(['check', plist]);
    assert.strictEqual(r.status, 0, r.stdout);
    assert.ok(!r.stdout.includes('実行するコマンド'), r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('doctor: Program がある構成では argv[0] ではなく Program の存在を確認する', () => {
  if (process.platform !== 'darwin') return;
  // Program は存在しない絶対パス、ProgramArguments[0] は存在する相対コマンド名。
  // argv[0] だけを見ていると「絶対パスでないため存在確認をスキップ」して
  // 本来検出すべき「実行ファイルが見つからない」エラーを見逃してしまう。
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.missingprogram</string>
  <key>Program</key><string>/no/such/executable-${process.pid}</string>
  <key>ProgramArguments</key>
  <array><string>relative-name</string></array>
</dict>
</plist>
`);
  try {
    const r = runCli(['doctor', plist]);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.ok(r.stdout.includes('見つかりません'), r.stdout);
    assert.ok(r.stdout.includes(`/no/such/executable-${process.pid}`), r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check: ProgramArguments に文字列以外の要素があれば error になる', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.badargtype</string>
  <key>ProgramArguments</key>
  <array><string>/bin/echo</string><integer>1</integer></array>
</dict>
</plist>
`);
  try {
    const r = runCli(['check', plist]);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stdout.includes('文字列ではありません'), r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check: Sockets 起動のみの plist は「トリガーがない」と誤警告しない', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.socketjob</string>
  <key>ProgramArguments</key>
  <array><string>/bin/echo</string></array>
  <key>Sockets</key>
  <dict>
    <key>Listener</key>
    <dict>
      <key>SockServiceName</key><string>http</string>
    </dict>
  </dict>
</dict>
</plist>
`);
  try {
    const r = runCli(['check', plist, '--strict']);
    assert.ok(!r.stdout.includes('起動トリガーがひとつもありません'), r.stdout);
    assert.ok(r.stdout.includes('Sockets'), r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check: LaunchEvents 起動のみの plist も「トリガーがない」と誤警告しない', () => {
  if (process.platform !== 'darwin') return;
  // com.apple.IOUIAgent.plist / com.apple.SafeEjectGPUAgent.plist を模した構成。
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.eventjob</string>
  <key>ProgramArguments</key>
  <array><string>/bin/echo</string></array>
  <key>LaunchEvents</key>
  <dict>
    <key>com.apple.notifyd.matching</key>
    <dict>
      <key>SomeEvent</key>
      <dict>
        <key>Notification</key><string>com.example.something</string>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
`);
  try {
    const r = runCli(['check', plist, '--strict']);
    assert.ok(!r.stdout.includes('起動トリガーがひとつもありません'), r.stdout);
    assert.ok(r.stdout.includes('LaunchEvents'), r.stdout);
    assert.strictEqual(r.status, 0, r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

test('check: SuccessfulExit 以外の条件を使う KeepAlive のみの plist も「トリガーがない」と誤警告しない', () => {
  if (process.platform !== 'darwin') return;
  const plist = writeTmpPlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.networkjob</string>
  <key>ProgramArguments</key>
  <array><string>/bin/echo</string></array>
  <key>KeepAlive</key>
  <dict>
    <key>NetworkState</key><true/>
  </dict>
</dict>
</plist>
`);
  try {
    const r = runCli(['check', plist, '--strict']);
    assert.ok(!r.stdout.includes('起動トリガーがひとつもありません'), r.stdout);
    assert.ok(r.stdout.includes('KeepAlive'), r.stdout);
    assert.strictEqual(r.status, 0, r.stdout);
  } finally {
    fs.unlinkSync(plist);
  }
});

if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
