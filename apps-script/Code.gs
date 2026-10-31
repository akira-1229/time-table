/**
 * 空き時間登録システム 通知係（Google Apps Script）
 *
 * ・processOutbox：1分おきに起動（＋画面からウェブアプリとして呼ばれた時はすぐ）。Firestoreの outbox（送信待ち）を取り出して、プッシュ通知を送る
 *                  定期実行の時は、あわせて lessonCheck_ で「教習が終わったら実施・欠席を入力してください」を指導員に通知する
 *                  （終わった瞬間に1回。入力されるまで CHECK_REPEAT_MIN 分おきに出し直す）
 *                  水曜日の PUBLISH_REMIND 時に、来週の予定をまだ確定（公開）していない指導員にだけ通知する（publishReminder_）
 * ・dailyReminder：毎朝起動。締切（教習生ごと）の数日前と前日に、その月の分が未入力の教習生だけに通知する
 *                  あわせて、教習期限・仮免期限の2ヶ月前・1ヶ月前・2週間前に、教習生本人と担当指導員に通知する
 *                  検定日の当日は、その教習生に「本日はいよいよ検定日です！」を通知する
 *                  アクセス記録（access）のうち、ACCESS_KEEP_DAYS 日より古いものを消す（無料枠の中に収めるため）
 *
 * 必要なスクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   PROJECT_ID   … FirebaseのプロジェクトID
 *   SA_EMAIL     … サービスアカウントのメールアドレス（JSONの client_email）
 *   SA_KEY       … サービスアカウントの秘密鍵（JSONの private_key。-----BEGIN から END----- まで丸ごと）
 *   APP_URL      … GitHub Pagesの公開URL（最後に / を付ける）
 *   DEADLINE_DAY … 次月分の入力締切日（例：20）
 *   REMIND_DAYS  … 締切の何日前に知らせるか（カンマ区切り。例：3,1）
 *   EXPIRY_ALERT … 教習期限・仮免期限のいつ知らせるか（カンマ区切り。m＝ヶ月前、w＝週間前、d＝日前。省略時 2m,1m,2w）
 *   ACCESS_KEEP_DAYS … アクセス記録を残す日数（省略時 90）
 *   CHECK_REPEAT_MIN … 実施・欠席が未入力の時に、指導員へ通知を出し直す間隔（分。省略時 30）
 *   CHECK_HOURS      … 出し直しをする時間帯（例：9-21。省略時 9-21。夜中は送らない）
 *   PUBLISH_REMIND   … 水曜日の何時に「来週の予定がまだ公開されていません」を送るか（カンマ区切り。省略時 9,17）
 *
 * ※ 秘密鍵はGitHubなど外部に絶対に置かないこと
 */

const PROPS = PropertiesService.getScriptProperties();
const prop = k => PROPS.getProperty(k);
const FS_BASE = () => `https://firestore.googleapis.com/v1/projects/${prop('PROJECT_ID')}/databases/(default)/documents`;

/* ---------- 初回だけ実行：定期実行の設定 ---------- */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processOutbox').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('dailyReminder').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Tokyo').create();
  Logger.log('定期実行を設定しました');
}

/* ---------- 認証（サービスアカウント） ---------- */
function getAccessToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sa_token');
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: prop('SA_EMAIL'),
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  };
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const input = enc(header) + '.' + enc(claim);
  const key = prop('SA_KEY').replace(/\\n/g, '\n');
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig }
  });
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('sa_token', token, 3000);
  return token;
}
function api_(url, method, body) {
  const res = UrlFetchApp.fetch(url, {
    method: method || 'get', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getAccessToken_() },
    payload: body ? JSON.stringify(body) : undefined
  });
  return { code: res.getResponseCode(), json: JSON.parse(res.getContentText() || '{}') };
}

