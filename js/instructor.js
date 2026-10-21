// 指導員の画面：週ごとの割り当て、確定と通知、キャンセル希望の対応、確認状況
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "./backend.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, getDocs,
  serverTimestamp, writeBatch, Timestamp, onSnapshot, increment
} from "./backend.js";
import {
  CFG, app as fbApp, db, WD, P, ymOf, dateStr, parseDate, addDays, mondayOf, today, md, label, slotKey, esc,
  toast, sheet, closeSheet, onOverlayClose, friendlyError, enablePush, pushReasonText, listenForeground,
  installButton, firstVisitInstall, indexLinkOf, sendNow, pushStatusHtml, isPC, applyView, onViewChange, lookSettingsHtml, getPref, isMikiwame, kenteiOn, lessonPlan, lessonItems, nextSpecial, isHwType, noRange, lessonMin, doneOf, bookingEnd, expiriesOf, expiryText, trackAccess, DEMO } from "./common.js";

const auth = getAuth(fbApp);
self.__boot && self.__boot.push("instructor");
const root = document.getElementById("app");
const S = {
  uid: null, me: null, view: "assign", week: addDays(mondayOf(today()), getPref("startweek", "next") === "this" ? 0 : 7), mode: getPref("startmode", "slot"), balOpen: getPref("balopen", "0") === "1", pick: null, ptype: null,
  students: [], avail: {}, late: {}, bookings: [], pending: [], confirmed: false, cancelReqs: [], loading: false, indexLinks: new Set()
};
const wid = () => dateStr(S.week);
const days = () => { const r = []; for (let i = 0; i < 7; i++) { const d = addDays(S.week, i); if (CFG.openDays.includes(d.getDay())) r.push(dateStr(d)); } return r; };
const ST = tok => S.students.find(s => s.token === tok);
const shortName = s => (s.name || "").split(/[\s　]/)[0].slice(0, 4);
const dayMax = s => CFG.dailyMax[s.stage] || 2;

/* ---------- ログイン ---------- */
function renderLogin(msg = "") {
  root.innerHTML = `<section class="panel"><div class="phead"><div><h2>職員ログイン</h2><small>${esc(CFG.schoolName)} 指導員用</small></div></div>
  <div class="body"><form id="lf" onsubmit="return false">
  <div class="field"><label for="em">メールアドレス</label><input id="em" type="email" autocomplete="username" required></div>
  <div class="field"><label for="pw">パスワード</label><input id="pw" type="password" autocomplete="current-password" required></div>
  ${msg ? `<div class="banner warn">${esc(msg)}</div>` : ""}
  <button class="btn accent full" data-act="login">ログイン</button></form><p class="center" style="margin:10px 0 0">${installButton()}<a class="linkbtn" href="guide-instructor.html">使い方</a></p></div></section>`;
  // QRのURL（?e=メールアドレス）から開いた時は、メールアドレスを入れておく
  const e = new URLSearchParams(location.search).get("e"); if (e && !document.getElementById("em").value) document.getElementById("em").value = e;
}
firstVisitInstall("staff");
// ログアウトさせた理由（signOut の後に呼ばれる「ログアウト時の描き直し」で消えないように取っておく）
let loginMsg = "";
onAuthStateChanged(auth, async user => {
  self.__boot && self.__boot.push("instructor:ログイン確認");
  if (!user) { stopWatch(); stopCancelWatch(); S.uid = null; S.me = null; showView("assign", true); renderNav(); renderLogin(loginMsg); loginMsg = ""; return; }
  S.uid = user.uid;
  try {
    const me = await getDoc(doc(db, "instructors", user.uid));
    if (!me.exists()) { loginMsg = `指導員として登録されていません。事務所に確認してください。（このアカウントのユーザーUID：${user.uid}）`; await signOut(auth); return; }
    S.me = me.data(); renderNav(); trackAccess("instructor", user.uid);
    listenForeground(() => loadWeek());
    watchCancelReqs();
    await loadWeek();
    if (location.hash === "#manage") showView("manage");
    else if (location.hash === "#settings") showView("settings");
  } catch (e) {
    // ログインはできているので、ログイン画面には戻さず、理由とやり直しのボタンを出す
    noteIndex(e);
    root.innerHTML = `<section class="panel"><div class="body"><div class="banner warn">${esc(friendlyError(e))}</div>${indexBanner()}
      <div class="list"><button class="btn primary full" data-act="retry">もう一度読み込む</button><button class="btn full" data-act="logout">ログアウト</button></div></div></section>`;
  }
});
// 索引が無い時は「索引を作る」リンクを画面に出す（管理者がPCで押すと作られる。数分かかる）
function noteIndex(e) { const u = indexLinkOf(e); if (u) S.indexLinks.add(u); }
const indexBanner = () => S.indexLinks.size ? `<div class="banner warn"><b>索引（検索用のデータ）がまだ作られていません。</b><br>管理者の方は、下のリンクを押して「インデックスを作成」してください。作成に数分かかります。終わったら画面を読み込み直してください。${[...S.indexLinks].map((u, i) => `<br><a href="${esc(u)}" target="_blank" rel="noopener">索引を作る（${i + 1}）</a>`).join("")}</div>` : "";

/* ---------- 読み込み ---------- */
async function loadWeek() {
  S.loading = true; render();
  try {
    const sq = query(collection(db, "students"), where("instructorUid", "==", S.uid), where("active", "==", true));
    S.students = (await getDocs(sq)).docs.map(d => ({ token: d.id, ...d.data() })).sort((a, b) => String(a.studentNo || "").localeCompare(String(b.studentNo || "")));
    const yms = [...new Set(days().map(ds => ds.slice(0, 7)))];
    await watchAvail(yms);
    const bq = query(collectionGroup(db, "bookings"), where("instructorUid", "==", S.uid), where("weekId", "==", wid()));
    S.bookings = (await getDocs(bq)).docs.map(d => ({ id: d.id, token: d.ref.parent.parent.id, ...d.data() })).filter(b => b.status !== "cancelled");
    const w = await getDoc(doc(db, "weeks", `${S.uid}_${wid()}`));
    S.confirmed = w.exists();
    const cq = query(collectionGroup(db, "bookings"), where("instructorUid", "==", S.uid), where("cancelRequested", "==", true));
    S.cancelReqs = (await getDocs(cq)).docs.map(d => ({ id: d.id, token: d.ref.parent.parent.id, ...d.data() })).filter(b => b.status === "confirmed");
    // まだ実施チェックの済んでいない予約（週をまたいで全部）。何時限目かの計算と、実施チェックに使う
    const pq = query(collectionGroup(db, "bookings"), where("instructorUid", "==", S.uid), where("result", "==", null), where("status", "in", ["draft", "confirmed"]));
    S.pending = (await getDocs(pq)).docs.map(d => ({ id: d.id, token: d.ref.parent.parent.id, ...d.data() }));
  } catch (e) { noteIndex(e); toast(friendlyError(e)); }
  S.loading = false; render();
}

/* ---------- 空き時間のリアルタイム更新 ---------- */
// 教習生が◯を付け外しすると、開いたままの画面にもすぐ反映する（予約・キャンセル希望は「最新の情報に更新」で読み直す）
let unwatch = [], lateM = {}, renderTimer = null;
const stopWatch = () => { unwatch.forEach(u => u()); unwatch = []; };
function watchAvail(yms) {
  stopWatch();
  S.avail = {}; S.late = {}; lateM = {};
  return Promise.all(S.students.flatMap(s => yms.map(ym => new Promise(resolve => {
    let first = true;
    unwatch.push(onSnapshot(doc(db, "students", s.token, "months", ym), m => {
      S.avail[s.token] = S.avail[s.token] || {};
      S.avail[s.token][ym] = new Set(m.exists() ? m.data().slots || [] : []);
      lateM[s.token] = { ...lateM[s.token], [ym]: !!(m.exists() && m.data().late) };
      S.late[s.token] = Object.values(lateM[s.token]).some(Boolean);
      if (first) { first = false; resolve(); }
      else laterRender();
    }, e => { if (first) { first = false; resolve(); } toast(friendlyError(e)); }));
  }))));
}
const laterRender = () => { if (S.loading) return; clearTimeout(renderTimer); renderTimer = setTimeout(render, 300); };
// 教習生からのキャンセル希望も、届いたらすぐ表示する
let unwatchCR = null;
const stopCancelWatch = () => { if (unwatchCR) unwatchCR(); unwatchCR = null; };
function watchCancelReqs() {
  stopCancelWatch();
  const cq = query(collectionGroup(db, "bookings"), where("instructorUid", "==", S.uid), where("cancelRequested", "==", true));
  unwatchCR = onSnapshot(cq, r => {
    S.cancelReqs = r.docs.map(d => ({ id: d.id, token: d.ref.parent.parent.id, ...d.data() })).filter(b => b.status === "confirmed");
    const ids = new Set(S.cancelReqs.map(b => b.id));
    S.bookings.forEach(b => { b.cancelRequested = ids.has(b.id); });
    laterRender();
  }, e => { noteIndex(e); toast(friendlyError(e)); laterRender(); });
}
// 未確定の予約のうち、あとから教習生が◯を外した枠（締切前なら外せるため）
const goneDraft = b => b.status === "draft" && !isFree(b.token, b.date, b.period);

