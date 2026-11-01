// 共通部品：Firebaseの初期化、日付、画面の小物、プッシュ通知
import { initializeApp } from "./backend.js";
import { getFirestore, doc, addDoc, updateDoc, collection, serverTimestamp } from "./backend.js";
import { getMessaging, getToken, isSupported, onMessage } from "./backend.js";

export { DEMO, DEMO_USERS, DEMO_STUDENTS, resetDemo } from "./backend.js";
import { DEMO } from "./backend.js";
export const CFG = self.APP_CONFIG;
// 大元の管理画面は、ログインの保存場所を指導員の画面と分ける（Firebase のアプリ名を変える）。
// 同じブラウザで管理画面と指導員の画面を別のアカウントで開いても、片方がもう片方をログアウトさせないため
export const app = document.body && document.body.dataset.mode === "admin" ? initializeApp(CFG.firebase, "admin") : initializeApp(CFG.firebase);
export const db = getFirestore(app);
self.__boot && self.__boot.push("common");
export const WD = ["日", "月", "火", "水", "木", "金", "土"];
export const P = CFG.periods;

/* ---------- 日付 ---------- */
export const pad = n => String(n).padStart(2, "0");
export const ymOf = (y, m) => `${y}-${pad(m)}`;                      // m は 1〜12
export const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
export const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
export const daysIn = (y, m) => new Date(y, m, 0).getDate();
export const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
export const md = s => { const d = parseDate(s); return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };
export const label = (s, p) => `${md(s)} ${p}限`;
export const slotKey = (day, p) => `${day}-${p}`;                    // 月ごとの空き時間の保存キー

/* ---------- 教習の進み具合（何時限目か） ---------- */
// 実施済み＝priorDone（このシステムを使う前の分。管理画面で入力）＋ doneCount（実施チェックの分）
// まだ実施チェックの済んでいない予約を日時の順に並べて、何時限目になるかを数える
// 危険予測は2時限で1つと数える。単独高速は2時限として数える
// 最低教習時限。第1段階は教習生ごとに変えられる（students/{t}.minLessons1。空なら config の値）
export const lessonMin = (stage, st) => (stage === 1 && st && +st.minLessons1) || ((CFG.lessons || {})[stage] || {}).min || 0;
export const kikenNoOf = stage => ((CFG.lessons || {})[stage] || {}).kikenNo || 0;
export const hwNoOf = stage => ((CFG.lessons || {})[stage] || {}).hwNo || 0;
// 高速教習は「単独高速（2時限）」か「高速教習（3時限）」。古いデータの highway:true だけの予約も高速として扱う
export const isHwType = t => t === "hwSolo" || t === "hw3";
const UNITS = { hwSolo: 2, hw3: 3 };   // 時限数として数える数（危険予測は2時限で1つ）
// 何時限目かの表示（2時限なら「13・14」、3時限なら「13〜15」）
export const noRange = it => it.units === 1 ? `${it.no}` : it.units === 2 ? `${it.no}・${it.no + 1}` : `${it.no}〜${it.no + it.units - 1}`;
export const doneOf = st => (st.priorDone || 0) + (st.doneCount || 0);
export const bookingEnd = b => { const [h, m] = P[b.period][1].split(":").map(Number); const d = parseDate(b.date); d.setHours(h, m); return d; };
// 予約の一覧を「教習1つ」ごとにまとめる（2時限連続の教習は1つにまとめる）
export function lessonItems(list) {
  const items = [], byPair = {};
  [...list].sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period).forEach(b => {
    if (b.pairId && byPair[b.pairId]) { byPair[b.pairId].bookings.push(b); return; }
    const it = { date: b.date, period: b.period, lessonType: b.lessonType || "", highway: !!b.highway, bookings: [b], units: UNITS[b.lessonType] || 1 };
    if (b.pairId) byPair[b.pairId] = it;
    items.push(it);
  });
  return items;
}
// 予定の教習に番号を付ける。ok:false は危険予測の順番がずれている
export function lessonPlan(st, pending) {
  const items = lessonItems(pending); let n = doneOf(st);
  items.forEach(it => { it.no = n + 1; n += it.units; });
  const K = kikenNoOf(st.stage);
  let ok = true, reason = "";
  if (K && !st.kikenDone) {
    const kk = items.filter(it => it.lessonType === "kiken");
    const at = items.find(it => it.no <= K && K < it.no + it.units);
    if (kk.some(it => it.no !== K)) { ok = false; reason = `${(CFG.kiken || {}).label || "危険予測"}が${kk.find(it => it.no !== K).no}時限目になっています（${K}時限目のみ）`; }
    else if (at && at.lessonType !== "kiken") { ok = false; reason = `${K}時限目は${(CFG.kiken || {}).label || "危険予測"}です（今は${at.lessonType ? "別の教習" : "通常の教習"}が入っています）`; }
    else if (!at && doneOf(st) >= K) { ok = false; reason = `${(CFG.kiken || {}).label || "危険予測"}を受けないまま${K}時限を超えています`; }
  }
  // 高速教習はちょうど hwNo 時限目（第2段階13時限目）から。単独高速なら13・14、3時限なら13〜15
  const H = hwNoOf(st.stage);
  if (ok && H && !st.hwDone) {
    const isHw = it => isHwType(it.lessonType) || (it.highway && !it.lessonType);
    const hh = items.filter(it => isHwType(it.lessonType));
    const at = items.find(it => it.no <= H && H < it.no + it.units);
    if (hh.some(it => it.no !== H)) { ok = false; reason = `高速教習が${hh.find(it => it.no !== H).no}時限目になっています（${H}時限目からのみ）`; }
    else if (at && !isHw(at)) { ok = false; reason = `${H}時限目は高速教習です（今は${at.lessonType ? "別の教習" : "通常の教習"}が入っています）`; }
    else if (!at && doneOf(st) >= H) { ok = false; reason = `高速教習を受けないまま${H}時限を超えています`; }
  }
  return { items, total: n, ok, reason };
}
// 次に入れる教習（今の予約のいちばん後ろ）が、危険予測や高速教習の番か。"kiken"／"hw"／""
export function nextSpecial(st, pending) {
  const next = lessonPlan(st, pending).total + 1;
  if (kikenNoOf(st.stage) === next && !st.kikenDone) return "kiken";
  if (hwNoOf(st.stage) === next && !st.hwDone) return "hw";
  return "";
}