/* ---------- Firestoreの値の変換 ---------- */
function fromFs_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs_);
  if ('mapValue' in v) { const o = {}; Object.entries(v.mapValue.fields || {}).forEach(([k, x]) => o[k] = fromFs_(x)); return o; }
  return null;
}
function docData_(d) { const o = {}; Object.entries(d.fields || {}).forEach(([k, v]) => o[k] = fromFs_(v)); return o; }
function getDoc_(path) { const r = api_(`${FS_BASE()}/${path}`); return r.code === 200 ? docData_(r.json) : null; }
function patch_(path, fields) {
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return api_(`${FS_BASE()}/${path}?${mask}`, 'patch', { fields });
}
function query_(structuredQuery) {
  const r = api_(`${FS_BASE()}:runQuery`, 'post', { structuredQuery });
  return (Array.isArray(r.json) ? r.json : []).filter(x => x.document).map(x => ({ name: x.document.name, data: docData_(x.document) }));
}
const relPath_ = name => name.split('/documents/')[1];

/* ---------- プッシュ通知の送信 ---------- */
function sendPush_(token, title, body, link) {
  const r = api_(`https://fcm.googleapis.com/v1/projects/${prop('PROJECT_ID')}/messages:send`, 'post', {
    message: {
      token: token,
      notification: { title: title, body: body },
      webpush: { fcm_options: { link: link }, notification: { icon: prop('APP_URL') + 'icons/icon-192.png' } }
    }
  });
  if (r.code === 200) return 'ok';
  const status = (r.json.error && r.json.error.status) || '';
  const detail = JSON.stringify(r.json.error || {});
  if (r.code === 404 || status === 'NOT_FOUND' || detail.indexOf('UNREGISTERED') >= 0) return 'invalid';
  Logger.log('送信エラー: ' + detail);
  return 'error';
}
// 宛先のトークンへ送り、使えなくなったトークンは削除する
function deliver_(docPath, tokens, title, body, link) {
  let ok = 0; const keep = [];
  (tokens || []).forEach(tk => {
    const r = sendPush_(tk, title, body, link);
    if (r !== 'invalid') keep.push(tk);
    if (r === 'ok') ok++;
  });
  if (keep.length !== (tokens || []).length) {
    patch_(docPath, { fcmTokens: { arrayValue: { values: keep.map(s => ({ stringValue: s })) } } });
  }
  return ok;
}

/* ---------- 5分おき：送信待ちの通知を送る ---------- */
// 画面から「すぐ送って」と呼ばれる入口（ウェブアプリとして公開する。SETUP.md 手順9-7）
// 送信待ちを送るだけなので、誰が呼んでも送られるのは職員・本人が書いた通知だけ
function doPost(e) { processOutbox(20000); return ContentService.createTextOutput('ok'); }
function doGet(e) { processOutbox(20000); return ContentService.createTextOutput('ok'); }

function processOutbox(wait) {
  const lock = LockService.getScriptLock();
  // ほかの送信が動いている時は終わるのを待つ（画面から呼ばれた時は最大20秒。定期実行は1秒）
  if (!lock.tryLock(typeof wait === 'number' ? wait : 1000)) return;
  try {
    const items = query_({
      from: [{ collectionId: 'outbox' }],
      where: { fieldFilter: { field: { fieldPath: 'sent' }, op: 'EQUAL', value: { booleanValue: false } } },
      limit: 100
    });
    const appUrl = prop('APP_URL');
    items.forEach(it => {
      const o = it.data; let delivered = 0;
      try {
        if (o.to === 'student') {
          const path = `students/${o.studentToken}`; const s = getDoc_(path);
          if (s && s.active !== false) delivered = deliver_(path, s.fcmTokens, o.title, o.body, `${appUrl}student.html?t=${encodeURIComponent(o.studentToken)}`);
        } else if (o.to === 'instructor') {
          const path = `instructors/${o.instructorUid}`; const t = getDoc_(path);
          if (t) delivered = deliver_(path, t.fcmTokens, o.title, o.body, `${appUrl}instructor.html`);
        }
      } catch (e) { Logger.log('処理エラー: ' + e); }
      patch_(relPath_(it.name), {
        sent: { booleanValue: true },
        sentAt: { timestampValue: new Date().toISOString() },
        delivered: { integerValue: String(delivered) }
      });
    });
    // 定期実行（1分おき）の時だけ：教習が終わったら指導員に実施・欠席の入力を促す（画面から呼ばれた時はしない）
    if (typeof wait !== 'number') { try { lessonCheck_(); } catch (e) { Logger.log('実施・欠席のお知らせでエラー: ' + e); } }
    if (typeof wait !== 'number') { try { publishReminder_(); } catch (e) { Logger.log('公開のお知らせでエラー: ' + e); } }
  } finally { lock.releaseLock(); }
}