/* ---------- 何時限目か（進み具合） ---------- */
const pendingOf = s => S.pending.filter(b => b.token === s.token && (b.stage ?? s.stage) === s.stage);
const planOf = (s, extra = []) => lessonPlan(s, [...pendingOf(s), ...extra]);
// 予約を足した時に、危険予測の順番（ちょうど○時限目）が崩れないか。すでに崩れている時は、直すための操作を止めない
function seqCheck(s, extra) {
  if (!planOf(s).ok) return "";
  const after = planOf(s, extra);
  return after.ok ? "" : after.reason;
}
const itemOf = b => { const s = ST(b.token); return s ? planOf(s).items.find(it => it.bookings.some(x => x.id === b.id)) : null; };
const noText = (s, it) => it ? `${noRange(it)}時限目${it.no + it.units - 1 > lessonMin(s.stage) ? "（延長）" : ""}` : "";

/* ---------- 判定 ---------- */
const bookAt = (ds, p) => S.bookings.find(b => b.date === ds && b.period === p);
const weekCount = tok => S.bookings.filter(b => b.token === tok).length;
const dayCount = (tok, ds) => S.bookings.filter(b => b.token === tok && b.date === ds).length;
const isFree = (tok, ds, p) => { const d = parseDate(ds); return !!(S.avail[tok] && S.avail[tok][ds.slice(0, 7)] && S.avail[tok][ds.slice(0, 7)].has(slotKey(d.getDate(), p))); };
const dayPeriods = (tok, ds) => S.bookings.filter(b => b.token === tok && b.date === ds).map(b => b.period);
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const inDarkSeason = ds => {
  const k = ds.slice(5), { from, to } = CFG.darkSeason || {};
  if (!from) return false;
  return from <= to ? (k >= from && k <= to) : (k >= from || k <= to);
};
// 割り当てできるかの判定（通常の教習1時限）
//   ok:true  … そのまま入れられる
//   ok:false … 入れられない（reason に理由）
// 連続3時限は高速教習（3時限）だけ。高速教習・危険予測・単独高速は evaluatePair で判定する
const linkedP = (x, y) => y === x + 1 && !(CFG.breakAfter || []).includes(x);   // 休みをはさまずに続いているか
function evaluate(s, ds, p) {
  if (!isFree(s.token, ds, p)) return { ok: false, reason: "空いていない枠です" };
  if (bookAt(ds, p)) return { ok: false, reason: "この枠はすでに予約が入っています" };
  if (dayCount(s.token, ds) >= dayMax(s)) return { ok: false, reason: `この日は上限の${dayMax(s)}時限まで入っています` };
  if ((CFG.noTripleStages || []).includes(s.stage)) {
    const ps = [...dayPeriods(s.token, ds), p].sort((a, b) => a - b);
    for (let i = 0; i + 2 < ps.length; i++) {
      const tri = ps.slice(i, i + 3);
      if (linkedP(tri[0], tri[1]) && linkedP(tri[1], tri[2]))
        return { ok: false, reason: `${S.bookings.some(b => b.token === s.token && b.date === ds && b.pairId && tri.includes(b.period)) ? "ほかの予約と合わせて" : ""}連続3時限（${tri.join("・")}限）になるため入れられません` };
    }
  }
  const sq = seqCheck(s, [{ token: s.token, date: ds, period: p }]);
  if (sq) return { ok: false, reason: sq };
  return { ok: true };
}
const canBook = (s, ds, p) => evaluate(s, ds, p).ok !== false;

/* ---------- 続けて入れる教習（危険予測・単独高速・高速教習） ---------- */
// type："kiken"＝危険予測（2時限で1時限と数える）、"hwSolo"＝単独高速（高速教習2時限）、"hw3"＝高速教習（3時限）
const KK = () => CFG.kiken || { label: "危険予測", noPairAfter: [] };
const hasSpecial = s => (CFG.specialStages || [2]).includes(s.stage);                 // 高速教習・危険予測・単独高速がある段階か
const PT = type => type === "hwSolo" ? (CFG.hwSolo || { label: "単独高速", noPairAfter: [3] }) : type === "hw3" ? (CFG.hw3 || { label: "高速教習" }) : KK();
const LEN = type => type === "hw3" ? 3 : 2;
const span = (a, type) => Array.from({ length: LEN(type) }, (_, i) => a + i);
const spanText = (a, type) => span(a, type).join("・");
// 種類を選ぶボタンの文字
const TYPE_BTN = { kiken: () => `${KK().label}（2時限）`, hwSolo: () => "高速 2時限", hw3: () => "高速 3時限" };
// a限から続けて入れられる組か（休憩をまたぐ組や、決まった組み合わせ以外は不可）
const pairOk = (a, type = "kiken") => type === "hw3"
  ? (CFG.highwaySets || []).some(set => sameSet(set, span(a, type)))
  : a >= 1 && a + 1 <= 10 && !PT(type).noPairAfter.includes(a);
