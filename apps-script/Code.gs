/**
 * 空き時間登録システム 通知係（Google Apps Script）
 *
 * ・processOutbox：5分おきに起動。Firestoreの outbox（送信待ち）を取り出して、プッシュ通知を送る
 * ・dailyReminder：毎朝起動。締切の数日前と前日に、次月分が未入力の教習生だけに通知する
 *                  あわせて、教習期限・仮免期限の2ヶ月前・1ヶ月前・2週間前に、教習生本人と担当指導員に通知する
 *
 * 必要なスクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   PROJECT_ID   … FirebaseのプロジェクトID
 *   SA_EMAIL     … サービスアカウントのメールアドレス（JSONの client_email）
 *   SA_KEY       … サービスアカウントの秘密鍵（JSONの private_key。-----BEGIN から END----- まで丸ごと）
 *   APP_URL      … GitHub Pagesの公開URL（最後に / を付ける）
 *   DEADLINE_DAY … 次月分の入力締切日（例：20）
 *   REMIND_DAYS  … 締切の何日前に知らせるか（カンマ区切り。例：3,1）
 *   EXPIRY_ALERT … 教習期限・仮免期限のいつ知らせるか（カンマ区切り。m＝ヶ月前、w＝週間前、d＝日前。省略時 2m,1m,2w）
 *
 * ※ 秘密鍵はGitHubなど外部に絶対に置かないこと
 */

const PROPS = PropertiesService.getScriptProperties();
const prop = k => PROPS.getProperty(k);
const FS_BASE = () => `https://firestore.googleapis.com/v1/projects/${prop('PROJECT_ID')}/databases/(default)/documents`;

/* ---------- 初回だけ実行：定期実行の設定 ---------- */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processOutbox').timeBased().everyMinutes(5).create();
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
function processOutbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
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
  } finally { lock.releaseLock(); }
}

/* ---------- 毎朝：締切前のお知らせ・期限が近い教習生のお知らせ ---------- */
function dailyReminder() {
  try { inputReminder_(); } catch (e) { Logger.log('締切のお知らせでエラー: ' + e); }
  try { expiryAlert_(); } catch (e) { Logger.log('期限のお知らせでエラー: ' + e); }
}
function inputReminder_() {
  const now = new Date(Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy/MM/dd"));
  const deadline = Number(prop('DEADLINE_DAY') || 20);
  const before = String(prop('REMIND_DAYS') || '3,1').split(',').map(Number);
  const left = deadline - now.getDate();
  if (before.indexOf(left) < 0) return;
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const ym = Utilities.formatDate(next, 'Asia/Tokyo', 'yyyy-MM');
  const students = query_({
    from: [{ collectionId: 'students' }],
    where: { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: { booleanValue: true } } }
  });
  const appUrl = prop('APP_URL'); let n = 0;
  students.forEach(st => {
    const tok = relPath_(st.name).split('/')[1];
    const m = getDoc_(`students/${tok}/months/${ym}`);
    if (m && m.slots && m.slots.length) return;                 // 入力済みの人には送らない
    n += deliver_(`students/${tok}`, st.data.fcmTokens,
      `${next.getMonth() + 1}月分の空き時間を入力してください`,
      `締切は${now.getMonth() + 1}月${deadline}日です。空いている時間帯に◯を付けてください。`,
      `${appUrl}student.html?t=${encodeURIComponent(tok)}`) ? 1 : 0;
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
    ni += deliver_(path, t.fcmTokens, `期限が近い教習生が${list.length}件あります`, list.slice(0, 5).join('、') + (list.length > 5 ? ` ほか${list.length - 5}件` : ''), `${appUrl}manage.html`) ? 1 : 0;
  });
  Logger.log(`期限のお知らせ：教習生${ns}人・指導員${ni}人に送信`);
}

/* ---------- 動作確認用：自分の端末にテスト通知 ---------- */
// スクリプトプロパティ TEST_UID に自分（指導員）のUIDを入れてから実行する
function testToInstructor() {
  const uid = prop('TEST_UID');
  const t = getDoc_(`instructors/${uid}`);
  Logger.log(t ? deliver_(`instructors/${uid}`, t.fcmTokens, 'テスト通知', '通知が届いていれば設定は完了です', prop('APP_URL') + 'instructor.html') + '件送信' : '指導員が見つかりません');
}
