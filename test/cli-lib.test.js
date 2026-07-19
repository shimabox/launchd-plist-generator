/*
 * bin/launchd-plist の環境非依存ロジックのテスト。実行方法は `node test/cli-lib.test.js`。
 * plutil/launchctl を実際には呼び出さない (fs/child_process の呼び出し結果を模した
 * データを直接渡す) ため、ubuntu の CI 上でも実行できる。
 * 失敗があると非ゼロで終了する。
 */

const assert = require('assert');

const {
  parseArgv,
  usageText,
  githubSlug,
  resolveGuideLink,
  buildEntries,
  computeExitCode,
  formatHuman,
  formatJson,
  shellQuote,
  checkProgramArgumentsTypes,
  diagnoseExecutable,
  diagnoseDirectory,
  diagnosePlistLocation,
  isLaunchDaemonPath,
  diagnoseReadPermission,
  diagnoseRegistration,
  parseLaunchctlPrint,
} = require('../bin/launchd-plist');

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

/* ---------- parseArgv ---------- */

test('parseArgv: サブコマンド・ファイル・オプションを分離する', () => {
  const r = parseArgv(['check', 'a.plist', '--json', '--strict']);
  assert.strictEqual(r.command, 'check');
  assert.strictEqual(r.file, 'a.plist');
  assert.strictEqual(r.json, true);
  assert.strictEqual(r.strict, true);
  assert.strictEqual(r.help, false);
});

test('parseArgv: 引数なしは command が null', () => {
  const r = parseArgv([]);
  assert.strictEqual(r.command, null);
  assert.strictEqual(r.file, null);
});

test('parseArgv: --help はどこにあっても検出される', () => {
  const r = parseArgv(['doctor', '--help', 'a.plist']);
  assert.strictEqual(r.help, true);
  assert.strictEqual(r.command, 'doctor');
  assert.strictEqual(r.file, 'a.plist');
});

test('parseArgv: -h も --help と同じ扱い', () => {
  assert.strictEqual(parseArgv(['-h']).help, true);
});

test('parseArgv: 不明なオプション (タイプミス等) は unknown に入る', () => {
  const r = parseArgv(['check', 'a.plist', '--strcit']);
  assert.strictEqual(r.file, 'a.plist');
  assert.deepStrictEqual(r.unknown, ['--strcit']);
  assert.deepStrictEqual(r.extra, []);
});

test('parseArgv: 余分な位置引数は extra に入る', () => {
  const r = parseArgv(['check', 'a.plist', 'b.plist']);
  assert.strictEqual(r.file, 'a.plist');
  assert.deepStrictEqual(r.extra, ['b.plist']);
  assert.deepStrictEqual(r.unknown, []);
});

test('usageText: サブコマンドとオプションの説明を含む', () => {
  const u = usageText();
  assert.ok(u.includes('check'));
  assert.ok(u.includes('doctor'));
  assert.ok(u.includes('--json'));
  assert.ok(u.includes('--strict'));
});

/* ---------- githubSlug / resolveGuideLink ---------- */

test('githubSlug: リクエストの例と一致する (8.2 よくあるエラーと原因 → 82-よくあるエラーと原因)', () => {
  assert.strictEqual(githubSlug('8.2 よくあるエラーと原因'), '82-よくあるエラーと原因');
});

test('githubSlug: 4.1/4.2/4.3/8.1/8.3 の見出しも規則どおりにスラッグ化される', () => {
  assert.strictEqual(githubSlug('4.1 実行対象を指定するキー'), '41-実行対象を指定するキー');
  assert.strictEqual(githubSlug('4.2 起動トリガーを指定するキー'), '42-起動トリガーを指定するキー');
  assert.strictEqual(githubSlug('4.3 実行環境を指定するキー'), '43-実行環境を指定するキー');
  assert.strictEqual(githubSlug('8.1 まず見るもの'), '81-まず見るもの');
  assert.strictEqual(githubSlug('8.3 デバッグの定石'), '83-デバッグの定石');
});

test('resolveGuideLink: label/programArguments/workingDirectory は 4.1 へ', () => {
  for (const field of ['label', 'programArguments', 'workingDirectory']) {
    const link = resolveGuideLink({ level: 'error', message: 'x', field }, 'docs/guide.md');
    assert.strictEqual(link.section, '4.1');
    assert.strictEqual(link.url, 'docs/guide.md#41-実行対象を指定するキー');
  }
});