const pairsWith = (p, type = "kiken") => [p - 2, p - 1, p].filter(a => a >= 1 && a <= p && p < a + LEN(type) && pairOk(a, type));   // p限を含む組の開始時限
// その教習生が、いま危険予測・高速教習の番か（番の時だけ、その種類を選べる）
const specialTypes = s => {
  if (!hasSpecial(s)) return [];
  const n = nextSpecial(s, pendingOf(s));
  return n === "kiken" ? ["kiken"] : n === "hw" ? ["hwSolo", "hw3"] : [];
};
// 危険予測→単独高速の決まった組（例：危険予測4・5限→単独高速6・7限）になっているか
function isCombo(list) {
  if (list.length !== 4) return false;
  const at = (type, a) => list.some(x => x.type === type && x.period === a) && list.some(x => x.type === type && x.period === a + 1);
  return (CFG.pairCombos || []).some(c => at("kiken", c.kiken) && at("hwSolo", c.hwSolo));
}
//   ok:true（dark:true は日没が早い期間の警告付き）／ok:false（reason に理由）
function evaluatePair(s, ds, a, type = "kiken") {
  const L = PT(type).label, ps = span(a, type);
  if (!hasSpecial(s)) return { ok: false, reason: `第${s.stage}段階には${L}はありません` };
  if (!pairOk(a, type)) return { ok: false, reason: type === "hw3"
    ? `${spanText(a, type)}限の${L}は入れられません（${(CFG.highwaySets || []).map(x => x.join("・")).join(" / ")} 限のみ）`
    : `${spanText(a, type)}限は休憩をはさむため、${L}は入れられません` };
  for (const q of ps) {
    if (!isFree(s.token, ds, q)) return { ok: false, reason: `${q}限が空いていません` };
    if (bookAt(ds, q)) return { ok: false, reason: `${q}限はすでに予約が入っています` };
  }
  if (type === "kiken" && (s.kikenDone || pendingOf(s).some(b => b.lessonType === "kiken")))
    return { ok: false, reason: s.kikenDone ? `${L}は受講済みです` : `${L}はすでに予約が入っています` };
  if (type !== "kiken" && (s.hwDone || pendingOf(s).some(b => isHwType(b.lessonType))))
    return { ok: false, reason: s.hwDone ? "高速教習は受講済みです" : "高速教習はすでに予約が入っています" };
  const mine = S.bookings.filter(b => b.token === s.token && b.date === ds);
  const list = [...mine.map(b => ({ period: b.period, type: b.lessonType || "", g: b.pairId || b.id })), ...ps.map(q => ({ period: q, type, g: "new" }))];
  const combo = isCombo(list);
  if (!combo) {
    // 危険予測と高速教習は、決まった組（危険予測4・5限→単独高速6・7限）のほかは同じ日に入れない
    const other = mine.find(b => type === "kiken" ? isHwType(b.lessonType) || b.highway : b.lessonType === "kiken");
    if (other) return { ok: false, reason: `同じ日に${type === "kiken" ? "高速教習" : KK().label}が入っています（同じ日に入れられるのは ${KK().label}4・5限→${PT("hwSolo").label}6・7限 の組だけです）` };
    if (list.length > dayMax(s)) return { ok: false, reason: `1日の上限（${dayMax(s)}時限）を超えます` };
    if ((CFG.noTripleStages || []).includes(s.stage)) {
      const sorted = list.slice().sort((x, y) => x.period - y.period);
      for (let i = 0; i + 2 < sorted.length; i++) {
        const w = sorted.slice(i, i + 3);
        if (!(linkedP(w[0].period, w[1].period) && linkedP(w[1].period, w[2].period))) continue;
        if (type === "hw3" && w.every(x => x.g === "new")) continue;   // 高速教習（3時限）そのものは連続3時限でよい
        return { ok: false, reason: `ほかの予約と合わせて連続${type === "hw3" ? "4" : "3"}時限（${w.map(x => x.period).join("・")}限）になります` };
      }
    }
  }
  const sq = seqCheck(s, ps.map(q => ({ token: s.token, date: ds, period: q, lessonType: type, pairId: "new" })));
  if (sq) return { ok: false, reason: sq };
  const dk = CFG.darkSeason || {}, dark0 = inDarkSeason(ds);
  if (type === "hwSolo" && dark0 && (dk.hwSoloNo || []).some(set => sameSet(set, ps)))
    return { ok: false, reason: `日没が早い期間は${spanText(a, type)}限の${L}は入れられません` };
  const dark = dark0 && (type === "hwSolo" ? (dk.hwSoloSets || []) : type === "hw3" ? (dk.sets || []) : []).some(set => sameSet(set, ps));
  return { ok: true, dark, combo };
}
const typeName = b => b.lessonType ? PT(b.lessonType).label : b.highway ? "高速教習" : "";
const blabel = b => label(b.date, b.period) + (typeName(b) ? `（${typeName(b)}）` : "");
const freeCount = s => { let n = 0; days().forEach(ds => { for (let p = 1; p <= 10; p++) if (isFree(s.token, ds, p)) n++; }); return n; };
const candidates = (ds, p) => S.students.filter(s => isFree(s.token, ds, p)).sort((a, b) => weekCount(a.token) - weekCount(b.token) || String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
const daysLeft = s => s.deadline ? Math.round((parseDate(s.deadline) - today()) / 86400000) : null;
const unacked = s => s.lastNotifiedAt && (!s.ackAt || s.lastNotifiedAt.toMillis() > s.ackAt.toMillis());
const info = s => {
  const dl = daysLeft(s), pl = planOf(s), min = lessonMin(s.stage);
  return `第${s.stage}段階・実施${doneOf(s)}/${min}時限${pl.items.length ? `・予定${pl.total - doneOf(s)}` : ""}${min && pl.total > min ? "・延長あり" : ""}・今週${weekCount(s.token)}時限${dl !== null ? `・期限まであと${dl}日` : ""}`;
};

/* ---------- 今週の割り振り（教習生ごとの時限数） ---------- */
// 進み具合に差がつかないよう、この週に何時限入っているかを並べる（少ない順）。平均より1時限以上少ない人は注意、0は赤
function balanceHtml() {
  if (!S.students.length) return "";
  const rows = S.students.map(s => ({ s, n: weekCount(s.token), d: S.bookings.filter(b => b.token === s.token && b.status === "draft").length, free: freeCount(s) }))
    .sort((a, b) => a.n - b.n || String(a.s.deadline || "9").localeCompare(String(b.s.deadline || "9")));
  const avg = rows.reduce((t, r) => t + r.n, 0) / rows.length, min = rows[0].n, max = rows[rows.length - 1].n;
  const low = rows.filter(r => r.n <= avg - 1).length, top = Math.max(1, max);
  const lv = r => r.n === 0 ? "zero" : r.n <= avg - 1 ? "low" : "ok";
  let h = `<details class="bal" ${S.balOpen ? "open" : ""}><summary><b>今週の割り振り</b>　平均 ${avg.toFixed(1)}時限・最少 ${min}・最多 ${max}${max - min >= 2 ? `<span class="tag late">差が${max - min}時限あります</span>` : ""}${low ? `<span class="tag wait">少ない人 ${low}人</span>` : ""}</summary>
    <div class="balnote">この週に入っている時限数です（未確定を含みます）。少ない人から順に並んでいます。押すと、その人を選んで割り当てられます。</div><div class="ballist">`;
  rows.forEach(r => {
    h += `<button class="balrow ${lv(r)}" data-act="balPick" data-s="${r.s.token}"><span class="nm">${esc(r.s.name)}</span><span class="bar"><i style="width:${Math.round(r.n / top * 100)}%"></i></span><span class="n"><b>${r.n}</b>時限${r.d ? `<small>（未確定${r.d}）</small>` : ""}</span><span class="fr">${r.free ? `◯${r.free}枠` : "◯なし"}</span></button>`;
  });
  return h + `</div></details>`;
}

/* ---------- 画面 ---------- */
function render() {
  if (!S.uid) return;
  const ds = days(); const wEnd = ds[ds.length - 1];
  let h = `<div class="topbar"><div><h1>予約の管理</h1><small>${esc(S.me ? S.me.name : "")} 指導員・担当 ${S.students.length}人</small></div>
    <span><button class="linkbtn" data-act="reload">最新の情報に更新</button></span></div>`;
  h += `<div class="weeknav"><button class="btn" data-act="wk" data-v="-7" aria-label="前の週">◀</button><b>${md(ds[0])}〜${md(wEnd)}</b><button class="btn" data-act="wk" data-v="7" aria-label="次の週">▶</button></div>`;
  if (S.loading) { root.innerHTML = h + `<div class="loading">読み込み中…</div>`; return; }
  const top = h + `<section class="panel"><div class="phead"><div><h2>割り当て</h2><small>マス目をタップして教習生を入れます</small></div>
    ${S.confirmed ? '<span class="tag ok">確定済み</span>' : '<span class="tag draft">未確定</span>'}</div><div class="body">`;
  h = indexBanner();
  const unchecked = lessonItems(S.pending.filter(b => b.status === "confirmed" && bookingEnd(b) <= new Date()));
  if (unchecked.length) {
    h += `<div class="banner warn"><b>終わった教習のチェックが${unchecked.length}件あります</b><br><span style="font-size:12px">教習生が来たら「実施」、来なかったら「欠席」を押してください（欠席は教習生に通知されます）。</span>`;
    unchecked.forEach(it => {
      const s = ST(it.bookings[0].token), ids = it.bookings.map(b => b.id).join(",");
      const pit = s && planOf(s).items.find(x => x.bookings.some(b => b.id === it.bookings[0].id));
      const tn = (it.lessonType ? `（${PT(it.lessonType).label}）` : it.highway ? "（高速）" : "") + (s && pit && isMikiwame(s, pit) ? "（みきわめ）" : "");
      h += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span>${esc(s ? s.name : "")}<br>${md(it.date)} ${it.bookings.map(b => b.period).join("・")}限${tn}</span><span style="display:flex;gap:6px"><button class="btn" data-act="markAbsent" data-ids="${ids}">欠席</button><button class="btn accent" data-act="markDone" data-ids="${ids}">実施</button></span></div>`;
    });
    h += `</div>`;
  }
  const kt = S.students.filter(s => kenteiOn(s));
  if (kt.length) h += `<div class="banner ok"><b>本日、検定日の方</b><ul style="margin:6px 0 0;padding-left:1.4em">${kt.map(s => `<li>${esc(s.name)}（第${[1, 2].find(n => s[`mikiwame${n}`] && s[`mikiwame${n}`].kenteiDate === dateStr(today()))}段階）</li>`).join("")}</ul></div>`;
  const exp = S.students.flatMap(s => expiriesOf(s).map(e => [s, e])).sort((a, b) => a[1].days - b[1].days);
  if (exp.length) h += `<div class="banner warn"><b>期限が近い教習生がいます（${CFG.expiryWarnDays || 30}日以内）</b>${exp.map(([s, e]) => `<br>${esc(s.name)}：<span style="${e.days <= 7 ? "color:var(--lv3);font-weight:700" : ""}">${esc(expiryText(e))}</span>`).join("")}</div>`;
  const ngs = S.students.map(s => [s, planOf(s)]).filter(([, pl]) => !pl.ok);
  if (ngs.length) h += `<div class="banner warn"><b>教習の順番がずれています</b>${ngs.map(([s, pl]) => `<br>${esc(s.name)}：${esc(pl.reason)}`).join("")}<br><span style="font-size:12px">欠席などで順番がずれた時に出ます。予約を入れ直してください。</span></div>`;
  const gones = S.bookings.filter(goneDraft);
  if (gones.length) h += `<div class="banner warn"><b>教習生が◯を外した未確定の予約が${gones.length}件あります</b>（赤い枠）。取り消すか、教習生に確認してください。</div>`;
  if (S.cancelReqs.length) {
    h += `<div class="banner warn"><b>キャンセル希望が${S.cancelReqs.length}件あります</b>`;
    S.cancelReqs.forEach(b => {
      const s = ST(b.token);
      h += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span>${esc(s ? s.name : "")}<br>${label(b.date, b.period)}</span><span style="display:flex;gap:6px"><button class="btn" data-act="reject" data-id="${b.id}">却下</button><button class="btn accent" data-act="approve" data-id="${b.id}">承認</button></span></div>`;
    });
    h += `</div>`;
  }
  const alertsH = h; h = "";
  const none = S.students.filter(s => weekCount(s.token) === 0).length;
  const total = ds.length * 10;
  h += `<div class="sum"><div><b>${S.bookings.length}</b>予約した枠</div><div class="${none ? "alert" : ""}"><b>${none}</b>まだ予約のない人</div><div><b>${total - S.bookings.length}</b>空いている枠</div></div>`;
  h += balanceHtml();
  const sideTop = h; h = "";
  h += `<div class="seg" role="group" aria-label="割り当て方"><button aria-pressed="${S.mode === "slot"}" data-act="mode" data-v="slot">枠から選ぶ</button><button aria-pressed="${S.mode === "student"}" data-act="mode" data-v="student">教習生から選ぶ</button></div>`;

  let maxN = 1; ds.forEach(d => { for (let p = 1; p <= 10; p++) maxN = Math.max(maxN, S.students.filter(s => isFree(s.token, d, p)).length); });
  const T1 = Math.floor(maxN / 3), T2 = Math.floor(maxN * 2 / 3);
  const pk = S.mode === "student" && S.pick ? ST(S.pick) : null;
  // 危険予測・高速教習は、その教習生がその時限目に来た時だけ選べる（番の時はその種類だけ）
  const pkTypes = pk ? specialTypes(pk) : [];
  S.ptype = pkTypes.includes(S.ptype) ? S.ptype : pkTypes[0] || null;
  if (S.mode === "student") {
    h += pk ? `<div class="picking"><span><b>${esc(pk.name)}</b>を割り当て中<br><span style="font-size:12px;color:var(--muted)">光っている枠をタップすると予約されます（第${pk.stage}段階・1日${dayMax(pk)}時限まで${(CFG.noTripleStages || []).includes(pk.stage) ? "・連続3時限は高速教習（3時限）のみ" : ""}）</span></span><button class="btn" data-act="unpick">やめる</button></div>
      ${pkTypes.length ? `<div class="banner ${S.ptype === "kiken" ? "ok" : "warn"}" style="margin-bottom:6px">次は<b>${lessonPlan(pk, pendingOf(pk)).total + 1}時限目</b>で、<b>${pkTypes[0] === "kiken" ? KK().label : "高速教習"}</b>の番です。${pkTypes.length > 1 ? "2時限（単独高速）か3時限かを選んでください。" : "2時限連続で入ります。"}</div>
        ${pkTypes.length > 1 ? `<div class="seg" role="group" aria-label="教習の種類">${pkTypes.map(v => `<button aria-pressed="${S.ptype === v}" data-act="ptype" data-v="${v}">${TYPE_BTN[v]()}</button>`).join("")}</div>` : ""}
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">光っているマスは開始の時限です。タップすると、その時限から${LEN(S.ptype)}時限がまとめて入ります。</div>` : ""}`
      : `<div class="banner info">下の一覧から教習生を選ぶと、その人が空いている枠だけが光ります。</div>`;
  } else {
    h += `<div class="heatleg"><span><i style="background:var(--lv1-soft);border-color:var(--lv1)"></i>少ない（${T1}人以下）</span><span><i style="background:var(--lv2-soft);border-color:var(--lv2)"></i>中間（${T1 + 1}〜${T2}人）</span><span><i style="background:var(--lv3-soft);border-color:var(--lv3)"></i>多い（${T2 + 1}人以上）</span></div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:6px">数字と棒の長さは、その枠に入れる人数（この週の最多${maxN}人を基準に色分け）</div>`;
  }
  h += `<div class="gridwrap"><table class="wk"><thead><tr><th class="pl"></th>`;
  ds.forEach(d => { const w = parseDate(d).getDay(); h += `<th style="${w === 6 ? "color:var(--blue)" : w === 0 ? "color:#C0392B" : ""}">${parseDate(d).getDate()}(${WD[w]})</th>`; });
  h += `</tr></thead><tbody>`;
  for (let p = 1; p <= 10; p++) {
    h += `<tr><th class="pl">${p}限<small>${P[p][0]}</small></th>`;
    ds.forEach(d => {
      const b = bookAt(d, p); const lb = label(d, p);
      if (b) {
        const s = ST(b.token);
        const gone = goneDraft(b);
        h += `<td><button class="wc bk ${b.status === "draft" ? "draft" : ""} ${gone ? "gone" : ""} ${b.result || ""}" data-act="booked" data-id="${b.id}" aria-label="${lb} ${esc(s ? s.name : "")}${gone ? " 教習生が空き時間を取り消しました" : ""}">${esc(s ? shortName(s) : "?")}<small>${b.result === "done" ? "実施" : b.result === "absent" ? "欠席" : gone ? "空き取消" : b.cancelRequested ? "キャンセル希望" : b.lessonType ? PT(b.lessonType).label : b.highway ? "高速" : b.status === "draft" ? "未確定" : "通知済み"}</small></button></td>`;
      } else if (pk && S.ptype && hasSpecial(pk)) {
        const ev = evaluatePair(pk, d, p, S.ptype), ok = ev.ok, L = PT(S.ptype).label;
        h += `<td><button class="wc ${ok ? `cand ${S.ptype === "kiken" ? "kk" : "hw"}` : "off"}" ${ok ? `data-act="assignPair" data-s="${pk.token}" data-d="${d}" data-p="${p}" data-t="${S.ptype}"` : "disabled"} aria-label="${lb}${ok ? `から${L}で割り当て可${ev.dark ? "（日没が早い期間のため要確認）" : ""}` : ""}">${ok ? `${spanText(p, S.ptype)}<small>${L}${ev.dark ? "・要確認" : ""}</small>` : ""}</button></td>`;
      } else if (pk) {
        const ok = evaluate(pk, d, p).ok !== false;
        h += `<td><button class="wc ${ok ? "cand" : "off"}" ${ok ? `data-act="assign" data-s="${pk.token}" data-d="${d}" data-p="${p}"` : "disabled"} aria-label="${lb}${ok ? " 割り当て可" : ""}">${ok ? "◯" : ""}</button></td>`;
      } else {
        const n = S.students.filter(s => isFree(s.token, d, p)).length;
        const c = n === 0 ? "" : n <= T1 ? "lv1" : n <= T2 ? "lv2" : "lv3";
        h += `<td><button class="wc ${c}" ${n && S.mode === "slot" ? `data-act="open" data-d="${d}" data-p="${p}"` : "disabled"} aria-label="${lb} 空き${n}人">${n ? `${n}人<span class="bar"><i style="width:${Math.round(n / maxN * 100)}%"></i></span>` : "—"}</button></td>`;
      }
    });
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;
  const gridH = h; h = "";

  if (S.mode === "student") {
    const list = S.students.slice().sort((a, b) => weekCount(a.token) - weekCount(b.token) || String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
    h += `<h3>担当の教習生（予約の少ない順）</h3><div class="slist">`;
    list.forEach(s => {
      const n = weekCount(s.token);
      h += `<button class="srow" aria-pressed="${S.pick === s.token}" data-act="pick" data-s="${s.token}"><span><span class="t">${esc(s.name)}</span>${S.late[s.token] ? ' <span class="tag late">締切後に変更あり</span>' : ""}<br><span class="s">${info(s)}・この週の空き${freeCount(s)}枠</span></span><span class="cnt ${n ? "some" : "zero"}">${n ? `今週${n}時限` : "予約なし"}</span></button>`;
    });
    h += `</div>`;
  }

  const listH = h; h = "";
  const drafts = S.bookings.filter(b => b.status === "draft").length;
  if (!S.confirmed) {
    h += `<button class="btn accent full" style="margin-top:14px" data-act="confirm" ${drafts ? "" : "disabled"}>この週の予約を確定して通知（${drafts}件）</button>
    <p style="font-size:12px;color:var(--muted);margin:6px 0 0">確定するまで、何度入れ直しても教習生には通知されません。</p>`;
  } else {
    const notified = S.students.filter(s => weekCount(s.token) > 0);
    const un = notified.filter(unacked);
    h += `<div class="banner info" style="margin-top:12px">確定後の追加・取り消しは、その都度、教習生に自動で通知されます。</div>
    <h3>確認状況：確認済み ${notified.length - un.length}人／未確認 ${un.length}人</h3><div class="list">`;
    un.forEach(s => { h += `<div class="item"><div class="t">${esc(s.name)}</div><span style="display:flex;gap:6px;align-items:center"><span class="tag wait">未確認</span><button class="btn" data-act="renotify" data-s="${s.token}">再通知</button></span></div>`; });
    if (un.length) h += `<button class="btn full" data-act="renotifyAll">未確認の${un.length}人にまとめて再通知</button>`;
    h += `</div>`;
  }
  const confH = h;
  // PC表示：左にマス目、右に集計・お知らせ・教習生の一覧・確定ボタン。スマホは上から順に並べる
  root.innerHTML = top + (isPC()
    ? `<div class="asg"><div class="asg-main">${gridH}</div><aside class="asg-side">${sideTop}${alertsH}${listH}${confH}</aside></div>`
    : alertsH + sideTop + gridH + listH + confH) + `</div></section>`;
}

function slotSheet(ds, p, type = "normal", start) {
  const seg = `<div class="seg seg4" role="group" aria-label="教習の種類">${[["normal", "通常"], ["kiken", KK().label], ["hwSolo", "高速2時限"], ["hw3", "高速3時限"]].map(([v, t]) => `<button aria-pressed="${type === v}" data-act="sheetType" data-v="${v}" data-d="${ds}" data-p="${p}">${t}</button>`).join("")}</div>`;
  if (type !== "normal") return pairSheet(ds, p, start, seg, type);
  const c = candidates(ds, p);
  let h = `<h3>${label(ds, p)}（${P[p][0]}〜）<br><span style="font-size:13px;font-weight:400;color:var(--muted)">入れる教習生 ${c.length}人・予約の少ない順</span></h3>${seg}<div class="list">`;
  c.forEach(s => {
    const ev = evaluate(s, ds, p), sp = specialTypes(s);
    // 危険予測・高速教習の番の人は、その種類の画面へ進むボタンにする
    const spName = sp[0] === "kiken" ? KK().label : "高速教習";
    const note = sp.length ? `<div class="s" style="color:var(--blue)">次は${spName}の番です${sp.length > 1 ? "（2時限か3時限を選べます）" : ""}</div>`
      : ev.ok === false ? `<div class="s" style="color:var(--orange)">${esc(ev.reason)}</div>` : "";
    const btn = sp.length ? `<button class="btn accent" data-act="sheetType" data-v="${sp[0]}" data-d="${ds}" data-p="${p}">${spName}で入れる</button>`
      : `<button class="btn accent" data-act="assign" data-s="${s.token}" data-d="${ds}" data-p="${p}" ${ev.ok === false ? "disabled" : ""}>割り当てる</button>`;
    h += `<div class="item"><div><div class="t">${esc(s.name)}${S.late[s.token] ? ' <span class="tag late">締切後に変更</span>' : ""}</div><div class="s">${info(s)}</div>${note}</div>${btn}</div>`;
  });
  if (!c.length) h += `<div class="hist"><div>この枠が空いている教習生はいません。</div></div>`;
  sheet(h + `</div><button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
}

function pairSheet(ds, p, start, seg, type) {
  const pairs = pairsWith(p, type), L = PT(type).label, n = LEN(type);
  let h = `<h3>${md(ds)} ${L}（${n}時限連続）</h3>${seg}`;
  if (!pairs.length) {
    h += `<div class="banner warn">${type === "hw3" ? `${p}限を含む${L}（3時限）は入れられません（${(CFG.highwaySets || []).map(x => x.join("・")).join(" / ")} 限のみ）。` : `${p}限は前後どちらも休憩をはさむため、${L}（2時限連続）は入れられません。`}</div>`;
    return sheet(h + `<button class="btn full" data-act="close">閉じる</button>`);
  }
  const a = pairs.includes(start) ? start : pairs[0], ps = span(a, type);
  h += `<div class="chips" role="group" aria-label="時限" style="margin-bottom:8px">${pairs.map(x => `<button class="chip o" aria-pressed="${x === a}" data-act="pairStart" data-d="${ds}" data-p="${p}" data-v="${x}" data-t="${type}">${spanText(x, type)}限</button>`).join("")}</div>`;
  // その種類の番（危険予測は12時限目、高速教習は13時限目）が来ている教習生だけ
  const want = type === "kiken" ? "kiken" : "hwSolo";
  const c = S.students.filter(s => specialTypes(s).includes(want) && ps.every(q => isFree(s.token, ds, q)))
    .sort((x, y) => weekCount(x.token) - weekCount(y.token) || String(x.deadline || "9").localeCompare(String(y.deadline || "9")));
  h += `<div style="font-size:13px;color:var(--muted);margin-bottom:8px">${type === "kiken" ? `${KK().label}（${lessonsOf(2, "kikenNo")}時限目）` : `高速教習（${lessonsOf(2, "hwNo")}時限目から）`}の番で、${spanText(a, type)}限がすべて空いている教習生 ${c.length}人</div><div class="list">`;
  c.forEach(s => {
    const ev = evaluatePair(s, ds, a, type);
    const note = !ev.ok ? `<div class="s" style="color:var(--orange)">${esc(ev.reason)}</div>`
      : ev.dark ? `<div class="s" style="color:var(--orange)">日没が早い期間のため要確認</div>`
      : ev.combo ? `<div class="s" style="color:var(--muted)">${KK().label}→${PT("hwSolo").label}の組み合わせ（この日は4時限）</div>` : "";
    h += `<div class="item"><div><div class="t">${esc(s.name)}</div><div class="s">${info(s)}</div>${note}</div><button class="btn accent" data-act="assignPair" data-s="${s.token}" data-d="${ds}" data-p="${a}" data-t="${type}" ${ev.ok ? "" : "disabled"}>${L}で入れる</button></div>`;
  });
  if (!c.length) h += `<div class="hist"><div>入れられる教習生はいません。</div></div>`;
  sheet(h + `</div><button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
}
const lessonsOf = (stage, k) => ((CFG.lessons || {})[stage] || {})[k] || "";

// 学科の受講確認（config の gakkaCheck）：入れようとしている教習が、決まった時限目（第2段階の10・13時限目など）に当たる時に確認を出す
function gakkaAsk(s, ds, periods, lessonType = "") {
  const rules = (CFG.gakkaCheck || []).filter(r => r.stage === s.stage);
  if (!rules.length) return [];
  const pairId = periods.length > 1 ? "__new" : undefined;
  const extra = periods.map(q => ({ id: `__new${q}`, token: s.token, date: ds, period: q, lessonType, pairId, stage: s.stage }));
  const its = planOf(s, extra).items.filter(x => x.bookings.some(b => String(b.id).startsWith("__new")));
  return rules.filter(r => its.some(x => x.no <= r.no && r.no < x.no + x.units));
}
function gakkaSheet(s, rules, go) {
  S.gakkaGo = go;
  sheet(`<h3>学科の受講確認</h3><p>${esc(s.name)}（第${s.stage}段階）${rules.map(r => `${r.no}時限目`).join("・")}の教習です。</p>
  ${rules.map(r => `<div class="banner warn"><b>この教習は学科の${r.gakka}番を受講していないと受けることはできませんが、受講済ですか？</b></div>`).join("")}
  <div class="list"><button class="btn primary full" data-act="gakkaOk">OK</button></div>`);
}

/* ---------- 書き込み ---------- */
function outboxData(tok, type, title, body) {
  return { to: "student", type, studentToken: tok, instructorUid: S.uid, title, body, createdAt: serverTimestamp(), sent: false };
}
async function notifyStudent(tok, type, title, body) {
  await addDoc(collection(db, "outbox"), outboxData(tok, type, title, body));
  sendNow();
  await updateDoc(doc(db, "students", tok), { lastNotifiedAt: serverTimestamp() });
  const s = ST(tok); if (s) s.lastNotifiedAt = Timestamp.now();
}
function darkPairSheet(s, ds, a, type) {
  const dk = CFG.darkSeason || {}, L = PT(type).label;
  const fmt = k => `${+k.slice(0, 2)}月${+k.slice(3)}日`;
  sheet(`<h3>${L}として入れますか？</h3>
  <p>${esc(s.name)}（第${s.stage}段階）<br>${md(ds)} の <b>${spanText(a, type)}限</b></p>
  <div class="banner warn"><b>注意：${fmt(dk.from)}〜${fmt(dk.to)}は日没が早いため、${spanText(a, type)}限の${L}は原則入れられません。</b><br>それでも入れる場合は「警告を確認して入れる」を押してください。</div>
  <div class="list"><button class="btn accent full" data-act="assignPairForce" data-s="${s.token}" data-d="${ds}" data-p="${a}" data-t="${type}">警告を確認して入れる（強制）</button>
  <button class="btn full" data-act="close">やめる</button></div>`);
}
async function assignPair(tok, ds, a, type = "kiken", force, gk) {
  const s = ST(tok);
  const ev = evaluatePair(s, ds, a, type);
  if (!ev.ok) return toast(ev.reason);
  if (ev.dark && !force) return darkPairSheet(s, ds, a, type);
  if (!gk) { const r = gakkaAsk(s, ds, span(a, type), type); if (r.length) return gakkaSheet(s, r, () => assignPair(tok, ds, a, type, force, true)); }
  const L = PT(type).label;
  const status = S.confirmed ? "confirmed" : "draft";
  const pairId = `${tok.slice(0, 6)}_${ds}_${a}`;
  for (const q of span(a, type)) {
    const data = { instructorUid: S.uid, date: ds, period: q, weekId: wid(), status, cancelRequested: false, lessonType: type, pairId, result: null, stage: s.stage, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    if (type !== "kiken") { data.highway = true; if (ev.dark) data.forced = true; }
    const ref = await addDoc(collection(db, "students", tok, "bookings"), data);
    S.bookings.push({ id: ref.id, token: tok, ...data }); S.pending.push(S.bookings.at(-1));
  }
  if (S.confirmed) { await notifyStudent(tok, "added", "予約が追加されました", `${md(ds)} ${spanText(a, type)}限（${L}）`); toast(`${s.name}さんに通知しました`); }
  else toast(`${md(ds)} ${spanText(a, type)}限に${s.name}さんの${L}を入れました`);
  render();
}

async function assign(tok, ds, p, gk) {
  const s = ST(tok);
  const ev = evaluate(s, ds, p);
  if (ev.ok === false) return toast(ev.reason);
  if (!gk) { const r = gakkaAsk(s, ds, [p]); if (r.length) return gakkaSheet(s, r, () => assign(tok, ds, p, true)); }
  const status = S.confirmed ? "confirmed" : "draft";
  const data = { instructorUid: S.uid, date: ds, period: p, weekId: wid(), status, cancelRequested: false, result: null, stage: s.stage, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const ref = await addDoc(collection(db, "students", tok, "bookings"), data);
  S.bookings.push({ id: ref.id, token: tok, ...data }); S.pending.push(S.bookings.at(-1));
  if (S.confirmed) { await notifyStudent(tok, "added", "予約が追加されました", label(ds, p)); toast(`${s.name}さんに通知しました`); }
  else toast(`${label(ds, p)} に${s.name}さんを入れました`);
  render();
}
async function removeBooking(b, why) {
  // 危険予測・単独高速は2時限で1組。片方だけ残らないように、組ごと取り消す
  const group = b.pairId ? S.bookings.filter(x => x.pairId === b.pairId && x.token === b.token) : [b];
  if (!group.some(x => x.id === b.id)) group.push(b);
  for (const x of group) {
    const ref = doc(db, "students", x.token, "bookings", x.id);
    if (x.status === "draft") await deleteDoc(ref);
    else await updateDoc(ref, { status: "cancelled", cancelRequested: false, updatedAt: serverTimestamp() });
  }
  if (group.some(x => x.status !== "draft")) {
    const text = b.pairId ? `${md(b.date)} ${group.map(x => x.period).sort((m, n) => m - n).join("・")}限（${typeName(b)}）` : blabel(b);
    await notifyStudent(b.token, why === "approve" ? "cancelApproved" : "removed",
      why === "approve" ? "キャンセルが承認されました" : "予約が取り消しになりました", text);
  }
  const ids = group.map(x => x.id);
  S.bookings = S.bookings.filter(x => !ids.includes(x.id));
  S.pending = S.pending.filter(x => !ids.includes(x.id));
  S.cancelReqs = S.cancelReqs.filter(x => !ids.includes(x.id));
  if (b.highway && !b.pairId) {
    // 連続3時限でなくなったら、残りの時限の「高速」の記録を外す（単独高速は対象外）
    for (const x of S.bookings.filter(y => y.token === b.token && y.date === b.date && y.highway && !y.pairId)) {
      await updateDoc(doc(db, "students", x.token, "bookings", x.id), { highway: false, updatedAt: serverTimestamp() }); x.highway = false;
    }
  }
}
// 終わった教習のチェック。result：done（実施）／absent（欠席）。実施は doneCount に足す（危険予測は2時限で1、単独高速は2）
async function markResult(ids, result, mk = null) {
  const list = S.pending.filter(b => ids.includes(b.id));
  if (!list.length) return;
  const tok = list[0].token, s = ST(tok), it = lessonItems(list)[0];
  const batch = writeBatch(db);
  list.forEach(b => batch.update(doc(db, "students", tok, "bookings", b.id), { result, resultAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  const text = `${md(it.date)} ${list.map(b => b.period).sort((m, n) => m - n).join("・")}限${typeName(list[0]) ? `（${typeName(list[0])}）` : ""}`;
  if (result === "done") {
    const upd = { doneCount: increment(it.units) };
    if (it.lessonType === "kiken") upd.kikenDone = true;
    if (isHwType(it.lessonType)) upd.hwDone = true;
    if (mk) upd[`mikiwame${s.stage}`] = { ...mk, date: it.date, bookingIds: ids, at: Timestamp.now() };
    batch.update(doc(db, "students", tok), upd);
  } else {
    batch.set(doc(collection(db, "outbox")), outboxData(tok, "absent", "欠席のお知らせ", `${text} は欠席として記録しました。次の予約は担当指導員からお知らせします。`));
    batch.update(doc(db, "students", tok), { lastNotifiedAt: serverTimestamp() });
  }
  await batch.commit();
  if (result !== "done") sendNow();
  if (s) {
    if (result === "done") { s.doneCount = (s.doneCount || 0) + it.units; if (it.lessonType === "kiken") s.kikenDone = true; if (isHwType(it.lessonType)) s.hwDone = true; if (mk) s[`mikiwame${s.stage}`] = { ...mk, date: it.date, bookingIds: ids }; }
    else s.lastNotifiedAt = Timestamp.now();
  }
  S.pending = S.pending.filter(b => !ids.includes(b.id));
  S.bookings.forEach(b => { if (ids.includes(b.id)) b.result = result; });
  render();
  if (!mk || mk.gakkaDone) toast(result === "done" ? `${s ? s.name : ""}さん ${text} を実施にしました${mk ? `（みきわめ${mk.passed ? "合格" : "不合格"}）` : ""}` : `${s ? s.name : ""}さんに欠席を通知しました`);
  else sheet(`<h3>${esc(s ? s.name : "")}さんを実施にしました（みきわめ${mk.passed ? "合格" : "不合格"}）</h3>
    <div class="banner warn">「<b>検定日の2日前までに学科及び効果測定を終わらせておかないといけません</b>」ということを教習生に伝えてください。</div>
    <div class="banner warn">学科及び効果測定が終了していない教習生に対する<b>みきわめ報告書</b>を提出してください。</div>
    <div class="list"><button class="btn primary full" data-act="close">OK</button></div>`);
}
// みきわめの教習を「実施」にする時のフォーム（合否・検定日・学科及び効果測定）
function mikiwameSheet(s, it, ids) {
  const r = (n, v, t) => `<label class="radio"><input type="radio" name="${n}" value="${v}"> ${t}</label>`;
  sheet(`<h3>みきわめ（第${s.stage}段階 ${it.no}時限目）</h3>
  <p>${esc(s.name)}<br>${md(it.date)} ${it.bookings.map(b => b.period).join("・")}限</p>
  <div class="field"><label>みきわめの結果</label><div class="radios">${r("mk_pass", "1", "合格")}${r("mk_pass", "0", "不合格")}</div></div>
  <div id="mk_kentei" hidden><div class="field"><label for="mk_date">検定日</label><input id="mk_date" type="date"></div>
    <label class="radio" style="margin:-4px 0 12px"><input type="checkbox" id="mk_und"> 検定日は未確定</label></div>
  <div class="field"><label>学科及び効果測定</label><div class="radios">${r("mk_gakka", "1", "終わっている")}${r("mk_gakka", "0", "終わっていない")}</div></div>
  <div class="list"><button class="btn accent full" data-act="mkOk" data-ids="${ids.join(",")}">OK</button><button class="btn full" data-act="close">やめる</button></div>`);
}
// チェックの付け間違いを戻す
async function unmarkResult(b) {
  const group = (b.pairId ? S.bookings.filter(x => x.pairId === b.pairId && x.token === b.token) : [b]);
  const s = ST(b.token), it = lessonItems(group)[0], was = b.result;
  const batch = writeBatch(db);
  group.forEach(x => batch.update(doc(db, "students", x.token, "bookings", x.id), { result: null, resultAt: null, updatedAt: serverTimestamp() }));
  if (was === "done") {
    const upd = { doneCount: increment(-it.units) };
    if (it.lessonType === "kiken") upd.kikenDone = false;
    if (isHwType(it.lessonType)) upd.hwDone = false;
    const mkey = s && Object.keys(s).find(k => /^mikiwame\d$/.test(k) && s[k] && (s[k].bookingIds || []).some(id => group.some(x => x.id === id)));
    if (mkey) upd[mkey] = null;
    batch.update(doc(db, "students", b.token), upd);
  }
  await batch.commit();
  if (s && was === "done") {
    s.doneCount = (s.doneCount || 0) - it.units; if (it.lessonType === "kiken") s.kikenDone = false; if (isHwType(it.lessonType)) s.hwDone = false;
    Object.keys(s).forEach(k => { if (/^mikiwame\d$/.test(k) && s[k] && (s[k].bookingIds || []).some(id => group.some(x => x.id === id))) s[k] = null; });
  }
  group.forEach(x => { x.result = null; if (!S.pending.some(y => y.id === x.id)) S.pending.push(x); });
  render(); toast("チェックを取り消しました");
}

async function confirmWeek() {
  const drafts = S.bookings.filter(b => b.status === "draft");
  const byStudent = {};
  drafts.forEach(b => { (byStudent[b.token] = byStudent[b.token] || []).push(b); });
  const batch = writeBatch(db);
  drafts.forEach(b => batch.update(doc(db, "students", b.token, "bookings", b.id), { status: "confirmed", updatedAt: serverTimestamp() }));
  batch.set(doc(db, "weeks", `${S.uid}_${wid()}`), { instructorUid: S.uid, weekId: wid(), confirmedAt: serverTimestamp() });
  Object.entries(byStudent).forEach(([tok, list]) => {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period);
    const body = list.slice(0, 3).map(blabel).join("、") + (list.length > 3 ? ` ほか${list.length - 3}件` : "");
    batch.set(doc(collection(db, "outbox")), outboxData(tok, "weekly", `${md(days()[0])}からの週の予約が決まりました`, body));
    batch.update(doc(db, "students", tok), { lastNotifiedAt: serverTimestamp() });
  });
  await batch.commit();
  sendNow();
  drafts.forEach(b => b.status = "confirmed");
  S.pending.forEach(b => { if (drafts.some(d => d.id === b.id)) b.status = "confirmed"; });
  Object.keys(byStudent).forEach(tok => { const s = ST(tok); if (s) s.lastNotifiedAt = Timestamp.now(); });
  S.confirmed = true; render(); toast(`${Object.keys(byStudent).length}人に通知しました`);
}

/* ---------- 画面の切り替え（予約の割り当て／教習生の管理） ---------- */
// 教習生の管理は js/admin.js（data-mode="staff"）が #mng に描く
// 画面の切り替え：assign（予約の管理）／manage（教習生の管理）／settings（設定）
function showView(v, quiet) {
  S.view = v;
  document.getElementById("appWrap").hidden = v !== "assign";
  document.getElementById("mngWrap").hidden = v !== "manage";
  document.getElementById("setWrap").hidden = v !== "settings";
  applyView();
  if (v === "manage") document.dispatchEvent(new Event("mng:open"));
  if (v === "settings") renderSettings();
  if (quiet) return;
  renderNav();
  try { history.replaceState(null, "", v === "assign" ? location.pathname + location.search : "#" + v); } catch (e) { }
  window.scrollTo(0, 0);
}

/* ---------- 画面の切り替えタブ（PCは左端、スマホは画面の下。ログイン中はいつも出す） ---------- */
const ICON = {
  manage: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.6c2.9-.2 5 1.4 5.5 4.4"/></svg>',
  assign: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 13.5h3M13.5 13.5h3M7.5 17h3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>'
};
const NAV = [["manage", "教習生の管理"], ["assign", "予約の管理"], ["settings", "設定"]];
function renderNav() {
  const nav = document.getElementById("tabnav"), on = !!(S.uid && S.me);
  document.body.classList.toggle("shell", on); nav.hidden = !on;
  if (!on) { nav.innerHTML = ""; return; }
  nav.innerHTML = `<div class="tn-head"><b>${esc(CFG.schoolName)}</b><small>${esc(S.me.name)} 指導員</small></div>
    <div class="tn-tabs" role="tablist">${NAV.map(([v, t]) => `<button role="tab" aria-selected="${S.view === v}" data-act="view" data-v="${v}">${ICON[v]}<span>${t}</span></button>`).join("")}</div>
    <div class="tn-foot"><a class="linkbtn" href="guide-instructor.html">使い方</a><button class="linkbtn" data-act="logout">ログアウト</button></div>`;
}

/* ---------- 設定 ---------- */
const pc = (k, v, cur, t) => `<button class="chip" aria-pressed="${cur === v}" data-act="pref" data-k="${k}" data-v="${v}">${t}</button>`;
function renderSettings() {
  if (!S.me) return;
  const sw = getPref("startweek", "next"), sm = getPref("startmode", "slot"), bo = getPref("balopen", "0");
  document.getElementById("set").innerHTML = `<div class="topbar"><div><h1>設定</h1><small>${esc(S.me.name)} 指導員</small></div></div>
  <section class="panel"><div class="body setpage">
  ${lookSettingsHtml()}
  <div class="setgrp"><h3>予約の管理</h3>
    <div class="setlabel">開いた時に表示する週</div><div class="chips wrapchips">${pc("startweek", "next", sw, "来週")}${pc("startweek", "this", sw, "今週")}</div>
    <div class="setlabel">最初の割り当て方</div><div class="chips wrapchips">${pc("startmode", "slot", sm, "枠から選ぶ")}${pc("startmode", "student", sm, "教習生から選ぶ")}</div>
    <div class="setlabel">「今週の割り振り」の一覧</div><div class="chips wrapchips">${pc("balopen", "1", bo, "最初から開いておく")}${pc("balopen", "0", bo, "閉じておく")}</div>
    <p class="setnote">「開いた時」の設定は、次に画面を開いた時から使われます。</p></div>
  <div class="setgrp"><h3>通知・アプリ</h3>${pushStatusHtml()}<div class="list"><button class="btn full" data-act="push">この端末で通知を受け取る</button>${installButton() ? `<div>${installButton()}</div>` : ""}</div>
    <p class="setnote">キャンセル希望や期限が近い教習生のお知らせが届きます。</p></div>
  <div class="setgrp"><h3>アカウント</h3><div class="item"><div><div class="t">${esc(S.me.name)}</div><div class="s">${esc(S.me.email || "")}</div></div><button class="btn" data-act="logout">ログアウト</button></div></div>
  <div class="setgrp"><h3>困った時は</h3><div class="list"><a class="btn full center" style="text-decoration:none" href="guide-instructor.html">使い方を見る</a></div>
    <p class="setnote">${esc(CFG.schoolName)}　電話 <span class="tel">${esc(CFG.schoolTel)}</span></p></div>
  </div></section>`;
}
document.addEventListener("pref:change", e => {
  if (e.detail.k === "balopen") S.balOpen = e.detail.v === "1";
  if (S.view === "settings") renderSettings();
  if (S.uid && S.me) render();
});
onViewChange(() => { if (S.uid && S.me) { render(); if (S.view === "settings") renderSettings(); } });

/* ---------- 操作 ---------- */
document.addEventListener("click", async e => {
  if (onOverlayClose(e)) return;
  const t = e.target.closest("[data-act]"); if (!t) return;
  const a = t.dataset.act;
  try {
    if (a === "login") {
      const em = document.getElementById("em").value.trim(), pw = document.getElementById("pw").value;
      if (!em || !pw) return;
      t.disabled = true;
      try { await signInWithEmailAndPassword(auth, em, pw); } catch (err) { renderLogin("メールアドレスかパスワードが違います。"); }
    }
    else if (a === "logout") { stopWatch(); stopCancelWatch(); await signOut(auth); }
    else if (a === "view") { showView(t.dataset.v); if (t.dataset.v === "assign" && S.uid) await loadWeek(); }
    else if (a === "reload") { await loadWeek(); }
    else if (a === "retry") location.reload();
    else if (a === "wk") { S.week = addDays(S.week, +t.dataset.v); S.pick = null; await loadWeek(); }
    else if (a === "balPick") { S.mode = "student"; S.pick = t.dataset.s; S.ptype = null; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else if (a === "mode") { S.mode = t.dataset.v; if (S.mode === "slot") S.pick = null; render(); }
    else if (a === "pick") { S.pick = S.pick === t.dataset.s ? null : t.dataset.s; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else if (a === "unpick") { S.pick = null; S.ptype = null; render(); }
    else if (a === "open") { slotSheet(t.dataset.d, +t.dataset.p); }
    else if (a === "assign") { t.disabled = true; closeSheet(); await assign(t.dataset.s, t.dataset.d, +t.dataset.p); }
    else if (a === "assignPair") { t.disabled = true; closeSheet(); await assignPair(t.dataset.s, t.dataset.d, +t.dataset.p, t.dataset.t || "kiken"); }
    else if (a === "assignPairForce") { t.disabled = true; closeSheet(); await assignPair(t.dataset.s, t.dataset.d, +t.dataset.p, t.dataset.t, true); }
    else if (a === "sheetType") { slotSheet(t.dataset.d, +t.dataset.p, t.dataset.v); }
    else if (a === "pairStart") { slotSheet(t.dataset.d, +t.dataset.p, t.dataset.t || "kiken", +t.dataset.v); }
    else if (a === "ptype") { S.ptype = t.dataset.v || null; render(); }
    else if (a === "gakkaOk") { const go = S.gakkaGo; S.gakkaGo = null; t.disabled = true; closeSheet(); if (go) await go(); }
    else if (a === "booked") {
      const b = S.bookings.find(x => x.id === t.dataset.id); const s = ST(b.token);
      const it = itemOf(b);
      const head = `<h3>${label(b.date, b.period)}</h3><p><b>${esc(s ? s.name : "")}</b>（第${s ? s.stage : "-"}段階）${it && s ? `・${noText(s, it)}` : ""}${typeName(b) ? `<br>${typeName(b)}${b.pairId ? `（${LEN(b.lessonType)}時限まとめて扱います）` : ""}` : ""}`;
      if (b.result) {
        sheet(`${head}<br><span class="tag ${b.result === "done" ? "ok" : "wait"}">${b.result === "done" ? "実施済み" : "欠席"}</span></p>
        <div class="list"><button class="btn full" data-act="unmark" data-id="${b.id}">チェックを取り消す（付け間違いの時）</button><button class="btn full" data-act="close">閉じる</button></div>`);
      } else {
        sheet(`${head}<br><span style="font-size:13px;color:var(--muted)">${b.status === "draft" ? "まだ確定していません。" : "教習生に通知済みです。取り消すと自動で通知されます。"}</span></p>
        <div class="list"><button class="btn full" data-act="swap" data-id="${b.id}">別の教習生に変える</button><button class="btn accent full" data-act="unbook" data-id="${b.id}">この予約を取り消す</button><button class="btn full" data-act="close">閉じる</button></div>`);
      }
    }
    else if (a === "unbook") { closeSheet(); const b = S.bookings.find(x => x.id === t.dataset.id); await removeBooking(b, "remove"); render(); toast("取り消しました"); }
    else if (a === "swap") { closeSheet(); const b = S.bookings.find(x => x.id === t.dataset.id); await removeBooking(b, "remove"); render(); slotSheet(b.date, b.period, b.lessonType || "normal"); }
    else if (a === "confirm") { t.disabled = true; await confirmWeek(); }
    else if (a === "markDone" || a === "markAbsent") {
      const ids = t.dataset.ids.split(",");
      if (a === "markAbsent" && !confirm("欠席として記録し、教習生に通知します。よろしいですか？")) return;
      if (a === "markDone") {
        const s = ST(S.pending.find(b => b.id === ids[0])?.token), it = s && planOf(s).items.find(x => x.bookings.some(b => b.id === ids[0]));
        if (it && isMikiwame(s, it)) return mikiwameSheet(s, it, ids);
      }
      t.disabled = true; await markResult(ids, a === "markDone" ? "done" : "absent");
    }
    else if (a === "mkOk") {
      const val = n => (document.querySelector(`input[name="${n}"]:checked`) || {}).value;
      const pass = val("mk_pass"), gakka = val("mk_gakka");
      const date = document.getElementById("mk_date").value, und = document.getElementById("mk_und").checked;
      if (!pass) return toast("みきわめの結果を選んでください");
      if (pass === "1" && !date && !und) return toast("検定日を入れるか、「未確定」にチェックしてください");
      if (!gakka) return toast("学科及び効果測定が終わっているか選んでください");
      const mk = { passed: pass === "1", kenteiDate: pass === "1" && !und ? date : null, kenteiUndecided: pass === "1" && und, gakkaDone: gakka === "1" };
      t.disabled = true; closeSheet(); await markResult(t.dataset.ids.split(","), "done", mk);
    }
    else if (a === "unmark") { closeSheet(); await unmarkResult(S.bookings.find(x => x.id === t.dataset.id)); }
    else if (a === "approve") {
      const b = S.cancelReqs.find(x => x.id === t.dataset.id); t.disabled = true;
      await removeBooking(b, "approve"); render(); toast("キャンセルを承認しました");
    }
    else if (a === "reject") {
      const b = S.cancelReqs.find(x => x.id === t.dataset.id); t.disabled = true;
      await updateDoc(doc(db, "students", b.token, "bookings", b.id), { cancelRequested: false, updatedAt: serverTimestamp() });
      await notifyStudent(b.token, "cancelRejected", "キャンセル希望についてのお知らせ", `${label(b.date, b.period)} は予約のままです。詳しくは学園までお問い合わせください。`);
      S.cancelReqs = S.cancelReqs.filter(x => x.id !== b.id);
      const lb = S.bookings.find(x => x.id === b.id); if (lb) lb.cancelRequested = false;
      render(); toast("却下を通知しました");
    }
    else if (a === "renotify") { await notifyStudent(t.dataset.s, "reminder", "予約の確認をお願いします", "アプリを開いて「確認しました」を押してください。"); render(); toast("再通知しました"); }
    else if (a === "renotifyAll") {
      const un = S.students.filter(s => weekCount(s.token) > 0 && unacked(s)); t.disabled = true;
      for (const s of un) await notifyStudent(s.token, "reminder", "予約の確認をお願いします", "アプリを開いて「確認しました」を押してください。");
      render(); toast(`${un.length}人に再通知しました`);
    }
    else if (a === "push") {
      const r = await enablePush(async tok => {
        const cur = S.me.fcmTokens || [];
        if (cur.includes(tok)) return;
        const next = [...cur, tok].slice(-CFG.maxFcmTokens);
        await updateDoc(doc(db, "instructors", S.uid), { fcmTokens: next }); S.me.fcmTokens = next;
      });
      toast(r.ok ? "キャンセル希望などの通知を受け取れるようになりました" : pushReasonText(r.reason));
      if (S.view === "settings") renderSettings();
    }
  } catch (err) { toast(friendlyError(err)); render(); }
});
// 「今週の割り振り」を開いたかどうかを覚えておく（描き直しても閉じないように）
document.addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("bal")) S.balOpen = e.target.open; }, true);
// みきわめのフォーム：合格の時だけ検定日を出す。「未確定」なら日付は入れない
document.addEventListener("change", e => {
  if (e.target.name === "mk_pass") document.getElementById("mk_kentei").hidden = e.target.value !== "1";
  if (e.target.id === "mk_und") { const d = document.getElementById("mk_date"); d.disabled = e.target.checked; if (e.target.checked) d.value = ""; }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pw") document.querySelector('[data-act="login"]').click(); });
// 手元の確認用（デモの時だけ）：ルール判定を外から呼べるようにする
if (DEMO) self.__t = { S, evaluate, evaluatePair, specialTypes, assign, assignPair, removeBooking, days, render };
