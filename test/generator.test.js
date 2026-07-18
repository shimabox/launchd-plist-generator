/*
 * generator.js のテスト。実行方法は `node test/generator.test.js`。
 * 失敗があると非ゼロで終了する。macOS では生成 XML を plutil -lint にも通す。
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generatePlist } = require('../generator.js');

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

if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