/* ---------- 教習が終わったら、指導員に「実施・欠席を入力してください」（依頼者指定） ---------- */
// 時限の終わりの時刻（js/config.js の periods と同じ）
const PERIOD_END = [null, '10:40', '11:40', '12:40', '14:20', '15:20', '16:30', '17:30', '18:30', '19:40', '20:40'];
const hm_ = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
// 1分おきに呼ばれる。前回からの間に教習が終わった指導員にはすぐ、それ以外も未入力があれば CHECK_REPEAT_MIN 分おきに通知する
function lessonCheck_() {
  const now = new Date(), today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const nowMin = hm_(Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm'));
  const last = Number(prop('CHECK_LAST') || 0), stamp = Math.floor(now.getTime() / 60000);
  PROPS.setProperty('CHECK_LAST', String(stamp));
  const prevMin = last && stamp - last < 60 * 12 ? nowMin - (stamp - last) : nowMin - 1;   // 前回の時刻（分）。初回や長く止まっていた時は1分前
  const repeat = Number(prop('CHECK_REPEAT_MIN') || 30), hours = (prop('CHECK_HOURS') || '9-21').split('-').map(Number);
  const justEnded = PERIOD_END.map((e, p) => e && hm_(e) > prevMin && hm_(e) <= nowMin ? p : 0).filter(Boolean);
  const inHours = nowMin >= hours[0] * 60 && nowMin < hours[1] * 60 + 60;
  const repeatNow = inHours && Math.floor(nowMin / repeat) !== Math.floor(prevMin / repeat);
  if (!justEnded.length && !repeatNow) return;
  const ended = b => b.date < today || (b.date === today && hm_(PERIOD_END[b.period] || '23:59') <= nowMin);
  const appUrl = prop('APP_URL'), names = {};
  const studentName = tok => {
    if (!(tok in names)) { const s = getDoc_(`students/${tok}`); names[tok] = s ? `${s.name}さん${s.studentNo ? `（${s.studentNo}）` : ''}` : ''; }
    return names[tok];
  };
  let n = 0;
  query_({ from: [{ collectionId: 'instructors' }] }).forEach(ins => {
    const uid = relPath_(ins.name).split('/')[1];
    const all = query_({
      from: [{ collectionId: 'bookings', allDescendants: true }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'instructorUid' }, op: 'EQUAL', value: { stringValue: uid } } },
        { unaryFilter: { field: { fieldPath: 'result' }, op: 'IS_NULL' } },
        { fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'draft' }, { stringValue: 'confirmed' }] } } } }
      ] } }
    }).map(x => Object.assign({ token: relPath_(x.name).split('/')[1] }, x.data));
    // 危険予測・高速教習の組（2〜3時限）は1件にまとめ、最後の時限が終わってから数える
    const list = all.filter((b, i) => !b.pairId || all.findIndex(y => y.token === b.token && y.pairId === b.pairId) === i)
      .map(b => b.pairId ? Object.assign({}, b, { period: Math.min.apply(null, all.filter(y => y.token === b.token && y.pairId === b.pairId).map(y => y.period)),
        last: Math.max.apply(null, all.filter(y => y.token === b.token && y.pairId === b.pairId).map(y => y.period)) }) : Object.assign({ last: b.period }, b))
      .filter(b => ended(Object.assign({}, b, { period: b.last })));
    if (!list.length) return;
    // 今終わった教習がある指導員にはすぐ。それ以外は出し直しの時刻だけ
    const fresh = list.some(b => b.date === today && justEnded.indexOf(b.last) >= 0);
    if (!fresh && !repeatNow) return;
    list.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period);
    const lines = list.slice(0, 4).map(b => `${studentName(b.token)} ${Number(b.date.slice(5, 7))}/${Number(b.date.slice(8))} ${b.period === b.last ? b.period : `${b.period}〜${b.last}`}限`);
    n += deliver_(`instructors/${uid}`, ins.data.fcmTokens, `実施・欠席を入力してください（${list.length}件）`,
      lines.join('、') + (list.length > 4 ? ` ほか${list.length - 4}件` : '') + '。入力するまでお知らせします。', `${appUrl}instructor.html`) ? 1 : 0;
  });
  if (n) Logger.log(`実施・欠席のお知らせ：指導員${n}人に送信`);
}

