/*
 * launchd plist generator — 生成・検証ロジック
 *
 * ブラウザ (index.html) と Node.js (将来の CLI 版) の両方から使えるよう、
 * DOM には一切依存しない純粋な関数だけを置く。
 *
 * 使い方:
 *   const result = generatePlist(config)
 *   result.xml      … plist の XML 文字列
 *   result.filename … 推奨ファイル名 (<Label>.plist)
 *   result.commands … 登録・テスト・解除の launchctl コマンド一式
 *   result.issues   … [{level: 'error'|'warn'|'info', message}] 検証結果
 *
 * config の形:
 * {
 *   label: string,
 *   programArguments: string[],            // argv。シェルは介さない
 *   workingDirectory: string,              // 空なら省略
 *   environmentVariables: {KEY: VALUE},    // 空オブジェクトなら省略
 *   standardOutPath: string,
 *   standardErrorPath: string,
 *   runAtLoad: boolean,
 *   startInterval: number|null,            // 秒
 *   calendarIntervals: [{Minute, Hour, Day, Weekday, Month}], // 各値 number|null(=ワイルドカード)
 *   watchPaths: string[],
 *   queueDirectories: string[],
 *   keepAlive: 'off'|'always'|'on-failure',
 *   processType: ''|'Standard'|'Background'|'Adaptive'|'Interactive',
 *   throttleInterval: number|null,
 * }
 */

const LAUNCHD_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const CALENDAR_FIELDS = [
  { key: 'Minute',  min: 0, max: 59, label: '分' },
  { key: 'Hour',    min: 0, max: 23, label: '時' },
  { key: 'Day',     min: 1, max: 31, label: '日' },
  { key: 'Weekday', min: 0, max: 7,  label: '曜日' },
  { key: 'Month',   min: 1, max: 12, label: '月' },
];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isAbsolutePath(p) {
  return typeof p === 'string' && p.startsWith('/');
}

/* ---------- 検証 ---------- */