test('resolveGuideLink: trigger/calendar/startInterval/watchPaths/queueDirectories/keepAlive は 4.2 へ', () => {
  for (const field of ['trigger', 'calendar', 'startInterval', 'watchPaths', 'queueDirectories', 'keepAlive']) {
    assert.strictEqual(resolveGuideLink({ level: 'warn', message: 'x', field }).section, '4.2');
  }
});

test('resolveGuideLink: standardOutPath/standardErrorPath/environmentVariables/throttleInterval は 4.3 へ', () => {
  for (const field of ['standardOutPath', 'standardErrorPath', 'environmentVariables', 'throttleInterval']) {
    assert.strictEqual(resolveGuideLink({ level: 'info', message: 'x', field }).section, '4.3');
  }
});

test('resolveGuideLink: message に USERNAME を含むと field によらず 8.2 へ', () => {
  const link = resolveGuideLink({ level: 'warn', message: '/Users/USERNAME/ が残っています', field: 'workingDirectory' });
  assert.strictEqual(link.section, '8.2');
});

test('resolveGuideLink: message が exit code 127 に関連すると field によらず 8.2 へ', () => {
  const link = resolveGuideLink({ level: 'warn', message: '実行されるが即失敗 (exit 127 の可能性)', field: 'programArguments' });
  assert.strictEqual(link.section, '8.2');
});

test('resolveGuideLink: doctor のランタイム系 (runtimeExecutable/runtimeDirectory) は 8.2 へ', () => {
  assert.strictEqual(resolveGuideLink({ level: 'error', message: 'x', field: 'runtimeExecutable' }).section, '8.2');
  assert.strictEqual(resolveGuideLink({ level: 'error', message: 'x', field: 'runtimeDirectory' }).section, '8.2');
});

test('resolveGuideLink: doctor の登録状態・state 系 (registrationState/registrationPath) は 8.1 へ', () => {
  assert.strictEqual(resolveGuideLink({ level: 'warn', message: 'x', field: 'registrationState' }).section, '8.1');
  assert.strictEqual(resolveGuideLink({ level: 'warn', message: 'x', field: 'registrationPath' }).section, '8.1');
});

test('resolveGuideLink: どれにも当てはまらない doctor issue (plistLocation/plistPermission) は 8.3 へ', () => {
  assert.strictEqual(resolveGuideLink({ level: 'info', message: 'x', field: 'plistLocation' }).section, '8.3');
  assert.strictEqual(resolveGuideLink({ level: 'error', message: 'x', field: 'plistPermission' }).section, '8.3');
});

test('resolveGuideLink: ok/note レベルはリンクを返さない', () => {
  assert.strictEqual(resolveGuideLink({ level: 'ok', message: 'x', field: 'label' }), null);
  assert.strictEqual(resolveGuideLink({ level: 'note', message: 'x', field: null }), null);
});

test('resolveGuideLink: 未知の field はリンクを返さない', () => {
  assert.strictEqual(resolveGuideLink({ level: 'error', message: 'x', field: 'unknownField' }), null);
});

/* ---------- buildEntries / computeExitCode ---------- */

test('buildEntries: notes は level: note の要素として末尾に追加される', () => {
  const entries = buildEntries([{ level: 'error', message: 'e', field: 'label' }], ['参考メモ']);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[1].level, 'note');
  assert.strictEqual(entries[1].message, '参考メモ');
});

test('computeExitCode: エラーがあれば常に1', () => {
  const entries = [{ level: 'error', message: 'x' }, { level: 'ok', message: 'y' }];
  assert.strictEqual(computeExitCode(entries, false), 1);
  assert.strictEqual(computeExitCode(entries, true), 1);
});

test('computeExitCode: 警告のみは strict なしで0、strict ありで1', () => {
  const entries = [{ level: 'warn', message: 'x' }];
  assert.strictEqual(computeExitCode(entries, false), 0);
  assert.strictEqual(computeExitCode(entries, true), 1);
});

test('computeExitCode: 問題なしは常に0', () => {
  const entries = [{ level: 'ok', message: 'x' }, { level: 'note', message: 'y' }];
  assert.strictEqual(computeExitCode(entries, false), 0);
  assert.strictEqual(computeExitCode(entries, true), 0);
});

/* ---------- formatHuman / formatJson ---------- */

test('formatHuman: 問題がなければ ✓ の1行だけになる', () => {
  const out = formatHuman([], {});
  assert.strictEqual(out, '✓ 問題は見つかりませんでした。');
});

