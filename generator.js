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
 *   result.issues   … [{level: 'error'|'warn'|'info', message, field}] 検証結果
 *                     (field は対象フィールド名。UI が入力欄と紐付けるためのヒント)
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
  const error = (message, field) => issues.push({ level: 'error', message, field });
  const warn = (message, field) => issues.push({ level: 'warn', message, field });
  const info = (message, field) => issues.push({ level: 'info', message, field });

  // Label
  const label = (config.label || '').trim();
  if (!label) {
    error('Label は必須です。逆 DNS 形式 (例: com.username.jobname) で付けてください。', 'label');
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    error('Label に使えるのは英数字と . _ - だけです (空白や記号は不可)。ファイル名やシェルコマンドに安全に埋め込めません。', 'label');
  } else if (!label.includes('.')) {
    info('Label は逆 DNS 形式 (com.username.jobname) にするのが慣習です。', 'label');
  }

  // ProgramArguments
  const args = (config.programArguments || []).filter((a) => a !== '');
  if (args.length === 0) {
    error('実行するコマンド (ProgramArguments) を最低 1 つ指定してください。', 'programArguments');
  } else {
    const argv0 = args[0];
    const isShellWrapper = /\/(sh|bash|zsh|dash)$/.test(argv0);

    if (!isAbsolutePath(argv0)) {
      warn(
        `実行コマンド「${argv0}」は絶対パスで書くことを強く推奨します。` +
          `launchd の PATH は ${LAUNCHD_DEFAULT_PATH} だけなので、それ以外の場所のコマンドは見つかりません` +
          ' (exit 127 の典型原因)。ターミナルで `which ' + argv0 + '` と打つとフルパスが分かります。',
        'programArguments'
      );
    }

    for (const a of args) {
      if (/(^|[\s:="'])~\//.test(a) || a === '~') {
        warn(`「${a}」に ~ が含まれています。launchd は ~ を展開しないので、/Users/ユーザー名/... と絶対パスで書いてください。`, 'programArguments');
        break;
      }
    }

    if (!isShellWrapper) {
      const shelly = args.slice(1).find((a) => /[|<>*`;&]|\$[({A-Za-z_]/.test(a));
      if (shelly) {
        info(
          `引数「${shelly}」にシェルの記号 (| > * $ など) が含まれています。ただの文字列として渡したいなら問題ありませんが、` +
            'ProgramArguments はシェルを介さないため、パイプ・リダイレクト・変数展開などの「シェルの機能」を期待している場合は動きません。' +
            'その場合は /bin/zsh -c \'コマンド\' の形にするか、スクリプトファイルに切り出してください。',
          'programArguments'
        );
      }
    }
  }

  // パス系フィールドの絶対パスチェック
  const pathFields = [
    ['WorkingDirectory', config.workingDirectory, 'workingDirectory'],
    ['StandardOutPath', config.standardOutPath, 'standardOutPath'],
    ['StandardErrorPath', config.standardErrorPath, 'standardErrorPath'],
  ];
  for (const [name, value, field] of pathFields) {
    if (value && !isAbsolutePath(value)) {
      warn(`${name}「${value}」は絶対パス (/ から始まるパス) で書いてください。~ や相対パスは使えません。`, field);
    }
  }
  for (const [paths, field] of [[config.watchPaths, 'watchPaths'], [config.queueDirectories, 'queueDirectories']]) {
    for (const p of paths || []) {
      if (p && !isAbsolutePath(p)) {
        warn(`監視パス「${p}」は絶対パスで書いてください。`, field);
      }
    }
  }

  // 環境変数
  const env = config.environmentVariables || {};
  for (const [k, v] of Object.entries(env)) {
    if (/\$[({A-Za-z_]/.test(v)) {
      info(`環境変数 ${k} の値に $ が含まれていますが、他の変数は展開されず文字列のまま渡されます。`, 'environmentVariables');
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
    config.keepAlive === 'always' ||
    config.keepAlive === 'on-failure';
  if (!hasTrigger) {
    warn('起動トリガーがひとつもありません。このままでは登録しても自動では実行されません (launchctl kickstart での手動実行のみ可能)。', 'trigger');
  }

  // StartCalendarInterval の範囲チェック
  for (const c of calendars) {
    for (const f of CALENDAR_FIELDS) {
      const v = c[f.key];
      if (v == null) continue;
      if (!Number.isInteger(v) || v < f.min || v > f.max) {
        error(`StartCalendarInterval の ${f.key} (${f.label}) は ${f.min}〜${f.max} の整数で指定してください (指定値: ${v})。`, 'calendar');
      }
    }
  }

  // Day と Weekday の同時指定は OR 条件になる
  if (calendars.some((c) => c.Day != null && c.Weekday != null)) {
    warn('日 (Day) と曜日 (Weekday) を同じ行で指定すると AND ではなく OR として扱われます。「毎月 N 日かつ X 曜日」ではなく「毎月 N 日と、毎週 X 曜日の両方」で実行されるため、想定より頻繁に動く可能性があります。', 'calendar');
  }

  // StartInterval
  if (config.startInterval != null) {
    if (!Number.isInteger(config.startInterval) || config.startInterval <= 0) {
      error('StartInterval は 1 以上の整数 (秒) で指定してください。', 'startInterval');
    } else if (config.startInterval < 10) {
      warn('StartInterval が 10 秒未満です。launchd は既定で 10 秒 (ThrottleInterval) より短い間隔の再実行を抑制するため、指定どおりには動きません。', 'startInterval');
    }
  }

  // KeepAlive
  if (config.keepAlive === 'always') {
    info('KeepAlive: 常駐モードです。プロセスがすぐ終了するコマンドだと約 10 秒間隔の再起動ループになるので、常駐型のプログラムにだけ使ってください。', 'keepAlive');
  } else if (config.keepAlive === 'on-failure') {
    info('KeepAlive を指定したジョブは、登録時に 1 回自動で起動します (RunAtLoad 相当の動作を含む)。', 'keepAlive');
  }

  // ThrottleInterval
  if (config.throttleInterval != null && (!Number.isInteger(config.throttleInterval) || config.throttleInterval < 0)) {
    error('ThrottleInterval は 0 以上の整数 (秒) で指定してください。', 'throttleInterval');
  }

  // ログの推奨
  if (!config.standardErrorPath) {
    info('StandardErrorPath (エラーログ) の設定を推奨します。これがないと失敗したときの原因調査がほぼできません。', 'standardErrorPath');
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

  if (Number.isInteger(config.startInterval) && config.startInterval > 0) {
    kvInteger(1, 'StartInterval', config.startInterval);
  }

  // 1 フィールドでも不正な値を含む行は丸ごと除外する。
  // 一部だけ省略すると「{Hour: 9.5, Minute: 0} が毎時 0 分になる」ような
  // 意味の変わった予定が静かに生まれてしまうため (検証エラーは validate 側で出る)。
  const isValidCalendarEntry = (c) =>
    CALENDAR_FIELDS.every((f) => c[f.key] == null || (Number.isInteger(c[f.key]) && c[f.key] >= f.min && c[f.key] <= f.max));
  const calendars = (config.calendarIntervals || []).filter(
    (c) => CALENDAR_FIELDS.some((f) => c[f.key] !== null && c[f.key] !== undefined) && isValidCalendarEntry(c)
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

  if (Number.isInteger(config.throttleInterval) && config.throttleInterval >= 0) {
    kvInteger(1, 'ThrottleInterval', config.throttleInterval);
  }

  L.push('</dict>');
  L.push('</plist>');
  return L.join('\n') + '\n';
}

/* ---------- コマンド生成 ---------- */

// 安全な文字だけならそのまま、それ以外はシングルクォートで囲んでエスケープする。
// Label は検証で英数字 . _ - に制限しているが、エラーを無視して使われても
// コマンド側でインジェクションが成立しないよう二重に防ぐ。
function shellSafe(s) {
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildCommands(label) {
  const l = shellSafe(label || 'com.example.myjob');
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

/* ---------- plist の読み込み (逆変換) ---------- */

// plist XML テキスト → JS 値ツリー。DOMParser を使うためブラウザ専用。
function parsePlistXml(text) {
  if (typeof DOMParser === 'undefined') {
    throw new Error('parsePlistXml はブラウザでのみ使えます');
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML として解析できません');
  const root = doc.documentElement;
  if (root.tagName !== 'plist') throw new Error('plist 形式ではありません');
  const dictEl = [...root.children].find((el) => el.tagName === 'dict');
  if (!dictEl) throw new Error('plist 直下に dict がありません');
  return plistXmlToValue(dictEl);
}

function plistXmlToValue(el) {
  switch (el.tagName) {
    case 'dict': {
      const obj = {};
      const children = [...el.children];
      for (let i = 0; i < children.length; i += 2) {
        if (children[i].tagName === 'key' && children[i + 1]) {
          obj[children[i].textContent] = plistXmlToValue(children[i + 1]);
        }
      }
      return obj;
    }
    case 'array':
      return [...el.children].map(plistXmlToValue);
    case 'integer':
      return parseInt(el.textContent, 10);
    case 'real':
      return parseFloat(el.textContent);
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      // string のほか、date / data も文字列として保持する
      return el.textContent;
  }
}

// plist の dict (JS オブジェクト) → このツールの config。純粋関数なので Node からもテストできる。
// 戻り値の notes には、対応外キーの喪失警告など利用者に伝えるべきことが入る。
function plistDictToConfig(dict) {
  const notes = [];
  const handled = new Set();
  const take = (key) => {
    handled.add(key);
    return dict[key];
  };
  const config = {
    label: '',
    programArguments: [],
    workingDirectory: '',
    environmentVariables: {},
    standardOutPath: '',
    standardErrorPath: '',
    runAtLoad: false,
    startInterval: null,
    calendarIntervals: [],
    watchPaths: [],
    queueDirectories: [],
    keepAlive: 'off',
    processType: '',
    throttleInterval: null,
  };

  if (typeof dict.Label === 'string') config.label = take('Label');
  if (Array.isArray(dict.ProgramArguments)) {
    config.programArguments = take('ProgramArguments').map(String);
  }
  if (typeof dict.Program === 'string') {
    if (config.programArguments.length > 0) {
      // Program が実行ファイル・ProgramArguments が argv になる構成。argv[0] と実行ファイルが
      // 異なり得るため、ProgramArguments しか持たないこのツールでは正確に表現できない
      throw new Error(
        'Program と ProgramArguments が両方指定されています。この構成は実行ファイル (Program) と argv[0] が異なる場合があり、このツールでは正確に表現できないため読み込めません。plist を直接編集してください'
      );
    }
    config.programArguments = [take('Program')];
  }

  // フォームは「1 行 1 引数」形式のため、空の引数・改行入り・前後に空白のある引数は保持できない
  const unrepresentable = config.programArguments.filter(
    (a) => a === '' || a.includes('\n') || a !== a.trim()
  );
  if (unrepresentable.length > 0) {
    notes.push(
      '空の引数・改行を含む引数・前後に空白のある引数はフォームの「1 行 1 引数」形式で表現できないため、取り込み後に失われるか変化します: ' +
        unrepresentable.map((a) => JSON.stringify(a)).join(', ')
    );
  }
  if (typeof dict.WorkingDirectory === 'string') config.workingDirectory = take('WorkingDirectory');
  if (typeof dict.StandardOutPath === 'string') config.standardOutPath = take('StandardOutPath');
  if (typeof dict.StandardErrorPath === 'string') config.standardErrorPath = take('StandardErrorPath');
  if (typeof dict.RunAtLoad === 'boolean') config.runAtLoad = take('RunAtLoad');
  if (typeof dict.StartInterval === 'number') config.startInterval = take('StartInterval');
  if (typeof dict.ThrottleInterval === 'number') config.throttleInterval = take('ThrottleInterval');

  if (dict.EnvironmentVariables && typeof dict.EnvironmentVariables === 'object' && !Array.isArray(dict.EnvironmentVariables)) {
    for (const [k, v] of Object.entries(take('EnvironmentVariables'))) {
      config.environmentVariables[k] = String(v);
    }
  }

  if (dict.StartCalendarInterval !== undefined) {
    const raw = take('StartCalendarInterval');
    const entries = Array.isArray(raw) ? raw : [raw];
    let hasUnknownField = false;
    let emptyEntryCount = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const c = {};
      for (const f of CALENDAR_FIELDS) {
        if (typeof entry[f.key] === 'number') c[f.key] = entry[f.key];
      }
      hasUnknownField = hasUnknownField || Object.keys(entry).some((k) => !CALENDAR_FIELDS.some((f) => f.key === k));
      if (Object.keys(c).length === 0) {
        // launchd では全フィールド省略 = 全ワイルドカード = 毎分実行の意味を持つが、
        // このツールは空の予定を「未入力」として扱い生成しないため、そのまま取り込むと意味が変わる
        emptyEntryCount++;
      } else {
        config.calendarIntervals.push(c);
      }
    }
    if (hasUnknownField) {
      notes.push('StartCalendarInterval に対応外のフィールドが含まれていたため、その部分は取り込めませんでした。');
    }
    if (emptyEntryCount > 0) {
      notes.push(
        `StartCalendarInterval に空の予定が ${emptyEntryCount} 件あります。launchd では全フィールド省略は「毎分実行」を意味しますが、このツールでは表現できないため取り込み後に失われます。毎分実行が必要な場合は StartInterval に 60 を指定してください。`
      );
    }
  }

  if (Array.isArray(dict.WatchPaths)) config.watchPaths = take('WatchPaths').map(String);
  if (Array.isArray(dict.QueueDirectories)) config.queueDirectories = take('QueueDirectories').map(String);

  if (dict.KeepAlive !== undefined) {
    const raw = take('KeepAlive');
    if (raw === true) {
      config.keepAlive = 'always';
    } else if (raw === false) {
      config.keepAlive = 'off';
    } else if (raw && typeof raw === 'object') {
      if (raw.SuccessfulExit === false) {
        config.keepAlive = 'on-failure';
        const others = Object.keys(raw).filter((k) => k !== 'SuccessfulExit');
        if (others.length > 0) {
          notes.push(`KeepAlive の条件のうち ${others.join(', ')} はこのツールでは扱えないため、取り込めませんでした。`);
        }
      } else {
        notes.push('KeepAlive の条件 (' + Object.keys(raw).join(', ') + ') はこのツールでは扱えないため、取り込めませんでした。');
      }
    }
  }

  if (typeof dict.ProcessType === 'string') {
    const pt = take('ProcessType');
    if (pt === 'Standard') {
      config.processType = '';
    } else if (['Background', 'Adaptive', 'Interactive'].includes(pt)) {
      config.processType = pt;
    } else {
      notes.push(`ProcessType「${pt}」は不明な値のため、取り込めませんでした。`);
    }
  }

  // 引数以外のフィールドについても、フォームの形式で保持できない値を警告する。
  // テキストエリアは「1 行 1 項目」で前後の空白を除去し、単一行入力は改行を持てないため。
  const reportLoss = (name, values) => {
    if (values.length > 0) {
      notes.push(
        `${name} にフォームで保持できない値 (空文字・改行・前後の空白) が含まれるため、取り込み後に失われるか変化します: ` +
          values.map((v) => JSON.stringify(v)).join(', ')
      );
    }
  };
  const lineLoss = (s) => s === '' || s.includes('\n') || s !== s.trim();
  if (config.label !== '' && (config.label.includes('\n') || config.label !== config.label.trim())) {
    reportLoss('Label', [config.label]);
  }
  reportLoss('WatchPaths', config.watchPaths.filter(lineLoss));
  reportLoss('QueueDirectories', config.queueDirectories.filter(lineLoss));
  for (const [name, v] of [
    ['WorkingDirectory', config.workingDirectory],
    ['StandardOutPath', config.standardOutPath],
    ['StandardErrorPath', config.standardErrorPath],
  ]) {
    if (v !== '' && (v.includes('\n') || v !== v.trim())) reportLoss(name, [v]);
  }
  reportLoss(
    'EnvironmentVariables',
    Object.entries(config.environmentVariables)
      .filter(([k, v]) =>
        k === '' || k !== k.trim() || k.includes('\n') || k.includes('=') || v.includes('\n') || v !== v.trimEnd()
      )
      .map(([k, v]) => `${k}=${v}`)
  );

  const unsupported = Object.keys(dict).filter((k) => !handled.has(k));
  if (unsupported.length > 0) {
    notes.push(`対応外のキーが含まれています: ${unsupported.join(', ')} — このツールで再生成すると、これらのキーは失われます。`);
  }

  return { config, notes };
}

/* ---------- エントリポイント ---------- */

function generatePlist(config) {
  const label = (config.label || '').trim();
  const safeName = label.replace(/[^A-Za-z0-9._-]/g, '-') || 'com.example.myjob';
  return {
    xml: buildXml(config),
    filename: `${safeName}.plist`,
    commands: buildCommands(label),
    issues: validate(config),
  };
}

// Node.js (CLI 版) から require できるようにする。ブラウザではグローバルに公開される。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generatePlist, parsePlistXml, plistDictToConfig, CALENDAR_FIELDS, LAUNCHD_DEFAULT_PATH };
}