function validate(config) {
  const issues = [];
  const error = (message) => issues.push({ level: 'error', message });
  const warn = (message) => issues.push({ level: 'warn', message });
  const info = (message) => issues.push({ level: 'info', message });

  // Label
  const label = (config.label || '').trim();
  if (!label) {
    error('Label は必須です。逆 DNS 形式 (例: com.username.jobname) で付けてください。');
  } else {
    if (/\s/.test(label)) error('Label に空白は使えません。');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
      warn('Label は英数字と . _ - だけで構成するのが安全です。');
    } else if (!label.includes('.')) {
      info('Label は逆 DNS 形式 (com.username.jobname) にするのが慣習です。');
    }
  }

  // ProgramArguments
  const args = (config.programArguments || []).filter((a) => a !== '');
  if (args.length === 0) {
    error('実行するコマンド (ProgramArguments) を最低 1 つ指定してください。');
  } else {
    const argv0 = args[0];
    const isShellWrapper = /\/(sh|bash|zsh|dash)$/.test(argv0);

    if (!isAbsolutePath(argv0)) {
      warn(
        `実行コマンド「${argv0}」は絶対パスで書くことを強く推奨します。` +
          `launchd の PATH は ${LAUNCHD_DEFAULT_PATH} だけなので、それ以外の場所のコマンドは見つかりません` +
          ' (exit 127 の典型原因)。ターミナルで `which ' + argv0 + '` と打つとフルパスが分かります。'
      );
    }

    for (const a of args) {
      if (/(^|[\s:="'])~\//.test(a) || a === '~') {
        warn(`「${a}」に ~ が含まれています。launchd は ~ を展開しないので、/Users/ユーザー名/... と絶対パスで書いてください。`);
        break;
      }
    }

    if (!isShellWrapper) {
      const shelly = args.slice(1).find((a) => /[|<>*`;&]|\$[({A-Za-z_]/.test(a));
      if (shelly) {
        info(
          `引数「${shelly}」にシェルの記号 (| > * $ など) が含まれています。ただの文字列として渡したいなら問題ありませんが、` +
            'ProgramArguments はシェルを介さないため、パイプ・リダイレクト・変数展開などの「シェルの機能」を期待している場合は動きません。' +
            'その場合は /bin/zsh -c \'コマンド\' の形にするか、スクリプトファイルに切り出してください。'
        );
      }
    }
  }

  // パス系フィールドの絶対パスチェック
  const pathFields = [
    ['WorkingDirectory', config.workingDirectory],
    ['StandardOutPath', config.standardOutPath],
    ['StandardErrorPath', config.standardErrorPath],
  ];
  for (const [name, value] of pathFields) {
    if (value && !isAbsolutePath(value)) {
      warn(`${name}「${value}」は絶対パス (/ から始まるパス) で書いてください。~ や相対パスは使えません。`);
    }
  }
  for (const p of [...(config.watchPaths || []), ...(config.queueDirectories || [])]) {
    if (p && !isAbsolutePath(p)) {
      warn(`監視パス「${p}」は絶対パスで書いてください。`);
    }
  }

  // 環境変数
  const env = config.environmentVariables || {};
  for (const [k, v] of Object.entries(env)) {
    if (/\$[({A-Za-z_]/.test(v)) {
      info(`環境変数 ${k} の値に $ が含まれていますが、他の変数は展開されず文字列のまま渡されます。`);
    }
  }

  // トリガー
  const calendars = (config.calendarIntervals || []).filter((c) =>
    CALENDAR_FIELDS.some((f) => c[f.key] !== null && c[f.key] !== undefined)
  );
  const hasTrigger =
    config.runAtLoad ||
    (config.startInterval != null && config.startInterval > 0) ||
    calendars.length > 0 ||
    (config.watchPaths || []).some(Boolean) ||
    (config.queueDirectories || []).some(Boolean) ||
    config.keepAlive === 'always';
  if (!hasTrigger) {
    warn('起動トリガーがひとつもありません。このままでは登録しても自動では実行されません (launchctl kickstart での手動実行のみ可能)。');
  }

  // StartCalendarInterval の範囲チェック
  for (const c of calendars) {
    for (const f of CALENDAR_FIELDS) {
      const v = c[f.key];
      if (v == null) continue;
      if (!Number.isInteger(v) || v < f.min || v > f.max) {
        error(`StartCalendarInterval の ${f.key} (${f.label}) は ${f.min}〜${f.max} の整数で指定してください (指定値: ${v})。`);
      }
    }
  }

  // StartInterval
  if (config.startInterval != null) {
    if (!Number.isInteger(config.startInterval) || config.startInterval <= 0) {
      error('StartInterval は 1 以上の整数 (秒) で指定してください。');
    } else if (config.startInterval < 10) {
      warn('StartInterval が 10 秒未満です。launchd は既定で 10 秒 (ThrottleInterval) より短い間隔の再実行を抑制するため、指定どおりには動きません。');
    }
  }

  // KeepAlive
  if (config.keepAlive === 'always') {
    info('KeepAlive: 常駐モードです。プロセスがすぐ終了するコマンドだと約 10 秒間隔の再起動ループになるので、常駐型のプログラムにだけ使ってください。');
  }

  // ThrottleInterval
  if (config.throttleInterval != null && (!Number.isInteger(config.throttleInterval) || config.throttleInterval < 0)) {
    error('ThrottleInterval は 0 以上の整数 (秒) で指定してください。');
  }

  // ログの推奨
  if (!config.standardErrorPath) {
    info('StandardErrorPath (エラーログ) の設定を推奨します。これがないと失敗したときの原因調査がほぼできません。');
  }

  return issues;
}

/* ---------- XML 生成 ---------- */

function buildXml(config) {
  const L = [];
  const push = (indent, s) => L.push('    '.repeat(indent) + s);

  const kvString = (indent, key, value) => {
    push(indent, `<key>${escapeXml(key)}</key>`);
    push(indent, `<string>${escapeXml(value)}</string>`);
  };
  const kvInteger = (indent, key, value) => {
    push(indent, `<key>${escapeXml(key)}</key>`);
    push(indent, `<integer>${value}</integer>`);
  };
  const kvBool = (indent, key, value) => {
    push(indent, `<key>${escapeXml(key)}</key>`);
    push(indent, value ? '<true/>' : '<false/>');
  };
  const stringArray = (indent, key, values) => {
    push(indent, `<key>${escapeXml(key)}</key>`);
    push(indent, '<array>');
    for (const v of values) push(indent + 1, `<string>${escapeXml(v)}</string>`);
    push(indent, '</array>');
  };

  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
  L.push('  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
  L.push('<plist version="1.0">');
  L.push('<dict>');

  kvString(1, 'Label', (config.label || '').trim() || 'com.example.myjob');

  const args = (config.programArguments || []).filter((a) => a !== '');
  if (args.length > 0) stringArray(1, 'ProgramArguments', args);

  if (config.workingDirectory) kvString(1, 'WorkingDirectory', config.workingDirectory);

  const env = config.environmentVariables || {};
  if (Object.keys(env).length > 0) {
    push(1, '<key>EnvironmentVariables</key>');
    push(1, '<dict>');
    for (const [k, v] of Object.entries(env)) kvString(2, k, v);
    push(1, '</dict>');
  }

  if (config.runAtLoad) kvBool(1, 'RunAtLoad', true);

  if (config.startInterval != null && config.startInterval > 0) {
    kvInteger(1, 'StartInterval', config.startInterval);
  }

  const calendars = (config.calendarIntervals || []).filter((c) =>
    CALENDAR_FIELDS.some((f) => c[f.key] !== null && c[f.key] !== undefined)
  );
  if (calendars.length === 1) {
    push(1, '<key>StartCalendarInterval</key>');
    push(1, '<dict>');
    for (const f of CALENDAR_FIELDS) {
      if (calendars[0][f.key] != null) kvInteger(2, f.key, calendars[0][f.key]);
    }
    push(1, '</dict>');
  } else if (calendars.length > 1) {
    push(1, '<key>StartCalendarInterval</key>');
    push(1, '<array>');
    for (const c of calendars) {
      push(2, '<dict>');
      for (const f of CALENDAR_FIELDS) {
        if (c[f.key] != null) kvInteger(3, f.key, c[f.key]);
      }
      push(2, '</dict>');
    }
    push(1, '</array>');
  }

  const watch = (config.watchPaths || []).filter(Boolean);
  if (watch.length > 0) stringArray(1, 'WatchPaths', watch);

  const queue = (config.queueDirectories || []).filter(Boolean);
  if (queue.length > 0) stringArray(1, 'QueueDirectories', queue);

  if (config.keepAlive === 'always') {
    kvBool(1, 'KeepAlive', true);
  } else if (config.keepAlive === 'on-failure') {
    push(1, '<key>KeepAlive</key>');
    push(1, '<dict>');
    kvBool(2, 'SuccessfulExit', false);
    push(1, '</dict>');
  }

  if (config.standardOutPath) kvString(1, 'StandardOutPath', config.standardOutPath);
  if (config.standardErrorPath) kvString(1, 'StandardErrorPath', config.standardErrorPath);

  if (config.processType && config.processType !== 'Standard') {
    kvString(1, 'ProcessType', config.processType);
  }

  if (config.throttleInterval != null && config.throttleInterval >= 0) {
    kvInteger(1, 'ThrottleInterval', config.throttleInterval);
  }

  L.push('</dict>');
  L.push('</plist>');
  return L.join('\n') + '\n';
}

/* ---------- コマンド生成 ---------- */

function buildCommands(label) {
  const l = label || 'com.example.myjob';
  const plistPath = `~/Library/LaunchAgents/${l}.plist`;
  return [
    '# 1. 書式チェック',
    `plutil -lint ${plistPath}`,
    '',
    '# 2. 登録',
    `launchctl bootstrap gui/$(id -u) ${plistPath}`,
    '',
    '# 3. スケジュールを待たずにテスト実行',
    `launchctl kickstart -k gui/$(id -u)/${l}`,
    '',
    '# 状態確認',
    `launchctl print gui/$(id -u)/${l}`,
    '',
    '# 解除するとき (plist を編集したら bootout → bootstrap で再登録)',
    `launchctl bootout gui/$(id -u)/${l}`,
  ].join('\n');
}

/* ---------- エントリポイント ---------- */

function generatePlist(config) {
  const label = (config.label || '').trim();
  return {
    xml: buildXml(config),
    filename: `${label || 'com.example.myjob'}.plist`,
    commands: buildCommands(label),
    issues: validate(config),
  };
}

// Node.js (CLI 版) から require できるようにする。ブラウザではグローバルに公開される。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generatePlist, CALENDAR_FIELDS, LAUNCHD_DEFAULT_PATH };
}