test('formatHuman: レベルごとに ✓/✕/⚠/ℹ の記号を使う', () => {
  const out = formatHuman(
    [
      { level: 'ok', message: 'ok-msg', field: null },
      { level: 'error', message: 'error-msg', field: 'label' },
      { level: 'warn', message: 'warn-msg', field: 'trigger' },
      { level: 'info', message: 'info-msg', field: 'standardErrorPath' },
    ],
    { guidePath: 'docs/guide.md' }
  );
  assert.ok(out.includes('✓ ok-msg'));
  assert.ok(out.includes('✕ error-msg'));
  assert.ok(out.includes('⚠ warn-msg'));
  assert.ok(out.includes('ℹ info-msg'));
  assert.ok(out.includes('docs/guide.md#41-実行対象を指定するキー'));
});

test('formatHuman: note は [参考] セクションにまとめられる', () => {
  const out = formatHuman([{ level: 'note', message: 'これは参考情報' }], {});
  assert.ok(out.includes('[参考]'));
  assert.ok(out.includes('これは参考情報'));
});

test('formatJson: JSON 配列としてパースできる', () => {
  const entries = [{ level: 'error', message: 'x', field: 'label' }];
  const parsed = JSON.parse(formatJson(entries));
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed[0].message, 'x');
});

/* ---------- doctor の判定ロジック (I/O 結果を模したデータを渡す) ---------- */

test('diagnoseExecutable: argv0 が空なら null (スキップ)', () => {
  assert.strictEqual(diagnoseExecutable('', null), null);
});

test('diagnoseExecutable: 絶対パスでなければ info でスキップする', () => {
  const r = diagnoseExecutable('echo', null);
  assert.strictEqual(r.level, 'info');
  assert.strictEqual(r.field, 'runtimeExecutable');
});

test('diagnoseExecutable: 存在しなければ error', () => {
  const r = diagnoseExecutable('/bin/notfound', { exists: false });
  assert.strictEqual(r.level, 'error');
});

test('diagnoseExecutable: ファイルでなければ error', () => {
  const r = diagnoseExecutable('/bin', { exists: true, isFile: false });
  assert.strictEqual(r.level, 'error');
});

test('diagnoseExecutable: 実行権限がなければ error', () => {
  const r = diagnoseExecutable('/bin/x', { exists: true, isFile: true, executable: false });
  assert.strictEqual(r.level, 'error');
});

test('diagnoseExecutable: 存在・ファイル・実行権限すべて満たせば ok', () => {
  const r = diagnoseExecutable('/bin/x', { exists: true, isFile: true, executable: true });
  assert.strictEqual(r.level, 'ok');
});

test('diagnoseDirectory: 空パスなら null', () => {
  assert.strictEqual(diagnoseDirectory('L', '', null), null);
});

test('diagnoseDirectory: 存在しなければ error、存在してディレクトリなら ok', () => {
  assert.strictEqual(diagnoseDirectory('L', '/tmp/x', { exists: false }).level, 'error');
  assert.strictEqual(diagnoseDirectory('L', '/tmp/x', { exists: true, isDirectory: false }).level, 'error');
  assert.strictEqual(diagnoseDirectory('L', '/tmp/x', { exists: true, isDirectory: true }).level, 'ok');
});

test('diagnosePlistLocation: 標準ディレクトリなら ok', () => {
  const r = diagnosePlistLocation('/Users/u/Library/LaunchAgents/com.example.job.plist', '/Users/u');
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.field, 'plistLocation');
});

test('diagnosePlistLocation: 標準外なら info', () => {
  const r = diagnosePlistLocation('/tmp/com.example.job.plist', '/Users/u');
  assert.strictEqual(r.level, 'info');
});

test('isLaunchDaemonPath: /Library/LaunchDaemons, /System/Library/LaunchDaemons 配下は true', () => {
  assert.strictEqual(isLaunchDaemonPath('/Library/LaunchDaemons/com.example.job.plist'), true);
  assert.strictEqual(isLaunchDaemonPath('/System/Library/LaunchDaemons/com.apple.foo.plist'), true);
});

test('isLaunchDaemonPath: LaunchAgents (per-user/system問わず) や標準外ディレクトリは false', () => {
  assert.strictEqual(isLaunchDaemonPath('/Users/u/Library/LaunchAgents/com.example.job.plist'), false);
  assert.strictEqual(isLaunchDaemonPath('/Library/LaunchAgents/com.example.job.plist'), false);
  assert.strictEqual(isLaunchDaemonPath('/System/Library/LaunchAgents/com.apple.foo.plist'), false);
  assert.strictEqual(isLaunchDaemonPath('/tmp/com.example.job.plist'), false);
});

