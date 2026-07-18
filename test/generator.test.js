/*
 * generator.js のテスト。実行方法は `node test/generator.test.js`。
 * 失敗があると非ゼロで終了する。macOS では生成 XML を plutil -lint にも通す。
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generatePlist, plistDictToConfig } = require('../generator.js');

const base = {
  label: 'com.example.test',
  programArguments: ['/usr/bin/say', 'hello'],
  workingDirectory: '',
  environmentVariables: {},
  standardOutPath: '/Users/u/Library/Logs/t.log',
  standardErrorPath: '/Users/u/Library/Logs/t.err.log',
  runAtLoad: false,
  startInterval: null,
  calendarIntervals: [{ Hour: 9, Minute: 0 }],
  watchPaths: [],
  queueDirectories: [],
  keepAlive: 'off',
  processType: '',
  throttleInterval: null,
};

const errorsOf = (r) => r.issues.filter((i) => i.level === 'error');
const warnsOf = (r) => r.issues.filter((i) => i.level === 'warn');

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

test('正常系はエラーなしで主要キーを含む XML を生成する', () => {
  const r = generatePlist(base);
  assert.strictEqual(errorsOf(r).length, 0);
  assert.strictEqual(warnsOf(r).length, 0);
  assert.ok(r.xml.includes('<key>Label</key>'));
  assert.ok(r.xml.includes('<string>com.example.test</string>'));
  assert.ok(r.xml.includes('<key>StartCalendarInterval</key>'));
  assert.strictEqual(r.filename, 'com.example.test.plist');
});

test('正常系の XML は plutil -lint を通過する (macOS のみ)', () => {
  if (process.platform !== 'darwin') return;
  const r = generatePlist(base);
  const tmp = path.join(os.tmpdir(), `gen-test-${process.pid}.plist`);
  fs.writeFileSync(tmp, r.xml);
  try {
    execFileSync('/usr/bin/plutil', ['-lint', tmp], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('コマンドインジェクション可能な Label はエラーになり、コマンド側でもクォートされる', () => {
  const r = generatePlist({ ...base, label: 'ok$(id)' });
  assert.ok(errorsOf(r).some((i) => i.message.includes('Label')));
  // コマンド内では必ずシングルクォートに包まれ、クォートの外に $(id) が露出しない
  assert.ok(r.commands.includes("'ok$(id)'"));
  const outsideQuotes = r.commands.replace(/'[^']*'/g, '');
  assert.ok(!outsideQuotes.includes('$(id)'));
  // ダウンロードファイル名にも危険な文字が残らない
  assert.ok(!/[$()]/.test(r.filename));
});

test('Label のシングルクォート自体もエスケープされる', () => {
  const r = generatePlist({ ...base, label: "a'b" });
  assert.ok(errorsOf(r).length > 0);
  assert.ok(r.commands.includes("'a'\\''b'"));
});

test('空の Label はエラー', () => {
  const r = generatePlist({ ...base, label: '' });
  assert.ok(errorsOf(r).some((i) => i.message.includes('必須')));
});

test('非整数の StartInterval はエラーになり XML に出力されない', () => {
  const r = generatePlist({ ...base, startInterval: 1.5 });
  assert.ok(errorsOf(r).some((i) => i.message.includes('StartInterval')));
  assert.ok(!r.xml.includes('1.5'));
  assert.ok(!r.xml.includes('<key>StartInterval</key>'));
});

test('範囲外のカレンダー値はエラー', () => {
  const r = generatePlist({ ...base, calendarIntervals: [{ Hour: 25 }] });
  assert.ok(errorsOf(r).some((i) => i.message.includes('Hour')));
});

test('不正な値を含むカレンダー行は行ごと XML から除外される', () => {
  // {Hour: 9.5, Minute: 0} が「毎時 0 分」へ意味変化してはいけない
  const r = generatePlist({ ...base, calendarIntervals: [{ Hour: 9.5, Minute: 0 }] });
  assert.ok(errorsOf(r).length > 0);
  assert.ok(!r.xml.includes('9.5'));
  assert.ok(!r.xml.includes('<key>StartCalendarInterval</key>'));
});

test('範囲外の値を含むカレンダー行も行ごと除外され、正常な行だけ残る', () => {
  const r = generatePlist({ ...base, calendarIntervals: [{ Hour: 25 }, { Hour: 9, Minute: 0 }] });
  assert.ok(errorsOf(r).length > 0);
  assert.ok(!r.xml.includes('<integer>25</integer>'));
  assert.ok(r.xml.includes('<integer>9</integer>'));
});

test('Day と Weekday の同時指定は OR の警告が出る', () => {
  const r = generatePlist({ ...base, calendarIntervals: [{ Day: 1, Weekday: 1 }] });
  assert.ok(warnsOf(r).some((i) => i.message.includes('OR')));
});

test('KeepAlive: on-failure だけでも「トリガーなし」警告は出ない', () => {
  const r = generatePlist({ ...base, calendarIntervals: [], keepAlive: 'on-failure' });
  assert.ok(!r.issues.some((i) => i.message.includes('トリガー')));
});

test('トリガーが本当にない場合は警告が出る', () => {
  const r = generatePlist({ ...base, calendarIntervals: [] });
  assert.ok(warnsOf(r).some((i) => i.message.includes('トリガー')));
});

test('10 秒未満の StartInterval は警告', () => {
  const r = generatePlist({ ...base, startInterval: 5 });
  assert.ok(warnsOf(r).some((i) => i.message.includes('10 秒未満')));
});

test('引数の XML 特殊文字はエスケープされる', () => {
  const r = generatePlist({ ...base, programArguments: ['/usr/bin/say', 'a & b < c'] });
  assert.ok(r.xml.includes('a &amp; b &lt; c'));
  assert.ok(!r.xml.includes('a & b'));
});

test('相対パスのコマンドは警告', () => {
  const r = generatePlist({ ...base, programArguments: ['say', 'hello'] });
  assert.ok(warnsOf(r).some((i) => i.message.includes('絶対パス')));
});

test('~ を含む引数は警告', () => {
  const r = generatePlist({ ...base, programArguments: ['/bin/cat', '~/memo.txt'] });
  assert.ok(warnsOf(r).some((i) => i.message.includes('~')));
});

test('すべての検証結果に field が付く', () => {
  // 多数の問題を同時に発生させ、field 漏れがないことを確認する
  const r = generatePlist({
    label: '',
    programArguments: ['say', '~/x'],
    workingDirectory: 'rel',
    standardOutPath: 'rel',
    standardErrorPath: '',
    environmentVariables: { A: '$B' },
    runAtLoad: false,
    startInterval: 5,
    calendarIntervals: [{ Day: 1, Weekday: 1, Hour: 25 }],
    watchPaths: ['rel'],
    queueDirectories: ['rel'],
    keepAlive: 'always',
    processType: '',
    throttleInterval: -1,
  });
  assert.ok(r.issues.length >= 8);
  for (const i of r.issues) {
    assert.ok(i.field, `field がない: ${i.message}`);
  }
});

test('plist 読み込み: 対応キーがすべて config にマッピングされる', () => {
  const { config, notes } = plistDictToConfig({
    Label: 'com.example.job',
    ProgramArguments: ['/usr/bin/say', 'hello'],
    WorkingDirectory: '/Users/u/project',
    EnvironmentVariables: { PATH: '/usr/bin:/bin' },
    StandardOutPath: '/tmp/o.log',
    StandardErrorPath: '/tmp/e.log',
    RunAtLoad: true,
    StartCalendarInterval: [{ Hour: 9, Minute: 0 }, { Weekday: 5, Hour: 18 }],
    KeepAlive: { SuccessfulExit: false },
    ProcessType: 'Background',
    ThrottleInterval: 30,
  });
  assert.strictEqual(config.label, 'com.example.job');
  assert.deepStrictEqual(config.programArguments, ['/usr/bin/say', 'hello']);
  assert.deepStrictEqual(config.environmentVariables, { PATH: '/usr/bin:/bin' });
  assert.strictEqual(config.runAtLoad, true);
  assert.strictEqual(config.calendarIntervals.length, 2);
  assert.strictEqual(config.calendarIntervals[1].Weekday, 5);
  assert.strictEqual(config.keepAlive, 'on-failure');
  assert.strictEqual(config.processType, 'Background');
  assert.strictEqual(config.throttleInterval, 30);
  assert.strictEqual(notes.length, 0);
  // 読み込んだ config はそのまま再生成してもエラーにならない
  assert.strictEqual(generatePlist(config).issues.filter((i) => i.level === 'error').length, 0);
});

test('plist 読み込み: 対応外キーは喪失警告として報告される', () => {
  const { notes } = plistDictToConfig({
    Label: 'com.example.job',
    ProgramArguments: ['/bin/true'],
    Sockets: { Listener: { SockServiceName: '8080' } },
    UserName: 'daemonuser',
  });
  const lossNote = notes.find((n) => n.includes('対応外のキー'));
  assert.ok(lossNote);
  assert.ok(lossNote.includes('Sockets'));
  assert.ok(lossNote.includes('UserName'));
  assert.ok(lossNote.includes('失われます'));
});

test('plist 読み込み: Program のみの指定は argv として取り込む', () => {
  const { config } = plistDictToConfig({ Label: 'a.b', Program: '/usr/bin/true' });
  assert.deepStrictEqual(config.programArguments, ['/usr/bin/true']);
});

test('plist 読み込み: Program と ProgramArguments の併用は拒否する', () => {
  // 実行ファイル (/bin/echo) と argv[0] (custom-argv0) が異なる構成は表現できない
  assert.throws(
    () => plistDictToConfig({ Program: '/bin/echo', ProgramArguments: ['custom-argv0', 'hello'] }),
    /Program と ProgramArguments が両方/
  );
});

test('plist 読み込み: フォームで表現できない引数は喪失警告を出す', () => {
  const { notes } = plistDictToConfig({
    Label: 'a.b',
    ProgramArguments: ['/bin/echo', '', 'a\nb', ' padded '],
  });
  const note = notes.find((n) => n.includes('1 行 1 引数'));
  assert.ok(note);
  assert.ok(note.includes('""'));
  assert.ok(note.includes('a\\nb'));
  assert.ok(note.includes('" padded "'));
});

test('plist 読み込み: 引数以外でフォームで保持できない値も警告する', () => {
  const { notes } = plistDictToConfig({
    Label: 'a.b',
    ProgramArguments: ['/bin/true'],
    EnvironmentVariables: { A: 'first\nsecond', B: 'value  ' },
    WatchPaths: ['/tmp/path  '],
    QueueDirectories: [''],
    WorkingDirectory: ' /tmp/wd',
    StandardOutPath: '/tmp/o.log\n',
  });
  assert.ok(notes.some((n) => n.includes('EnvironmentVariables') && n.includes('first\\nsecond') && n.includes('value')));
  assert.ok(notes.some((n) => n.includes('WatchPaths') && n.includes('/tmp/path')));
  assert.ok(notes.some((n) => n.includes('QueueDirectories') && n.includes('""')));
  assert.ok(notes.some((n) => n.includes('WorkingDirectory')));
  assert.ok(notes.some((n) => n.includes('StandardOutPath')));
});

test('plist 読み込み: 前後に空白のある Label と空の環境変数名も警告する', () => {
  const { notes } = plistDictToConfig({
    Label: ' padded.label ',
    ProgramArguments: ['/bin/true'],
    EnvironmentVariables: { '': 'x' },
  });
  assert.ok(notes.some((n) => n.includes('Label') && n.includes('padded.label')));
  assert.ok(notes.some((n) => n.includes('EnvironmentVariables') && n.includes('=x')));
});

test('plist 読み込み: 正常な値では喪失警告が出ない (再確認)', () => {
  const { notes } = plistDictToConfig({
    Label: 'a.b',
    ProgramArguments: ['/bin/true'],
    EnvironmentVariables: { PATH: '/usr/bin:/bin' },
    WatchPaths: ['/tmp/inbox'],
    WorkingDirectory: '/tmp/wd',
  });
  assert.strictEqual(notes.length, 0);
});

test('plist 読み込み: KeepAlive のバリエーション', () => {
  assert.strictEqual(plistDictToConfig({ KeepAlive: true }).config.keepAlive, 'always');
  assert.strictEqual(plistDictToConfig({ KeepAlive: false }).config.keepAlive, 'off');
  // 扱えない条件は off のまま警告
  const complex = plistDictToConfig({ KeepAlive: { PathState: { '/tmp/x': true } } });
  assert.strictEqual(complex.config.keepAlive, 'off');
  assert.ok(complex.notes.some((n) => n.includes('PathState')));
});

test('plist 読み込み: 単一 dict の StartCalendarInterval も配列として取り込む', () => {
  const { config } = plistDictToConfig({ StartCalendarInterval: { Hour: 7, Minute: 30 } });
  assert.strictEqual(config.calendarIntervals.length, 1);
  assert.strictEqual(config.calendarIntervals[0].Hour, 7);
});

test('plist 読み込み: 空の StartCalendarInterval (毎分実行の意味) は喪失警告を出す', () => {
  const { config, notes } = plistDictToConfig({
    Label: 'a.b',
    ProgramArguments: ['/bin/true'],
    StartCalendarInterval: {},
  });
  assert.strictEqual(config.calendarIntervals.length, 0);
  assert.ok(notes.some((n) => n.includes('毎分実行') && n.includes('失われます') && n.includes('StartInterval に 60')));
});

test('plist 読み込み: 配列中の空の予定だけが除外され、正常な予定は残る', () => {
  const { config, notes } = plistDictToConfig({
    StartCalendarInterval: [{}, { Hour: 9, Minute: 0 }, { Era: 1 }],
  });
  assert.strictEqual(config.calendarIntervals.length, 1);
  assert.strictEqual(config.calendarIntervals[0].Hour, 9);
  // {} と、対応外フィールドのみで空になった {Era:1} の計 2 件
  assert.ok(notes.some((n) => n.includes('空の予定が 2 件')));
  assert.ok(notes.some((n) => n.includes('対応外のフィールド')));
});

test('field は index.html の FIELD_TARGETS と入力欄 id に対応している', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/const FIELD_TARGETS = \{([\s\S]*?)\};/);
  assert.ok(m, 'index.html に FIELD_TARGETS がない');
  const mapping = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*(\w+): '([\w-]+)',/);
    if (mm) mapping[mm[1]] = mm[2];
  }
  const fields = [
    'label', 'programArguments', 'workingDirectory', 'standardOutPath', 'standardErrorPath',
    'watchPaths', 'queueDirectories', 'environmentVariables', 'calendar', 'startInterval',
    'keepAlive', 'throttleInterval', 'trigger',
  ];
  for (const f of fields) {
    assert.ok(mapping[f], `FIELD_TARGETS に ${f} がない`);
    assert.ok(html.includes(`id="${mapping[f]}"`), `id="${mapping[f]}" の要素が HTML にない`);
  }
});

if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