// みきわめ：その段階の最低教習時限（第1段階12・第2段階19）の教習。合格するまでは、それ以降の教習もみきわめとして扱う
// 記録は段階ごとに mikiwame1 / mikiwame2 ＝ { passed, date, bookingIds, kenteiDate, kenteiUndecided, gakkaDone }
export const mikiwameOf = (st, stage = st.stage) => st[`mikiwame${stage}`] || null;
export function isMikiwame(st, it) {
  const min = lessonMin(st.stage, st), mk = mikiwameOf(st);
  return !!min && it.no + it.units - 1 >= min && !(mk && mk.passed);
}
// 今日が検定日か（段階を切り替えた後でも分かるよう、両方の段階を見る）
export const kenteiOn = (st, ds = dateStr(today())) => [1, 2].some(n => { const m = st[`mikiwame${n}`]; return m && m.passed && m.kenteiDate === ds; });
// 空き時間の入力締切（教習生ごと）。students/{t}.inputDeadline："p25"＝前の月の25日、"pe"＝前の月の末日、"c3"＝その月の3日。空＝毎月 deadlineDay 日（前の月）
export function inputDeadlineOf(st, ym) {
  const v = String((st && st.inputDeadline) || `p${CFG.deadlineDay}`);
  const [y, m] = ym.split("-").map(Number);
  const [yy, mm] = v[0] === "c" ? [y, m] : m === 1 ? [y - 1, 12] : [y, m - 1];
  const last = daysIn(yy, mm), d = v === "pe" ? last : Math.min(last, Math.max(1, +v.slice(1) || CFG.deadlineDay));
  return `${yy}-${pad(mm)}-${pad(d)}`;
}
export const pastInputDeadline = (st, ym, on = dateStr(today())) => on > inputDeadlineOf(st, ym);
export function inputDeadlineText(st) {
  const v = (st && st.inputDeadline) || "";
  if (!v) return `前の月の${CFG.deadlineDay}日（標準）`;
  return v === "pe" ? "前の月の末日" : v[0] === "c" ? `その月の${+v.slice(1)}日` : `前の月の${+v.slice(1)}日`;
}
export const kenteiText = mk => !mk || !mk.passed ? "" : mk.kenteiDate ? md(mk.kenteiDate) : "未確定";

// 生年月日（YYYY-MM-DD）から今日時点の年齢（○歳○ヶ月）。誕生日が来ると自動で上がる
export function ageOf(birth, on = today()) {
  if (!birth) return null;
  const b = parseDate(birth);
  let m = (on.getFullYear() - b.getFullYear()) * 12 + (on.getMonth() - b.getMonth());
  if (on.getDate() < b.getDate()) m--;
  return m < 0 ? null : { y: Math.floor(m / 12), m: m % 12, months: m };
}
// 卒業検定の期限：第2段階のみきわめに合格した日から3ヶ月（その日を1日目に数えて、3ヶ月後の同じ日の前日まで。依頼者指定）
export const kentei2Limit = st => { const m = st && st.mikiwame2; return m && m.passed && m.date ? karimenExpiryOf(m.date, CFG.kentei2LimitMonths || 3) : null; };
export const kentei2LimitNg = (limit, date) => limit && date && date > limit
  ? `検定日（${md(date)}）が、みきわめに合格した日から${CFG.kentei2LimitMonths || 3}ヶ月を超えています。卒業検定は ${md(limit)} までに受けなければなりません。日付を入れ直してください。` : "";