test('isLaunchDaemonPath: 空/未指定は false', () => {
  assert.strictEqual(isLaunchDaemonPath(''), false);
  assert.strictEqual(isLaunchDaemonPath(null), false);
});

test('diagnoseReadPermission: 読み取り不可なら error、可能なら ok', () => {
  assert.strictEqual(diagnoseReadPermission('/tmp/x.plist', { readable: false }).level, 'error');
  assert.strictEqual(diagnoseReadPermission('/tmp/x.plist', { readable: true }).level, 'ok');
});

test('parseLaunchctlPrint: path/state/last exit code を抽出する', () => {
  const raw = [
    'gui/501/com.apple.Dock = {',
    '\tactive count = 0',
    '\tpath = /System/Library/LaunchAgents/com.apple.Dock.plist',
    '\ttype = LaunchAgent',
    '\tstate = running',
    '',
    '\truns = 3',
    '\tlast exit code = (never exited)',
    '}',
  ].join('\n');
  const r = parseLaunchctlPrint(raw);
  assert.strictEqual(r.path, '/System/Library/LaunchAgents/com.apple.Dock.plist');
  assert.strictEqual(r.state, 'running');
  assert.strictEqual(r.lastExitCode, '(never exited)');
});

test('parseLaunchctlPrint: 数値の last exit code も抽出する', () => {
  const raw = '\tpath = /a/b.plist\n\tstate = not running\n\tlast exit code = 127\n';
  const r = parseLaunchctlPrint(raw);
  assert.strictEqual(r.lastExitCode, '127');
});

test('parseLaunchctlPrint: 空文字・該当行なしは null', () => {
  assert.strictEqual(parseLaunchctlPrint(''), null);
  assert.strictEqual(parseLaunchctlPrint('unrelated output'), null);
});

test('diagnoseRegistration: label が未設定なら info を返しスキップする', () => {
  const r = diagnoseRegistration({ label: '', uid: 501, plistPath: 'a.plist', plistRealPath: '/a.plist', printResult: null });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].level, 'info');
  assert.strictEqual(r.notes.length, 0);
});

test('diagnoseRegistration: 取得失敗 (printResult.ok=false) は info で静かに degrade する', () => {
  const r = diagnoseRegistration({
    label: 'com.example.job',
    uid: 501,
    plistPath: 'a.plist',
    plistRealPath: '/a.plist',
    printResult: { ok: false },
  });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].level, 'info');
  assert.ok(r.issues[0].message.includes('取得できませんでした'));
});

test('diagnoseRegistration: 未登録は ok', () => {
  const r = diagnoseRegistration({
    label: 'com.example.job',
    uid: 501,
    plistPath: 'a.plist',
    plistRealPath: '/a.plist',
    printResult: { ok: true, registered: false, raw: '' },
  });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].level, 'ok');
  assert.ok(r.issues[0].message.includes('登録されていません'));
});

test('diagnoseRegistration: isLaunchDaemon=true は printResult に関わらず「未登録」と断定せず info を返す', () => {
  // クロスレビューで指摘されたバグの回帰テスト: LaunchDaemon 用ディレクトリの plist は
  // gui ドメインへの照会結果 (printResult.registered=false) があっても「未登録」と断定してはならない。
  const r = diagnoseRegistration({
    label: 'com.example.daemon',
    uid: 501,
    plistPath: '/Library/LaunchDaemons/com.example.daemon.plist',
    plistRealPath: '/Library/LaunchDaemons/com.example.daemon.plist',
    printResult: { ok: true, registered: false, raw: '' },
    isLaunchDaemon: true,
  });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].level, 'info');
  assert.ok(!r.issues[0].message.includes('未登録'));
  assert.ok(r.issues[0].message.includes('per-user の LaunchAgent (gui ドメイン) のみに対応しています'));
  assert.ok(r.issues[0].message.includes("launchctl print 'system/com.example.daemon'"));
  assert.strictEqual(r.notes.length, 0);
});

test('diagnoseRegistration: isLaunchDaemon=true は printResult が null でも info を返す (launchctl print を呼ばない前提)', () => {
  const r = diagnoseRegistration({
    label: 'com.example.daemon',
    uid: 501,
    plistPath: '/System/Library/LaunchDaemons/com.example.daemon.plist',
    plistRealPath: '/System/Library/LaunchDaemons/com.example.daemon.plist',
    printResult: null,
    isLaunchDaemon: true,
  });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].level, 'info');
  assert.strictEqual(r.issues[0].field, 'registrationState');
});