/* ---------- 水曜日：来週の予定がまだ公開されていない指導員に知らせる（依頼者指定） ---------- */
// 来週の予定は 月〜水曜日のうちに確定（公開）する決まり。確定すると weeks/{uid}_{来週の月曜} ができるので、無い人にだけ送る
// （朝に送った後で確定した人には、夕方は送らない）
function publishReminder_() {
  const now = new Date(), tz = 'Asia/Tokyo';
  if (Utilities.formatDate(now, tz, 'u') !== '3') return;   // 水曜日だけ（u：月=1〜日=7）
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const hours = (prop('PUBLISH_REMIND') || '9,17').split(',').map(Number);
  if (hours.indexOf(hour) < 0) return;
  const key = Utilities.formatDate(now, tz, 'yyyy-MM-dd') + '-' + hour;
  if (prop('PUBLISH_LAST') === key) return;                  // その時刻の分は1回だけ
  PROPS.setProperty('PUBLISH_LAST', key);
  const day = n => new Date(now.getTime() + n * 86400000);
  const mon = Utilities.formatDate(day(5), tz, 'yyyy-MM-dd');  // 来週の月曜（週の確定記録のID）
  const range = `${Utilities.formatDate(day(5), tz, 'M月d日')}〜${Utilities.formatDate(day(11), tz, 'M月d日')}`;
  const last = hour === Math.max.apply(null, hours);
  // 担当の教習生がいる指導員だけ
  const has = {};
  query_({ from: [{ collectionId: 'students' }],
    where: { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: { booleanValue: true } } } })
    .forEach(st => { if (st.data.instructorUid) has[st.data.instructorUid] = true; });
  const appUrl = prop('APP_URL'); let n = 0;
  query_({ from: [{ collectionId: 'instructors' }] }).forEach(ins => {
    const uid = relPath_(ins.name).split('/')[1];
    if (!has[uid] || getDoc_(`weeks/${uid}_${mon}`)) return;
    n += deliver_(`instructors/${uid}`, ins.data.fcmTokens, '来週の予定がまだ公開されていません',
      last ? `本日が締切です。来週（${range}）の予定を、確認してから「確定して通知」で公開してください。`
           : `来週（${range}）の予定は、今日（水曜日）までに自動で割り振り、確認してから「確定して通知」で公開してください。`,
      `${appUrl}instructor.html`) ? 1 : 0;
  });
  Logger.log(`公開のお知らせ（${hour}時）：指導員${n}人に送信`);
}