// 検定期限が迫っている（kentei2LimitWarnDays 日以内）第2段階の教習生。検定に合格した人は除く
export const kentei2Soon = st => {
  const lim = kentei2Limit(st); if (!lim || st.stage !== 2 || st.graduatedOn || (st.mikiwame2 || {}).kenteiResult === "pass") return null;
  const days = Math.round((parseDate(lim) - today()) / 86400000);
  return days <= (CFG.kentei2LimitWarnDays || 30) ? { limit: lim, days } : null;
};
export const KENTEI2_MSG = "みきわめに合格した日から3か月間が検定期限です。この期限を過ぎると、検定は受けられません";
// 第1段階の検定日が18歳の誕生日より前なら、警告の文を返す（誕生日当日は受けられる。2月29日生まれは平年は3月1日）
export function kentei1AgeNg(birth, date) {
  const n = CFG.kentei1MinAge || 18;
  if (!birth || !date) return "";
  const y = +birth.slice(0, 4) + n, leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const bd = birth.slice(5) === "02-29" && !leap ? `${y}-03-01` : `${y}${birth.slice(4)}`;
  return date < bd ? `検定日（${md(date)}）は${n}歳の誕生日（${y}年${md(bd)}）より前です。${n}歳になる前は第1段階の検定を受けられません。` : "";
}
export const ageText = birth => { const a = ageOf(birth); return a ? `${a.y}歳${a.m}ヶ月` : ""; };

// 仮免期限日：交付日の「○ヶ月後の同じ日」の前日（同じ日が無い月はその月の末日）
export function karimenExpiryOf(issued, months = CFG.karimenMonths || 6) {
  if (!issued) return "";
  const d = parseDate(issued), y = d.getFullYear(), m = d.getMonth() + months, last = new Date(y, m + 1, 0).getDate();
  const e = d.getDate() > last ? new Date(y, m, last) : addDays(new Date(y, m, d.getDate()), -1);
  return dateStr(e);
}
// 日没が早い期間か（config の darkSeason。年をまたぐ指定もOK）
export function inDarkSeason(ds) {
  const k = ds.slice(5), { from, to } = CFG.darkSeason || {};
  if (!from) return false;
  return from <= to ? (k >= from && k <= to) : (k >= from || k <= to);
}
// その日の空き時限 ps で高速教習（3時限か単独高速2時限）を入れられる組があるか。日没の警告つきの組は「入れられる」扱い（強制で入れられるため）
export function hwPossible(ds, ps) {
  const has = set => set.every(p => ps.includes(p)), dark = inDarkSeason(ds), dk = CFG.darkSeason || {};
  if ((CFG.highwaySets || []).some(has)) return true;
  for (let a = 1; a < 10; a++) {
    const set = [a, a + 1];
    if ((CFG.hwSolo || {}).noPairAfter && CFG.hwSolo.noPairAfter.includes(a)) continue;
    if (dark && (dk.hwSoloNo || []).some(x => x[0] === a && x[1] === a + 1)) continue;
    if (has(set)) return true;
  }
  return false;
}
// 教習生の◯（{ "YYYY-MM": Set("日-時限") }）で、今日から何日間、高速教習を入れられないか。入れられる日が1年見つからなければ Infinity、◯が無ければ null
// ◯を登録した月はその◯で、その先は登録した最後の月の曜日ごとの◯で見積もる
export function hwWaitDays(avail, from = today()) {
  const months = Object.keys(avail).filter(k => avail[k] && avail[k].size).sort();
  if (!months.length) return null;
  const last = months[months.length - 1], pat = {}, byDay = {};
  Object.keys(avail).forEach(ym => (avail[ym] ? [...avail[ym]] : []).forEach(k => {
    const [d, p] = k.split("-").map(Number), ds = `${ym}-${pad(d)}`;
    (byDay[ds] = byDay[ds] || []).push(p);
    if (ym === last) { const w = parseDate(ds).getDay(); (pat[w] = pat[w] || new Set()).add(p); }
  }));
  // ◯の日はあるのに高速教習が入らない（夜だけなど、時間帯のせい）時だけ数える。◯の日そのものが少ないだけなら 0（案内しない）
  let unusable = false;
  for (let i = 0; i <= 366; i++) {
    const d = addDays(from, i), ds = dateStr(d), ym = ds.slice(0, 7);
    const ps = ym <= last ? byDay[ds] || [] : [...(pat[d.getDay()] || [])];
    if (ps.length && hwPossible(ds, ps)) return unusable ? i : 0;
    if (ps.length) unusable = true;
  }
  return Infinity;
}
// このペースで期限に間に合うか（技能開始日（空なら教習開始日）から paceMinDays 日以上たった人）。
// これまでの1日あたりの時限数で残りを割って見込みの日を出し、教習期限（第2段階は仮免期限も）より後なら返す
export function paceOf(st, on = today()) {
  const start = st.skillStart || st.startDate;
  if (!start) return null;
  const days = Math.round((on - parseDate(start)) / 864e5);
  if (days < (CFG.paceMinDays || 30)) return null;
  const min1 = lessonMin(1, st), min2 = lessonMin(2, st), done = doneOf(st);
  const remain = st.stage === 1 ? Math.max(0, min1 - done) + min2 : Math.max(0, min2 - done);
  if (!remain) return null;
  const rate = (st.stage === 1 ? done : min1 + done) / days;
  const eta = rate > 0 ? dateStr(addDays(on, Math.ceil(remain / rate))) : null;
  const lim = [["教習期限", st.deadline], ...(st.stage === 2 ? [["仮免期限", st.karimenExpiry]] : [])].filter(x => x[1]).sort((a, b) => a[1].localeCompare(b[1]));
  const over = lim.find(([, d]) => !eta || eta > d);
  return over ? { eta, remain, label: over[0], date: over[1] } : null;
}
export const paceText = pc => `このペースでは${pc.label}（${md(pc.date)}）に間に合いません（${pc.eta ? `見込み ${md(pc.eta)}` : "まだ受講がありません"}・残り${pc.remain}時限）`;
// 教習期限・仮免期限が近い（または過ぎた）もの。days：あと何日（マイナスは過ぎた日数）
export function expiriesOf(st, within = CFG.expiryWarnDays || 30) {
  const t = today(), out = [];
  [["deadline", "教習期限"], ["karimenExpiry", "仮免期限"]].forEach(([k, label]) => {
    if (!st[k]) return;
    const days = Math.round((parseDate(st[k]) - t) / 86400000);
    if (days <= within) out.push({ key: k, label, date: st[k], days });
  });
  return out;
}
export const expiryText = e => `${e.label} ${md(e.date)}（${e.days < 0 ? `${-e.days}日過ぎています` : e.days === 0 ? "今日まで" : `あと${e.days}日`}）`;
// フリガナ：ひらがなはカタカナに直す。カタカナ・長音・空白・中点だけを受け付ける
// 全角の数字を半角に（教習生番号など）
export const toHalfDigits = s => String(s || "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
export const toKatakana = s => String(s || "").replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/\s+/g, " ").trim();
export const isKatakana = s => /^[\u30A1-\u30FA\u30FC\u30FB 　]+$/.test(s);

