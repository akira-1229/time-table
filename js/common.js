// 共通部品：Firebaseの初期化、日付、画面の小物、プッシュ通知
import { initializeApp } from "./backend.js";
import { getFirestore } from "./backend.js";
import { getMessaging, getToken, isSupported, onMessage } from "./backend.js";

export { DEMO, DEMO_USERS, DEMO_STUDENTS, resetDemo } from "./backend.js";
import { DEMO } from "./backend.js";
export const CFG = self.APP_CONFIG;
export const app = initializeApp(CFG.firebase);
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
export const lessonMin = stage => ((CFG.lessons || {})[stage] || {}).min || 0;
export const kikenNoOf = stage => ((CFG.lessons || {})[stage] || {}).kikenNo || 0;
export const doneOf = st => (st.priorDone || 0) + (st.doneCount || 0);
export const bookingEnd = b => { const [h, m] = P[b.period][1].split(":").map(Number); const d = parseDate(b.date); d.setHours(h, m); return d; };
// 予約の一覧を「教習1つ」ごとにまとめる（2時限連続の教習は1つにまとめる）
export function lessonItems(list) {
  const items = [], byPair = {};
  [...list].sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period).forEach(b => {
    if (b.pairId && byPair[b.pairId]) { byPair[b.pairId].bookings.push(b); return; }
    const it = { date: b.date, period: b.period, lessonType: b.lessonType || "", highway: !!b.highway, bookings: [b], units: b.lessonType === "hwSolo" ? 2 : 1 };
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
  return { items, total: n, ok, reason };
}

// みきわめ：その段階の最低教習時限（第1段階12・第2段階19）の教習。合格するまでは、それ以降の教習もみきわめとして扱う
// 記録は段階ごとに mikiwame1 / mikiwame2 ＝ { passed, date, bookingIds, kenteiDate, kenteiUndecided, gakkaDone }
export const mikiwameOf = (st, stage = st.stage) => st[`mikiwame${stage}`] || null;
export function isMikiwame(st, it) {
  const min = lessonMin(st.stage), mk = mikiwameOf(st);
  return !!min && it.no + it.units - 1 >= min && !(mk && mk.passed);
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
export const ageText = birth => { const a = ageOf(birth); return a ? `${a.y}歳${a.m}ヶ月` : ""; };

// 仮免期限日：交付日の「○ヶ月後の同じ日」の前日（同じ日が無い月はその月の末日）
export function karimenExpiryOf(issued, months = CFG.karimenMonths || 6) {
  if (!issued) return "";
  const d = parseDate(issued), y = d.getFullYear(), m = d.getMonth() + months, last = new Date(y, m + 1, 0).getDate();
  const e = d.getDate() > last ? new Date(y, m, last) : addDays(new Date(y, m, d.getDate()), -1);
  return dateStr(e);
}
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
export function sheet(html) {
  let ov = document.getElementById("overlay");
  if (!ov) { ov = document.createElement("div"); ov.id = "overlay"; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="sheet-bg" data-act="close"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
}
export function closeSheet() { const ov = document.getElementById("overlay"); if (ov) ov.innerHTML = ""; }
export function onOverlayClose(e) {
  const t = e.target.closest('[data-act="close"]');
  if (t && (e.target === t || t.tagName === "BUTTON")) { closeSheet(); return true; }
  return false;
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
  if (!("Notification" in window) || !(await isSupported())) return { ok: false, reason: "unsupported" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "denied" };
  const reg = await navigator.serviceWorker.register("./firebase-messaging-sw.js", { scope: "./" });
  await navigator.serviceWorker.ready;
  const messaging = getMessaging(app);
  const token = await getToken(messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
  if (!token) return { ok: false, reason: "no-token" };
  await saveToken(token);
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
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch (e) { return; }
  setTimeout(() => { if (!document.querySelector("#overlay .sheet")) installSheet(kind); }, 1200);
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
export const viewToggle = () => `<button class="linkbtn noprint" data-act="toggleView">${isPC() ? "スマホ表示にする" : "PC表示にする"}</button>`;
// active：その画面が今見えているか（指導員の画面の中の「教習生の管理」は、開いている間だけPC表示にする）
export function onViewChange(cb, active = () => true) {
  const apply = () => active() ? applyView() : document.body.classList.remove("pc");
  apply();
  matchMedia("(min-width: 1024px)").addEventListener("change", () => { apply(); if (active()) cb(); });
  document.addEventListener("click", e => {
    if (!e.target.closest('[data-act="toggleView"]') || !active()) return;
    try { localStorage.setItem(VIEW_KEY, isPC() ? "sp" : "pc"); } catch (err) { }
    apply(); cb();
  });
}
// PC表示の表：列の定義から作る。並べ替えは見出しをクリック
export function pcTable(cols, rows, sort) {
  const sorted = [...rows];
  if (sort && sort.k) {
    const c = cols.find(x => x.k === sort.k), val = r => c.sort ? c.sort(r) : (c.v ? c.v(r) : r[c.k]);
    sorted.sort((a, b) => { const x = val(a) ?? "", y = val(b) ?? ""; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ja")) * (sort.dir || 1); });
  }
  return `<div class="pctable"><table class="adm"><thead><tr>${cols.map(c => `<th>${c.k && c.nosort !== true ? `<button class="th" data-act="sort" data-k="${c.k}">${c.t}${sort && sort.k === c.k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</button>` : c.t}</th>`).join("")}</tr></thead>
  <tbody>${sorted.map(r => `<tr>${cols.map(c => `<td>${c.html ? c.html(r) : esc(c.v ? c.v(r) : r[c.k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
export const nextSort = (sort, k) => sort.k === k ? { k, dir: -sort.dir } : { k, dir: 1 };