/* ---------- 毎朝：締切前のお知らせ・期限が近い教習生のお知らせ ---------- */
function dailyReminder() {
  try { inputReminder_(); } catch (e) { Logger.log('締切のお知らせでエラー: ' + e); }
  try { expiryAlert_(); } catch (e) { Logger.log('期限のお知らせでエラー: ' + e); }
  try { kenteiAlert_(); } catch (e) { Logger.log('検定日のお知らせでエラー: ' + e); }
  try { accessCleanup_(); } catch (e) { Logger.log('アクセス記録の削除でエラー: ' + e); }
}
// 古いアクセス記録を、古い順に消す（1回に500件ずつ、最大20回＝1万件まで。残りは翌朝）
function accessCleanup_() {
  const days = Number(prop('ACCESS_KEEP_DAYS') || 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let n = 0;
  for (let i = 0; i < 20; i++) {
    const old = query_({
      from: [{ collectionId: 'access' }],
      where: { fieldFilter: { field: { fieldPath: 'at' }, op: 'LESS_THAN', value: { timestampValue: cutoff } } },
      orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }],
      limit: 500
    });
    if (!old.length) break;
    const r = api_(`${FS_BASE()}:commit`, 'post', { writes: old.map(d => ({ delete: d.name })) });
    if (r.code !== 200) { Logger.log('アクセス記録の削除に失敗: ' + JSON.stringify(r.json)); break; }
    n += old.length;
    if (old.length < 500) break;
  }
  Logger.log(`アクセス記録：${days}日より前の${n}件を削除`);
}
function inputReminder_() {
  const now = new Date(Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy/MM/dd"));
  const std = Number(prop('DEADLINE_DAY') || 20);
  const before = String(prop('REMIND_DAYS') || '3,1').split(',').map(Number);
  const students = query_({
    from: [{ collectionId: 'students' }],
    where: { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: { booleanValue: true } } }
  });
  const appUrl = prop('APP_URL'); let n = 0;
  students.forEach(st => {
    const tok = relPath_(st.name).split('/')[1];
    // 締切は教習生ごと（inputDeadline："p25"＝前の月の25日、"pe"＝前の月の末日、"c3"＝その月の3日。空＝前の月の DEADLINE_DAY 日）
    const v = String(st.data.inputDeadline || ('p' + std));
    [0, 1].forEach(k => {
      const month = new Date(now.getFullYear(), now.getMonth() + k, 1);
      const base = v[0] === 'c' ? month : new Date(month.getFullYear(), month.getMonth() - 1, 1);
      const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      const day = v === 'pe' ? last : Math.min(last, Math.max(1, Number(v.slice(1)) || std));
      const dl = new Date(base.getFullYear(), base.getMonth(), day);
      const left = Math.round((dl - now) / 86400000);
      if (before.indexOf(left) < 0) return;
      const ym = Utilities.formatDate(month, 'Asia/Tokyo', 'yyyy-MM');
      const m = getDoc_(`students/${tok}/months/${ym}`);
      if (m && m.slots && m.slots.length) return;                 // 入力済みの人には送らない
      n += deliver_(`students/${tok}`, st.data.fcmTokens,
        `${month.getMonth() + 1}月分の空き時間を入力してください`,
        `締切は${dl.getMonth() + 1}月${dl.getDate()}日です。空いている時間帯に◯を付けてください。`,
        `${appUrl}student.html?t=${encodeURIComponent(tok)}`) ? 1 : 0;
    });
  });
  Logger.log(`締切のお知らせ：${n}人に送信`);
}
// 教習期限（deadline）・仮免期限（karimenExpiry）の決まった時期（例：2ヶ月前・1ヶ月前・2週間前）に、
// 教習生本人と担当指導員に知らせる。指導員には担当の分を1通にまとめる
// 「○ヶ月前」は期限日と同じ日付の日（その月に同じ日が無い時は月末）、「○週間前」「○日前」は日数で数える
function alertWhen_() {
  return String(prop('EXPIRY_ALERT') || '2m,1m,2w').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const n = parseInt(x, 10), u = x.replace(/[0-9]/g, '');
    return { n: n, u: u, label: u === 'm' ? n + 'ヶ月前' : u === 'w' ? n + '週間前' : n + '日前' };
  });
}
function alertDate_(exp, w) {
  if (w.u === 'm') {
    const y = exp.getFullYear(), m = exp.getMonth() - w.n, last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(exp.getDate(), last));
  }
  return new Date(exp.getFullYear(), exp.getMonth(), exp.getDate() - (w.u === 'w' ? 7 : 1) * w.n);
}
function expiryAlert_() {
  const now = new Date(Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy/MM/dd"));
  const when = alertWhen_();
  const students = query_({
    from: [{ collectionId: 'students' }],
    where: { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: { booleanValue: true } } }
  });
  const appUrl = prop('APP_URL'); const byInst = {}; let ns = 0;
  students.forEach(st => {
    const s = st.data, tok = relPath_(st.name).split('/')[1];
    [['deadline', '教習期限'], ['karimenExpiry', '仮免許の期限']].forEach(([k, label]) => {
      if (!s[k]) return;
      const p = String(s[k]).split('-').map(Number), exp = new Date(p[0], p[1] - 1, p[2]);
      const w = when.find(x => alertDate_(exp, x).getTime() === now.getTime());
      if (!w) return;
      const dateText = `${p[0]}年${p[1]}月${p[2]}日`;
      (byInst[s.instructorUid] = byInst[s.instructorUid] || []).push(`${s.name}（${label} ${p[1]}月${p[2]}日・${w.label}）`);
      ns += deliver_(`students/${tok}`, s.fcmTokens, `${label}が近づいています`,
        `${label}は${dateText}です（${w.label}になりました）。期限までに教習を終えられるよう、空き時間の入力をお願いします。`,
        `${appUrl}student.html?t=${encodeURIComponent(tok)}`) ? 1 : 0;
    });
  });
  let ni = 0;
  Object.keys(byInst).forEach(uid => {
    const path = `instructors/${uid}`, t = getDoc_(path); if (!t) return;
    const list = byInst[uid];
    ni += deliver_(path, t.fcmTokens, `期限が近い教習生が${list.length}件あります`, list.slice(0, 5).join('、') + (list.length > 5 ? ` ほか${list.length - 5}件` : ''), `${appUrl}instructor.html#manage`) ? 1 : 0;
  });
  Logger.log(`期限のお知らせ：教習生${ns}人・指導員${ni}人に送信`);
}

