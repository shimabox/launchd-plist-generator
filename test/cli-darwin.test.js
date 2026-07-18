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

if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