/* ---------- 画面の小物 ---------- */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
export function toast(t) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = t; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 3000);
}
// opts.notice：お知らせ（画面の真ん中に出す。下のタブと重ならないように）
export function sheet(html, opts = {}) {
  let ov = document.getElementById("overlay");
  if (!ov) { ov = document.createElement("div"); ov.id = "overlay"; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="sheet-bg${opts.notice ? " mid notice" : ""}" data-act="close"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
}
// いまお知らせ以外のシート（入力中の画面など）が開いているか
export const busySheet = () => !!document.querySelector("#overlay .sheet-bg:not(.notice)");
export function closeSheet() { const ov = document.getElementById("overlay"); if (ov) ov.innerHTML = ""; }
export function onOverlayClose(e) {
  const t = e.target.closest('[data-act="close"]');
  if (t && (e.target === t || t.tagName === "BUTTON")) { closeSheet(); return true; }
  return false;
}
// 索引が無い時のエラーに入っている「索引を作る」リンク（Firebaseコンソール）を取り出す
export const indexLinkOf = e => { const m = String(e && e.message || "").match(/https:\/\/console\.firebase\.google\.com\S+/); return m ? m[0] : ""; };
// 通知の送信待ち（outbox）を書いた直後に呼ぶ。Apps Script にすぐ送ってもらう（失敗しても1分おきの定期送信で届く）
export function sendNow() {
  if (DEMO || !CFG.sendNowUrl) return;
  try { fetch(CFG.sendNowUrl, { method: "POST", mode: "no-cors", body: "send", keepalive: true }).catch(() => { }); } catch (e) { }
}
export function friendlyError(e) {
  console.error(e);
  const c = e && e.code || "";
  if (c.includes("permission-denied")) return "権限がありません。事務所にお問い合わせください。";
  if (c.includes("unavailable")) return "通信できませんでした。電波の良い場所でもう一度お試しください。";
  if (c.includes("failed-precondition")) return "準備中のデータがあります（索引の作成待ち）。数分後にもう一度お試しください。";
  return "エラーが起きました。もう一度お試しください。";
}

/* ---------- プッシュ通知 ---------- */
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// 通知を有効にして、端末のトークンを saveToken に渡す
export async function enablePush(saveToken) {
  if (DEMO) return { ok: false, reason: "demo" };
  if (isIOS() && !isStandalone()) return { ok: false, reason: "ios-home" };
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return { ok: false, reason: "unsupported" };
  // iPhoneは、ボタンを押した直後に許可を求めないと確認画面が出ない（ほかの処理を待った後だと無視される）。だから最初に聞く
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "denied" };
  if (!(await isSupported())) return { ok: false, reason: "unsupported" };
  const reg = await navigator.serviceWorker.register("./firebase-messaging-sw.js", { scope: "./" });
  await navigator.serviceWorker.ready;
  const messaging = getMessaging(app);
  const token = await getToken(messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
  if (!token) return { ok: false, reason: "no-token" };
  await saveToken(token);
  try { localStorage.setItem("timetable_push_on", "1"); } catch (e) { }
  listenForeground();
  return { ok: true };
}
let listening = false;
export async function listenForeground(onMsg) {
  if (DEMO) return;
  if (listening || !(await isSupported())) return;
  listening = true;
  onMessage(getMessaging(app), p => {
    const n = p.notification || {};
    toast(`${n.title || "お知らせ"}：${n.body || ""}`);
    if (onMsg) onMsg(p);
  });
}
// この端末の通知の状態（設定画面に出す）
export function pushStatusHtml() {
  if (DEMO) return "";
  let t, cls = "wait";
  if (!("Notification" in window)) t = isIOS() && !isStandalone() ? "ホーム画面に追加したアイコンから開くと、通知を設定できます" : "この端末・ブラウザは通知に対応していません";
  else if (Notification.permission === "denied") t = "通知がブロックされています。端末の設定で、このアプリの通知をオンにしてください";
  else if (Notification.permission === "granted") { let on = false; try { on = !!localStorage.getItem("timetable_push_on"); } catch (e) { } t = on ? "通知オン（この端末に届きます）" : "許可済みです。下のボタンをもう一度押すと設定が終わります"; cls = on ? "ok" : "wait"; }
  else t = "まだ設定していません。下のボタンを押してください";
  return `<div class="pushst"><span class="tag ${cls}">この端末</span> ${esc(t)}</div>`;
}
export function pushReasonText(r) {
  return {
    "ios-home": "iPhoneでは、まず画面下の共有ボタン →「ホーム画面に追加」をして、ホーム画面のアイコンから開き直してください。",
    "unsupported": "この端末・ブラウザは通知に対応していません。iPhoneはiOS 16.4以降が必要です。",
    "denied": "通知が許可されませんでした。端末の設定から、このアプリの通知をオンにしてください。",
    "no-token": "通知の準備ができませんでした。時間をおいてもう一度お試しください。",
    "demo": "通知はまだ準備中です。Firebaseの設定が終わると、スマホに届くようになります。"
  }[r] || "通知を有効にできませんでした。";
}

/* ---------- ホーム画面に追加（Webアプリとして使う） ---------- */
// QRから初めて開いた時に、ホーム画面への追加方法を1回だけ案内する。その後は「ホーム画面に追加」ボタンから開ける
// Android（Chrome）はボタン1つで追加できる。iPhoneは共有ボタンからの手順を案内する
let installEvt = null;
if (typeof window !== "undefined") {
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });
  addEventListener("appinstalled", () => { installEvt = null; closeSheet(); toast("ホーム画面に追加しました"); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./firebase-messaging-sw.js", { scope: "./" }).catch(() => { });
}
export const canInstall = () => !isStandalone();
export const installButton = () => canInstall() ? `<button class="linkbtn" data-act="install">ホーム画面に追加</button>` : "";
export function installSheet(kind) {
  const what = kind === "student" ? "空き時間の登録" : "予約の割り当て";
  const after = kind === "student"
    ? "追加したアイコンから開くと、次からはQRコードを読み取らなくても、すぐに自分の画面が開きます。"
    : "追加したアイコンから開くと、次からはQRコードを読み取らなくても、すぐに指導員の画面が開きます。";
  let how;
  if (installEvt) how = `<button class="btn primary full" data-act="installNow">ホーム画面に追加する</button>`;
  else if (isIOS()) how = `<ol style="padding-left:20px;margin:0 0 6px;font-size:14px;line-height:1.8"><li>Safariの画面下にある <b>共有ボタン</b>（四角から矢印が出ているマーク）をタップ</li><li>メニューの中の <b>「ホーム画面に追加」</b> をタップ</li><li>右上の <b>「追加」</b> をタップ</li></ol>
    <p style="font-size:13px;color:var(--muted);margin:0">iPhoneでは、ホーム画面に追加したアイコンから開いた時だけ、プッシュ通知を受け取れます。</p>`;
  else how = `<p style="font-size:14px">ブラウザのメニュー（右上の︙）から <b>「ホーム画面に追加」</b> または <b>「アプリをインストール」</b> を選んでください。</p>`;
  sheet(`<h3>ホーム画面に追加しましょう</h3><p style="font-size:14px">この画面を、アプリのようにホーム画面から開けるようになります（${what}）。${after}</p>
    ${how}<button class="btn full" style="margin-top:10px" data-act="close">あとで</button>`);
}
// 初めて開いた時だけ自動で案内する（ホーム画面から開いている時、並べて確認するページの中では出さない）
export function firstVisitInstall(kind) {
  if (!canInstall() || window.top !== window) return;
  const key = `timetable_install_shown_${kind}`;
  try { if (localStorage.getItem(key)) return; } catch (e) { return; }
  // ほかの案内（次の教習など）が出ている時は、次に開いた時に回す
  // お知らせなど、ほかの案内が出ている間は待って、閉じたら出す
  const tryShow = (n = 0) => { if (document.querySelector("#overlay .sheet")) { if (n < 300) setTimeout(() => tryShow(n + 1), 1000); return; } try { localStorage.setItem(key, "1"); } catch (e) { } installSheet(kind); };
  setTimeout(tryShow, 1200);
}
if (typeof document !== "undefined") document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  if (t.dataset.act === "install") installSheet(document.body.dataset.app || "student");
  else if (t.dataset.act === "installNow" && installEvt) {
    const ev = installEvt; installEvt = null;
    await ev.prompt(); const r = await ev.userChoice.catch(() => null);
    if (!r || r.outcome !== "accepted") installSheet(document.body.dataset.app || "student");
  }
});