// 検定日の当日の朝に、教習生本人に知らせる（みきわめ合格時に指導員が入れた検定日。mikiwame1／mikiwame2 の kenteiDate）
function kenteiAlert_() {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const students = query_({
    from: [{ collectionId: 'students' }],
    where: { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: { booleanValue: true } } }
  });
  const appUrl = prop('APP_URL'); let n = 0;
  students.forEach(st => {
    const s = st.data, tok = relPath_(st.name).split('/')[1];
    const on = [s.mikiwame1, s.mikiwame2].some(m => m && m.passed && m.kenteiDate === today);
    if (!on) return;
    n += deliver_(`students/${tok}`, s.fcmTokens, '本日はいよいよ検定日です！',
      'これまでに教わった事をよく思い出して頑張りましょう！',
      `${appUrl}student.html?t=${encodeURIComponent(tok)}`) ? 1 : 0;
  });
  Logger.log(`検定日のお知らせ：${n}人に送信`);
}

/* ---------- 動作確認用：自分の端末にテスト通知 ---------- */
// スクリプトプロパティ TEST_UID に自分（指導員）のUIDを入れてから実行する
function testToInstructor() {
  const uid = prop('TEST_UID');
  const t = getDoc_(`instructors/${uid}`);
  Logger.log(t ? deliver_(`instructors/${uid}`, t.fcmTokens, 'テスト通知', '通知が届いていれば設定は完了です', prop('APP_URL') + 'instructor.html') + '件送信' : '指導員が見つかりません');
}