test('diagnoseRegistration: 登録済み・パス一致・exit code 0 は ok のみ、bootout/bootstrap は notes に入る', () => {
  const raw = '\tpath = /a/real.plist\n\tstate = running\n\tlast exit code = 0\n';
  const r = diagnoseRegistration({
    label: 'com.example.job',
    uid: 501,
    plistPath: '/a/real.plist',
    plistRealPath: '/a/real.plist',
    printResult: { ok: true, registered: true, raw },
  });
  assert.ok(r.issues.some((i) => i.level === 'ok' && i.message.includes('登録済み')));
  assert.ok(!r.issues.some((i) => i.level === 'warn'));
  assert.strictEqual(r.notes.length, 1);
  assert.ok(r.notes[0].includes("launchctl bootout 'gui/501/com.example.job'"));
  assert.ok(r.notes[0].includes("launchctl bootstrap gui/501 '/a/real.plist'"));
});

test('diagnoseRegistration: パス不一致は warn (registrationPath)', () => {
  const raw = '\tpath = /a/registered.plist\n\tstate = running\n\tlast exit code = 0\n';
  const r = diagnoseRegistration({
    label: 'com.example.job',
    uid: 501,
    plistPath: '/b/other.plist',
    plistRealPath: '/b/other.plist',
    printResult: { ok: true, registered: true, raw },
  });
  const warn = r.issues.find((i) => i.field === 'registrationPath');
  assert.ok(warn);
  assert.strictEqual(warn.level, 'warn');
});

test('diagnoseRegistration: 最終終了コードが非0は warn、127 なら exit 127 の案内を含む', () => {
  const raw = '\tpath = /a/real.plist\n\tstate = not running\n\tlast exit code = 127\n';
  const r = diagnoseRegistration({
    label: 'com.example.job',
    uid: 501,
    plistPath: '/a/real.plist',
    plistRealPath: '/a/real.plist',
    printResult: { ok: true, registered: true, raw },
  });
  const warn = r.issues.find((i) => i.field === 'registrationState' && i.level === 'warn');
  assert.ok(warn);
  assert.ok(warn.message.includes('127'));
  const link = resolveGuideLink(warn, 'docs/guide.md');
  // exit 127 を含むメッセージは field によらず 8.2 へ誘導される
  assert.strictEqual(link.section, '8.2');
});

test('diagnoseRegistration: 出力のパースに失敗しても静かに degrade する', () => {
  const r = diagnoseRegistration({
    label: 'com.example.job',
    uid: 501,
    plistPath: '/a/real.plist',
    plistRealPath: '/a/real.plist',
    printResult: { ok: true, registered: true, raw: 'まったく解析できない出力' },
  });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].level, 'info');
});

/* ---------- shellQuote ---------- */

test('shellQuote: 空白を含む値は1つの引数としてクォートされる', () => {
  assert.strictEqual(shellQuote('/a b/c.plist'), "'/a b/c.plist'");
});

test('shellQuote: シングルクォートを含む値は安全にエスケープされる', () => {
  const quoted = shellQuote(`it's here`);
  assert.strictEqual(quoted, `'it'\\''s here'`);
});

test('shellQuote: コマンド置換記号を含む値も文字列としてそのまま扱われる', () => {
  const quoted = shellQuote('$(rm -rf /)');
  assert.strictEqual(quoted, "'$(rm -rf /)'");
});

/* ---------- checkProgramArgumentsTypes ---------- */

test('checkProgramArgumentsTypes: 文字列以外の要素があれば error', () => {
  const issues = checkProgramArgumentsTypes({ ProgramArguments: ['/bin/echo', 42, true] });
  assert.strictEqual(issues.length, 2);
  assert.ok(issues.every((i) => i.level === 'error' && i.field === 'programArguments'));
  assert.ok(issues[0].message.includes('1 番目'));
  assert.ok(issues[1].message.includes('2 番目'));
});

test('checkProgramArgumentsTypes: すべて文字列なら空配列', () => {
  assert.deepStrictEqual(checkProgramArgumentsTypes({ ProgramArguments: ['/bin/echo', 'hi'] }), []);
});

test('checkProgramArgumentsTypes: ProgramArguments がなければ空配列', () => {
  assert.deepStrictEqual(checkProgramArgumentsTypes({}), []);
});

if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