/* ---------- PC表示とスマホ表示（管理画面） ---------- */
// 幅1024px以上ならPC表示。画面の切り替えボタンで固定もできる（この端末に覚える）
const VIEW_KEY = "timetable_view";
export function isPC() {
  let v = null; try { v = localStorage.getItem(VIEW_KEY); } catch (e) { }
  if (v === "pc") return true; if (v === "sp") return false;
  return typeof matchMedia !== "undefined" && matchMedia("(min-width: 1024px)").matches;
}
export const applyView = () => document.body.classList.toggle("pc", isPC());
// 表示の切り替え：auto（幅で自動）／pc／sp。設定画面から変える
export const getViewMode = () => { try { return localStorage.getItem(VIEW_KEY) || "auto"; } catch (e) { return "auto"; } };
export function setViewMode(v) {
  try { v === "auto" ? localStorage.removeItem(VIEW_KEY) : localStorage.setItem(VIEW_KEY, v); } catch (e) { }
  document.dispatchEvent(new Event("view:change"));
}
export const viewToggle = () => `<button class="linkbtn noprint" data-act="toggleView">${isPC() ? "スマホ表示にする" : "PC表示にする"}</button>`;
// active：その画面が今見えているか（指導員の画面の中の「教習生の管理」は、開いている間だけPC表示にする）
export function onViewChange(cb, active = () => true) {
  const apply = () => active() ? applyView() : document.body.classList.remove("pc");
  apply();
  matchMedia("(min-width: 1024px)").addEventListener("change", () => { apply(); if (active()) cb(); });
  document.addEventListener("view:change", () => { apply(); if (active()) cb(); });
  document.addEventListener("click", e => {
    if (!e.target.closest('[data-act="toggleView"]') || !active()) return;
    try { localStorage.setItem(VIEW_KEY, isPC() ? "sp" : "pc"); } catch (err) { }
    apply(); cb();
  });
}
// PC表示の表：列の定義から作る。並べ替えは見出しをクリック
// rowClass：行ごとに付けるクラス（例：期限が迫っている教習生を赤く点滅）
export function pcTable(cols, rows, sort, rowClass) {
  const sorted = [...rows];
  if (sort && sort.k) {
    const c = cols.find(x => x.k === sort.k), val = r => c.sort ? c.sort(r) : (c.v ? c.v(r) : r[c.k]);
    const empty = v => v === null || v === undefined || v === "";
    sorted.sort((a, b) => {
      const x = val(a), y = val(b);
      if (empty(x) || empty(y)) return empty(x) - empty(y);      // 空の値は、昇順でも降順でも最後
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ja")) * (sort.dir || 1);
    });
  }
  return `<div class="pctable"><table class="adm"><thead><tr>${cols.map(c => `<th>${c.k && c.nosort !== true ? `<button class="th" data-act="sort" data-k="${c.k}">${c.t}${sort && sort.k === c.k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</button>` : c.t}</th>`).join("")}</tr></thead>
  <tbody>${sorted.map(r => `<tr${rowClass && rowClass(r) ? ` class="${rowClass(r)}"` : ""}>${cols.map(c => `<td>${c.html ? c.html(r) : esc(c.v ? c.v(r) : r[c.k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
export const nextSort = (sort, k) => sort.k === k ? { k, dir: -sort.dir } : { k, dir: 1 };

/* ---------- 端末ごとの設定（この端末のブラウザに覚える） ---------- */
// 画面の明るさ（light／dark／system）と文字の大きさ（normal／large）。読み込み直後の反映は boot.js がする
export function getPref(k, def) { try { return localStorage.getItem("timetable_" + k) || def; } catch (e) { return def; } }
export function setPref(k, v) { try { localStorage.setItem("timetable_" + k, v); } catch (e) { } }
export function applyLook() {
  const r = document.documentElement, th = getPref("theme", "system"), fs = getPref("fontsize", "normal");
  if (th === "light" || th === "dark") r.dataset.theme = th; else delete r.dataset.theme;
  if (fs === "large") r.dataset.fs = "large"; else delete r.dataset.fs;
}
// 設定画面の「見た目」の部分（管理画面と指導員の画面で共通）
const choice = (k, v, cur, t) => `<button class="chip" aria-pressed="${cur === v}" data-act="pref" data-k="${k}" data-v="${v}">${t}</button>`;
export function lookSettingsHtml({ view = true } = {}) {
  const th = getPref("theme", "system"), fs = getPref("fontsize", "normal"), vm = getViewMode();
  return `<div class="setgrp"><h3>画面の明るさ</h3><div class="chips wrapchips">${choice("theme", "light", th, "ライト（明るい）")}${choice("theme", "dark", th, "ダーク（暗い）")}${choice("theme", "system", th, "スマホ・PCの設定に合わせる")}</div></div>
  <div class="setgrp"><h3>文字の大きさ</h3><div class="chips wrapchips">${choice("fontsize", "normal", fs, "標準")}${choice("fontsize", "large", fs, "大きめ")}</div></div>
  ${view ? "" : "<!--"}<div class="setgrp"><h3>表示</h3><div class="chips wrapchips">${choice("view", "auto", vm, "自動（画面の幅で切り替え）")}${choice("view", "pc", vm, "いつもPC表示")}${choice("view", "sp", vm, "いつもスマホ表示")}</div></div>${view ? "" : "-->"}`;
}
// 設定のボタン。変えたら "pref:change" を出すので、各画面は描き直す
if (typeof document !== "undefined") document.addEventListener("click", e => {
  const t = e.target.closest('[data-act="pref"]'); if (!t) return;
  const { k, v } = t.dataset;
  if (k === "view") setViewMode(v); else setPref(k, v);
  applyLook();
  document.dispatchEvent(new CustomEvent("pref:change", { detail: { k, v } }));
});

/* ---------- アクセス記録（管理画面の「アクセス記録」で見る） ---------- */
// アプリを開いた時と、ホーム画面などから10分以上たって戻ってきた時に1件ずつ残す（access コレクション）
// kind："student"（who＝QRのキー）／"instructor"（who＝ユーザーUID）。あわせて本人のドキュメントに最後に開いた日時（lastAccessAt）を書く
// 古い記録は Apps Script が毎朝消す（ACCESS_KEEP_DAYS 日より前。省略時90日）
export const deviceName = () => {
  const u = navigator.userAgent;
  const d = /iPhone/.test(u) ? "iPhone" : /iPad|Macintosh/.test(u) && navigator.maxTouchPoints > 1 ? "iPad" : /Android/.test(u) ? "Android" : "PC";
  return `${d}・${isStandalone() ? "ホーム画面" : "ブラウザ"}`;
};
let accessAt = 0, accessWho = null, accessKind = "", accessIu = "", accessListening = false;
function logAccess() {
  if (!accessWho || Date.now() - accessAt < 10 * 60 * 1000) return;
  accessAt = Date.now();
  const rec = { kind: accessKind, who: accessWho, at: serverTimestamp(), device: deviceName() };
  if (accessIu) rec.iu = accessIu;   // 教習生の記録には担当指導員を入れる（指導員が自分の担当の分を見られるように）
  addDoc(collection(db, "access"), rec).catch(() => { });
  updateDoc(doc(db, accessKind === "student" ? "students" : "instructors", accessWho), { lastAccessAt: serverTimestamp() }).catch(() => { });
}
export function trackAccess(kind, who, iu = "") {
  if (!who || window.top !== window) return;   // 確認用ページ（iframe）の中では残さない
  if (who !== accessWho) accessAt = 0;
  accessKind = kind; accessWho = who; accessIu = iu || "";
  logAccess();
  if (!accessListening) { accessListening = true; document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") logAccess(); }); }
}

/* ---------- アプリを開いた時のお知らせ（教習生・指導員共通の見出し） ---------- */
// あいさつ：3時〜12時「おはようございます！」、12時〜18時「こんにちは！」、18時〜翌3時「こんばんは！」
export function greeting(d = new Date()) {
  const h = d.getHours();
  return h >= 3 && h < 12 ? "おはようございます！" : h >= 12 && h < 18 ? "こんにちは！" : "こんばんは！";
}
// お知らせの見出し（学園のマークを上に出す）
// 学園のマークを3Dで横に回す（起動時の読み込み画面と同じ作り。ロゴを0.5pxずつずらして9枚重ねて厚みを出す）
export const spinLogo = (cls = "") => `<div class="sp-stage ${cls}" aria-hidden="true"><div class="sp-logo">${Array.from({ length: 9 }, (_, i) => `<img src="img/logo.png" alt="" class="${i === 0 || i === 8 ? "" : "edge"}" style="--z:${(i - 4) * 0.5}px">`).join("")}</div></div>`;
export const noticeHead = (title = "お知らせ") => `<div class="notice-head">${spinLogo("notice-logo")}<h3>${title}</h3></div>`;

/* ---------- お知らせの履歴（「お知らせ」タブ） ---------- */
// 新しく出たお知らせの項目を、その端末に保存する（同じ項目は1回だけ。新しい順に最大200件）。0件の時は何も保存しない
export const mdS = ds => { const d = parseDate(ds); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };   // 例 10/29(木)
const histKey = scope => `timetable_notices_${scope}`;
export function noticeHistory(scope) { try { return JSON.parse(localStorage.getItem(histKey(scope)) || "[]"); } catch (e) { return []; } }
export function saveNotices(scope, items) {
  if (!items.length) return;
  const list = noticeHistory(scope), have = new Set(list.map(x => x.key)), now = Date.now();
  const add = items.filter(x => !have.has(x.key)).map(x => ({ key: x.key, html: x.html, at: now }));
  if (!add.length) return;
  try { localStorage.setItem(histKey(scope), JSON.stringify([...add, ...list].slice(0, 200))); } catch (e) { }
}
export function noticeHistoryHtml(scope) {
  const list = noticeHistory(scope);
  if (!list.length) return `<p style="color:var(--muted)">まだお知らせはありません。アプリを開いた時に出たお知らせが、ここに新しい順に残ります。</p>`;
  const dt = ms => { const d = new Date(ms), p2 = n => String(n).padStart(2, "0"); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  return `<ul class="notice-list hist-list">${list.map(x => `<li><span class="nwhen">${dt(x.at)}</span>${x.html}</li>`).join("")}</ul>
    <p class="setnote">この端末に、新しい順に最大200件残します。</p>`;
}
// お知らせの1行（種類の札＋内容）
export const noticeRow = (tag, text, cls = "") => `<span class="ntag ${cls}">${tag}</span><span class="ntext">${text}</span>`;

// ---------- 進み具合の横棒グラフ（指導員の「教習生の管理」と教習生の画面で共通。依頼者指定） ----------
// 1段目が第1段階（青）、2段目が第2段階（緑）。1マス＝1時限で、受けた分を塗り、予約済みの分は斜線、次の教習のマスに枠。
// 最低時限を超えた分（延長）はオレンジ。最低時限の最後のマスは幅を広げて「みきわめ」と書く。
// 段階の右端に検定の旗（合格＝塗り、検定日が決まっている＝色付きの枠、まだ＝灰色）。上に「第1段階 8/12」と検定日、
// 下に開始・仮免期限・教習期限。日付は「○年○月○日」
// o.kentei："staff"（検定日と予定の検定日を出す）／"student"（みきわめ合格の検定日だけ）／なし（出さない。管理画面）
// o.next：次の教習の文（例「2026年11月4日 5限」「未定」）。今の位置のマスの下に「↑」で出す。o.booked：予約済みの時限数。o.big：大きく
export const longDate = d => d ? `${+d.slice(0, 4)}年${+d.slice(5, 7)}月${+d.slice(8, 10)}日` : "";
const FLAG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="pole" d="M4 2v16"/><path class="cloth" d="M4.5 3h11l-2.5 3.5 2.5 3.5h-11z"/><path class="chk" d="M7 6.5l1.8 1.8 3.4-3.4"/></svg>';
export function progressBarHtml(s, o = {}) {
  const grad = !!s.graduatedOn, done = doneOf(s), exp = k => expiriesOf(s).some(x => x.key === k);
  const dt = (label, d, warn) => d ? `<span class="pgd${warn ? " ng" : ""}">${label} ${longDate(d)}</span>` : "";
  const row = n => {
    const min = lessonMin(n, s), mk = s[`mikiwame${n}`];
    const d = s.stage > n || grad ? Math.max(min, n === s.stage ? done : 0) : s.stage === n ? done : 0;
    const passed = s.stage > n || grad || !!(mk && mk.kenteiResult === "pass");
    const bk = s.stage === n && !passed ? o.booked || 0 : 0;
    const cells = Math.max(min, s.stage === n && !passed ? d + bk + (d + bk >= min ? 1 : 0) : d), cur = s.stage === n && !passed ? d : -1;
    const kd = !o.kentei ? "" : mk && mk.passed ? mk.kenteiDate || "未定" : o.kentei === "staff" ? s[`kenteiPlan${n}`] || "" : "";
    const name = n === 1 ? "修了検定" : "卒業検定", state = passed ? "pass" : kd && kd !== "未定" ? "set" : "";
    const top = `<div class="pgtop"><b class="t${n}">第${n}段階 ${d}/${min}</b><span class="pgd">${passed ? `${name} 合格` : kd === "未定" ? `${name} 未定` : kd ? `${name} ${longDate(kd)}` : ""}</span></div>`;
    const bar = `<div class="pgrow"><div class="pgseg">${Array.from({ length: cells }, (_, i) => `<i class="c${n}${i < d ? " f" : i < d + bk ? " b" : ""}${i >= min ? " x" : ""}${i === cur ? " cur" : ""}${i === min - 1 ? " mk" : ""}">${i === min - 1 ? "みきわめ" : ""}</i>`).join("")}</div><span class="pgflag f${n} ${state}" title="${name}">${FLAG}</span></div>`;
    const k2 = n === 2 && o.kentei === "staff" ? kentei2Soon(s) : null;   // 卒業検定の期限（みきわめ合格から3ヶ月）が迫っている時だけ
    const bottom = n === 1 ? dt("開始", s.startDate) : `${dt("仮免期限", s.karimenExpiry, exp("karimenExpiry"))}${k2 ? dt("検定期限", k2.limit, true) : ""}${dt("教習期限", s.deadline, exp("deadline")).replace('class="pgd', 'class="pgd end')}`;
    // 次の教習：今の位置のマスの下に「↑ 日付」（右半分なら右寄せにしてはみ出さないようにする）
    const nt = cur >= 0 && o.next;
    const next = nt ? `<div class="pgrow pgnext"><div class="pgseg">${Array.from({ length: cells }, (_, i) => `<i class="${i === min - 1 ? "mk" : ""}">${i === cur ? (cur > cells / 2 ? `<span class="r">${nt} ↑</span>` : `<span>↑ ${nt}</span>`) : ""}</i>`).join("")}</div><span class="pgflag"></span></div>` : "";
    return top + bar + next + (bottom ? `<div class="pglab">${bottom}</div>` : "");
  };
  return `<div class="pg${o.big ? " big" : ""}" role="img" aria-label="第${s.stage}段階 ${done}/${lessonMin(s.stage, s)}時限">${row(1)}${row(2)}</div>`;
}
