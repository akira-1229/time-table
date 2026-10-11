// 指導員の画面：週ごとの割り当て、確定と通知、キャンセル希望の対応、確認状況
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "./backend.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, getDocs,
  serverTimestamp, writeBatch, Timestamp, onSnapshot, increment
} from "./backend.js";
import {
  CFG, app as fbApp, db, WD, P, ymOf, dateStr, parseDate, addDays, mondayOf, today, md, label, slotKey, esc,
  toast, sheet, closeSheet, onOverlayClose, friendlyError, enablePush, pushReasonText, listenForeground,
  installButton, firstVisitInstall, lessonPlan, lessonItems, lessonMin, doneOf, bookingEnd, expiriesOf, expiryText, DEMO } from "./common.js";

const auth = getAuth(fbApp);
const root = document.getElementById("app");
const S = {
  uid: null, me: null, week: addDays(mondayOf(today()), 7), mode: "slot", pick: null, ptype: null,
  students: [], avail: {}, late: {}, bookings: [], pending: [], confirmed: false, cancelReqs: [], loading: false
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
  <button class="btn accent full" data-act="login">ログイン</button></form>${installButton() ? `<p class="center" style="margin:10px 0 0">${installButton()}</p>` : ""}</div></section>`;
  // QRのURL（?e=メールアドレス）から開いた時は、メールアドレスを入れておく
  const e = new URLSearchParams(location.search).get("e"); if (e && !document.getElementById("em").value) document.getElementById("em").value = e;
}
firstVisitInstall("staff");
onAuthStateChanged(auth, async user => {
  if (!user) { stopWatch(); stopCancelWatch(); S.uid = null; renderLogin(); return; }
  S.uid = user.uid;
  try {
    const me = await getDoc(doc(db, "instructors", user.uid));
    if (!me.exists()) { await signOut(auth); renderLogin("指導員として登録されていません。事務所に確認してください。"); return; }
    S.me = me.data();
    listenForeground(() => loadWeek());
    watchCancelReqs();
    await loadWeek();
  } catch (e) { renderLogin(friendlyError(e)); }
});

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
  } catch (e) { toast(friendlyError(e)); }
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
  }, e => toast(friendlyError(e)));
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
const noText = (s, it) => it ? `${it.units > 1 ? `${it.no}・${it.no + 1}` : it.no}時限目${it.no + it.units - 1 > lessonMin(s.stage) ? "（延長）" : ""}` : "";

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
// 割り当てできるかの判定
//   ok:true  … そのまま入れられる
//   ok:"hw"  … 連続3時限になるため、高速教習としてなら入れられる（dark:true は日没が早い期間の警告付き）
//   ok:false … 入れられない（reason に理由）
function evaluate(s, ds, p) {
  if (!isFree(s.token, ds, p)) return { ok: false, reason: "空いていない枠です" };
  if (bookAt(ds, p)) return { ok: false, reason: "この枠はすでに予約が入っています" };
  if (dayCount(s.token, ds) >= dayMax(s)) return { ok: false, reason: `この日は上限の${dayMax(s)}時限まで入っています` };
  if ((CFG.noTripleStages || []).includes(s.stage)) {
    const ps = [...dayPeriods(s.token, ds), p].sort((a, b) => a - b);
    for (let i = 0; i + 2 < ps.length; i++) {
      const tri = ps.slice(i, i + 3);
      const brk = CFG.breakAfter || [];
      const linked = (x, y) => y === x + 1 && !brk.includes(x);   // 休みをはさまずに続いているか
      if (linked(tri[0], tri[1]) && linked(tri[1], tri[2])) {
        if (S.bookings.some(b => b.token === s.token && b.date === ds && b.pairId && tri.includes(b.period)))
          return { ok: false, reason: `ほかの予約と合わせて連続3時限（${tri.join("・")}限）になります` };
        if (!hasSpecial(s)) return { ok: false, reason: `連続3時限（${tri.join("・")}限）は入れられません` };
        if (!(CFG.highwaySets || []).some(set => sameSet(set, tri)))
          return { ok: false, reason: `連続3時限（${tri.join("・")}限）は入れられません。高速教習は ${(CFG.highwaySets || []).map(x => x.join("・")).join(" / ")} 限のみです` };
        const dark = inDarkSeason(ds) && ((CFG.darkSeason || {}).sets || []).some(set => sameSet(set, tri));
        const sq = seqCheck(s, [{ token: s.token, date: ds, period: p }]);
        if (sq) return { ok: false, reason: sq };
        return { ok: "hw", tri, dark };
      }
    }
  }
  const sq = seqCheck(s, [{ token: s.token, date: ds, period: p }]);
  if (sq) return { ok: false, reason: sq };
  return { ok: true };
}
const canBook = (s, ds, p) => evaluate(s, ds, p).ok !== false;

/* ---------- 2時限連続の教習（危険予測・単独高速） ---------- */
// type は "kiken"（危険予測）か "hwSolo"（単独高速）
const KK = () => CFG.kiken || { label: "危険予測", noPairAfter: [] };
const hasSpecial = s => (CFG.specialStages || [2]).includes(s.stage);                 // 高速教習・危険予測・単独高速がある段階か
const PT = type => type === "hwSolo" ? (CFG.hwSolo || { label: "単独高速", noPairAfter: [3] }) : KK();
const pairOk = (a, type = "kiken") => a >= 1 && a + 1 <= 10 && !PT(type).noPairAfter.includes(a);   // a限と a+1限を続けて入れられるか
const pairsWith = (p, type = "kiken") => [p - 1, p].filter(a => pairOk(a, type));                     // p限を含む2時限連続の候補（開始時限）
// 危険予測→単独高速の決まった組（例：危険予測4・5限→単独高速6・7限）になっているか
function isCombo(list) {
  if (list.length !== 4) return false;
  const at = (type, a) => list.some(x => x.type === type && x.period === a) && list.some(x => x.type === type && x.period === a + 1);
  return (CFG.pairCombos || []).some(c => at("kiken", c.kiken) && at("hwSolo", c.hwSolo));
}
//   ok:true（dark:true は日没が早い期間の警告付き）／ok:false（reason に理由）
function evaluatePair(s, ds, a, type = "kiken") {
  const L = PT(type).label;
  if (!hasSpecial(s)) return { ok: false, reason: `第${s.stage}段階には${L}はありません` };
  if (!pairOk(a, type)) return { ok: false, reason: `${a}・${a + 1}限は休憩をはさむため、${L}は入れられません` };
  for (const q of [a, a + 1]) {
    if (!isFree(s.token, ds, q)) return { ok: false, reason: `${q}限が空いていません` };
    if (bookAt(ds, q)) return { ok: false, reason: `${q}限はすでに予約が入っています` };
  }
  const mine = S.bookings.filter(b => b.token === s.token && b.date === ds);
  const list = [...mine.map(b => ({ period: b.period, type: b.lessonType || "" })), { period: a, type }, { period: a + 1, type }];
  const combo = isCombo(list);
  if (!combo) {
    // 単独高速→危険予測の順に続けるのは不可（危険予測→単独高速の順のみ）
    const other = type === "kiken" ? "hwSolo" : "kiken";
    const before = type === "kiken" ? a - 1 : a + 2, near = mine.find(b => b.period === before && b.lessonType === other);
    if (near) return { ok: false, reason: `${PT("hwSolo").label}のすぐ後に${KK().label}は入れられません（${KK().label}→${PT("hwSolo").label}の順で、決まった時限のみ）` };
    if (list.length > dayMax(s)) return { ok: false, reason: `1日の上限（${dayMax(s)}時限）を超えます` };
    if ((CFG.noTripleStages || []).includes(s.stage)) {
      const brk = CFG.breakAfter || [];
      const linked = (x, y) => y === x + 1 && !brk.includes(x);
      const ps = list.map(x => x.period).sort((x, y) => x - y);
      for (let i = 0; i + 2 < ps.length; i++) if (linked(ps[i], ps[i + 1]) && linked(ps[i + 1], ps[i + 2]))
        return { ok: false, reason: `ほかの予約と合わせて連続3時限（${ps.slice(i, i + 3).join("・")}限）になります` };
    }
  }
  if (type === "kiken" && (s.kikenDone || pendingOf(s).some(b => b.lessonType === "kiken")))
    return { ok: false, reason: s.kikenDone ? `${L}は受講済みです` : `${L}はすでに予約が入っています` };
  const sq = seqCheck(s, [a, a + 1].map(q => ({ token: s.token, date: ds, period: q, lessonType: type, pairId: "new" })));
  if (sq) return { ok: false, reason: sq };
  const dark = type === "hwSolo" && inDarkSeason(ds) && ((CFG.darkSeason || {}).hwSoloSets || []).some(set => sameSet(set, [a, a + 1]));
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
  return `第${s.stage}段階・実施${doneOf(s)}/${min}時限${pl.items.length ? `・予定${pl.total - doneOf(s)}` : ""}${min && pl.total > min ? "・延長あり" : ""}・今週${weekCount(s.token)}件${dl !== null ? `・期限まであと${dl}日` : ""}`;
};

/* ---------- 画面 ---------- */
function render() {
  if (!S.uid) return;
  const ds = days(); const wEnd = ds[ds.length - 1];
  let h = `<div class="topbar"><div><h1>${esc(S.me ? S.me.name : "")} さん</h1><small>担当 ${S.students.length}人・<a href="manage.html">教習生の管理</a></small></div>
    <span>${installButton()}<button class="linkbtn" data-act="push">通知</button><button class="linkbtn" data-act="logout">ログアウト</button></span></div>`;
  h += `<div class="weeknav"><button class="btn" data-act="wk" data-v="-7" aria-label="前の週">◀</button><b>${md(ds[0])}〜${md(wEnd)}</b><button class="btn" data-act="wk" data-v="7" aria-label="次の週">▶</button></div>`;
  if (S.loading) { root.innerHTML = h + `<div class="loading">読み込み中…</div>`; return; }
  h += `<section class="panel"><div class="phead"><div><h2>割り当て</h2><small>マス目をタップして教習生を入れます</small></div>
    ${S.confirmed ? '<span class="tag ok">確定済み</span>' : '<span class="tag draft">未確定</span>'}</div><div class="body">`;
  const unchecked = lessonItems(S.pending.filter(b => b.status === "confirmed" && bookingEnd(b) <= new Date()));
  if (unchecked.length) {
    h += `<div class="banner warn"><b>終わった教習のチェックが${unchecked.length}件あります</b><br><span style="font-size:12px">教習生が来たら「実施」、来なかったら「欠席」を押してください（欠席は教習生に通知されます）。</span>`;
    unchecked.forEach(it => {
      const s = ST(it.bookings[0].token), ids = it.bookings.map(b => b.id).join(",");
      const tn = it.lessonType ? `（${PT(it.lessonType).label}）` : it.highway ? "（高速）" : "";
      h += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span>${esc(s ? s.name : "")}<br>${md(it.date)} ${it.bookings.map(b => b.period).join("・")}限${tn}</span><span style="display:flex;gap:6px"><button class="btn" data-act="markAbsent" data-ids="${ids}">欠席</button><button class="btn accent" data-act="markDone" data-ids="${ids}">実施</button></span></div>`;
    });
    h += `</div>`;
  }
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
  const none = S.students.filter(s => weekCount(s.token) === 0).length;
  const total = ds.length * 10;
  h += `<div class="sum"><div><b>${S.bookings.length}</b>予約した枠</div><div class="${none ? "alert" : ""}"><b>${none}</b>まだ予約のない人</div><div><b>${total - S.bookings.length}</b>空いている枠</div></div>`;
  h += `<div class="seg" role="group" aria-label="割り当て方"><button aria-pressed="${S.mode === "slot"}" data-act="mode" data-v="slot">枠から選ぶ</button><button aria-pressed="${S.mode === "student"}" data-act="mode" data-v="student">教習生から選ぶ</button></div>`;

  let maxN = 1; ds.forEach(d => { for (let p = 1; p <= 10; p++) maxN = Math.max(maxN, S.students.filter(s => isFree(s.token, d, p)).length); });
  const T1 = Math.floor(maxN / 3), T2 = Math.floor(maxN * 2 / 3);
  const pk = S.mode === "student" && S.pick ? ST(S.pick) : null;
  if (S.mode === "student") {
    h += pk ? `<div class="picking"><span><b>${esc(pk.name)}</b>を割り当て中<br><span style="font-size:12px;color:var(--muted)">光っている枠をタップすると予約されます（第${pk.stage}段階・1日${dayMax(pk)}時限まで${(CFG.noTripleStages || []).includes(pk.stage) ? "・連続3時限は高速教習のみ" : ""}）</span></span><button class="btn" data-act="unpick">やめる</button></div>
      ${hasSpecial(pk) ? `<div class="seg" role="group" aria-label="教習の種類"><button aria-pressed="${!S.ptype}" data-act="ptype" data-v="">通常</button><button aria-pressed="${S.ptype === "kiken"}" data-act="ptype" data-v="kiken">${KK().label}</button><button aria-pressed="${S.ptype === "hwSolo"}" data-act="ptype" data-v="hwSolo">${PT("hwSolo").label}</button></div>` : ""}
      ${S.ptype && hasSpecial(pk) ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px">${PT(S.ptype).label}は2時限連続です。光っているマスは開始の時限で、タップするとその時限と次の時限の2つがまとめて入ります。</div>` : ""}`
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
        h += `<td><button class="wc ${ok ? `cand ${S.ptype === "kiken" ? "kk" : "hw"}` : "off"}" ${ok ? `data-act="assignPair" data-s="${pk.token}" data-d="${d}" data-p="${p}" data-t="${S.ptype}"` : "disabled"} aria-label="${lb}${ok ? `から${L}で割り当て可${ev.dark ? "（日没が早い期間のため要確認）" : ""}` : ""}">${ok ? `${p}・${p + 1}<small>${L}${ev.dark ? "・要確認" : ""}</small>` : ""}</button></td>`;
      } else if (pk) {
        const ev = evaluate(pk, d, p); const ok = ev.ok !== false;
        const mark = ev.ok === "hw" ? (ev.dark ? "高速<small>要確認</small>" : "高速") : "◯";
        h += `<td><button class="wc ${ok ? "cand" : "off"} ${ev.ok === "hw" ? "hw" : ""}" ${ok ? `data-act="assign" data-s="${pk.token}" data-d="${d}" data-p="${p}"` : "disabled"} aria-label="${lb}${ok ? (ev.ok === "hw" ? " 高速教習なら割り当て可" : " 割り当て可") : ""}">${ok ? mark : ""}</button></td>`;
      } else {
        const n = S.students.filter(s => isFree(s.token, d, p)).length;
        const c = n === 0 ? "" : n <= T1 ? "lv1" : n <= T2 ? "lv2" : "lv3";
        h += `<td><button class="wc ${c}" ${n && S.mode === "slot" ? `data-act="open" data-d="${d}" data-p="${p}"` : "disabled"} aria-label="${lb} 空き${n}人">${n ? `${n}人<span class="bar"><i style="width:${Math.round(n / maxN * 100)}%"></i></span>` : "—"}</button></td>`;
      }
    });
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;

  if (S.mode === "student") {
    const list = S.students.slice().sort((a, b) => weekCount(a.token) - weekCount(b.token) || String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
    h += `<h3>担当の教習生（予約の少ない順）</h3><div class="slist">`;
    list.forEach(s => {
      const n = weekCount(s.token);
      h += `<button class="srow" aria-pressed="${S.pick === s.token}" data-act="pick" data-s="${s.token}"><span><span class="t">${esc(s.name)}</span>${S.late[s.token] ? ' <span class="tag late">締切後に変更あり</span>' : ""}<br><span class="s">${info(s)}・この週の空き${freeCount(s)}枠</span></span><span class="cnt ${n ? "some" : "zero"}">${n ? `予約${n}件` : "予約なし"}</span></button>`;
    });
    h += `</div>`;
  }

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
  root.innerHTML = h + `</div></section><p class="center"><button class="linkbtn" data-act="reload">最新の情報に更新</button></p>`;
}

function slotSheet(ds, p, type = "normal", start) {
  const seg = `<div class="seg" role="group" aria-label="教習の種類">${[["normal", "通常"], ["kiken", KK().label], ["hwSolo", PT("hwSolo").label]].map(([v, t]) => `<button aria-pressed="${type === v}" data-act="sheetType" data-v="${v}" data-d="${ds}" data-p="${p}">${t}</button>`).join("")}</div>`;
  if (type !== "normal") return pairSheet(ds, p, start, seg, type);
  const c = candidates(ds, p);
  let h = `<h3>${label(ds, p)}（${P[p][0]}〜）<br><span style="font-size:13px;font-weight:400;color:var(--muted)">入れる教習生 ${c.length}人・予約の少ない順</span></h3>${seg}<div class="list">`;
  c.forEach(s => {
    const ev = evaluate(s, ds, p);
    const note = ev.ok === false ? `<div class="s" style="color:var(--orange)">${esc(ev.reason)}</div>`
      : ev.ok === "hw" ? `<div class="s" style="color:var(--orange)">連続3時限（${ev.tri.join("・")}限）になるため、高速教習のみ${ev.dark ? "。日没が早い期間のため要確認" : ""}</div>` : "";
    const btn = ev.ok === "hw" ? "高速教習で入れる" : "割り当てる";
    h += `<div class="item"><div><div class="t">${esc(s.name)}${S.late[s.token] ? ' <span class="tag late">締切後に変更</span>' : ""}</div><div class="s">${info(s)}</div>${note}</div><button class="btn accent" data-act="assign" data-s="${s.token}" data-d="${ds}" data-p="${p}" ${ev.ok === false ? "disabled" : ""}>${btn}</button></div>`;
  });
  if (!c.length) h += `<div class="hist"><div>この枠が空いている教習生はいません。</div></div>`;
  sheet(h + `</div><button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
}

function pairSheet(ds, p, start, seg, type) {
  const pairs = pairsWith(p, type), L = PT(type).label;
  let h = `<h3>${md(ds)} ${L}（2時限連続）</h3>${seg}`;
  if (!pairs.length) {
    h += `<div class="banner warn">${p}限は前後どちらも休憩をはさむため、${L}（2時限連続）は入れられません。</div>`;
    return sheet(h + `<button class="btn full" data-act="close">閉じる</button>`);
  }
  const a = pairs.includes(start) ? start : pairs[0];
  h += `<div class="chips" role="group" aria-label="時限" style="margin-bottom:8px">${pairs.map(x => `<button class="chip o" aria-pressed="${x === a}" data-act="pairStart" data-d="${ds}" data-p="${p}" data-v="${x}" data-t="${type}">${x}・${x + 1}限</button>`).join("")}</div>`;
  const c = S.students.filter(s => hasSpecial(s) && isFree(s.token, ds, a) && isFree(s.token, ds, a + 1))
    .sort((x, y) => weekCount(x.token) - weekCount(y.token) || String(x.deadline || "9").localeCompare(String(y.deadline || "9")));
  h += `<div style="font-size:13px;color:var(--muted);margin-bottom:8px">${a}限と${a + 1}限の両方が空いている教習生 ${c.length}人（第${(CFG.specialStages || [2]).join("・")}段階のみ）</div><div class="list">`;
  c.forEach(s => {
    const ev = evaluatePair(s, ds, a, type);
    const note = !ev.ok ? `<div class="s" style="color:var(--orange)">${esc(ev.reason)}</div>`
      : ev.dark ? `<div class="s" style="color:var(--orange)">日没が早い期間のため要確認</div>`
      : ev.combo ? `<div class="s" style="color:var(--muted)">${KK().label}→${PT("hwSolo").label}の組み合わせ（この日は4時限）</div>` : "";
    h += `<div class="item"><div><div class="t">${esc(s.name)}</div><div class="s">${info(s)}</div>${note}</div><button class="btn accent" data-act="assignPair" data-s="${s.token}" data-d="${ds}" data-p="${a}" data-t="${type}" ${ev.ok ? "" : "disabled"}>${L}で入れる</button></div>`;
  });
  if (!c.length) h += `<div class="hist"><div>両方の時限が空いている教習生はいません。</div></div>`;
  sheet(h + `</div><button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
}

function highwaySheet(s, ds, p, ev) {
  const tri = ev.tri.join("・");
  const dk = CFG.darkSeason || {};
  const fmt = k => `${+k.slice(0, 2)}月${+k.slice(3)}日`;
  sheet(`<h3>高速教習として入れますか？</h3>
  <p>${esc(s.name)}（第${s.stage}段階）<br>${md(ds)} の <b>${tri}限</b> が連続3時限になります。連続3時限は高速教習の場合だけ入れられます。</p>
  ${ev.dark ? `<div class="banner warn"><b>注意：${fmt(dk.from)}〜${fmt(dk.to)}は日没が早いため、${tri}限の高速教習は原則入れられません。</b><br>それでも入れる場合は「警告を確認して入れる」を押してください。</div>` : ""}
  <div class="list">${ev.dark
    ? `<button class="btn accent full" data-act="assignForce" data-s="${s.token}" data-d="${ds}" data-p="${p}">警告を確認して入れる（強制）</button>`
    : `<button class="btn accent full" data-act="assignHw" data-s="${s.token}" data-d="${ds}" data-p="${p}">高速教習として入れる</button>`}
  <button class="btn full" data-act="close">やめる</button></div>`);
}

/* ---------- 書き込み ---------- */
function outboxData(tok, type, title, body) {
  return { to: "student", type, studentToken: tok, instructorUid: S.uid, title, body, createdAt: serverTimestamp(), sent: false };
}
async function notifyStudent(tok, type, title, body) {
  await addDoc(collection(db, "outbox"), outboxData(tok, type, title, body));
  await updateDoc(doc(db, "students", tok), { lastNotifiedAt: serverTimestamp() });
  const s = ST(tok); if (s) s.lastNotifiedAt = Timestamp.now();
}
function darkPairSheet(s, ds, a, type) {
  const dk = CFG.darkSeason || {}, L = PT(type).label;
  const fmt = k => `${+k.slice(0, 2)}月${+k.slice(3)}日`;
  sheet(`<h3>${L}として入れますか？</h3>
  <p>${esc(s.name)}（第${s.stage}段階）<br>${md(ds)} の <b>${a}・${a + 1}限</b></p>
  <div class="banner warn"><b>注意：${fmt(dk.from)}〜${fmt(dk.to)}は日没が早いため、${a}・${a + 1}限の${L}は原則入れられません。</b><br>それでも入れる場合は「警告を確認して入れる」を押してください。</div>
  <div class="list"><button class="btn accent full" data-act="assignPairForce" data-s="${s.token}" data-d="${ds}" data-p="${a}" data-t="${type}">警告を確認して入れる（強制）</button>
  <button class="btn full" data-act="close">やめる</button></div>`);
}
async function assignPair(tok, ds, a, type = "kiken", force) {
  const s = ST(tok);
  const ev = evaluatePair(s, ds, a, type);
  if (!ev.ok) return toast(ev.reason);
  if (ev.dark && !force) return darkPairSheet(s, ds, a, type);
  const L = PT(type).label;
  const status = S.confirmed ? "confirmed" : "draft";
  const pairId = `${tok.slice(0, 6)}_${ds}_${a}`;
  for (const q of [a, a + 1]) {
    const data = { instructorUid: S.uid, date: ds, period: q, weekId: wid(), status, cancelRequested: false, lessonType: type, pairId, result: null, stage: s.stage, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    if (type === "hwSolo") { data.highway = true; if (ev.dark) data.forced = true; }
    const ref = await addDoc(collection(db, "students", tok, "bookings"), data);
    S.bookings.push({ id: ref.id, token: tok, ...data }); S.pending.push(S.bookings.at(-1));
  }
  if (S.confirmed) { await notifyStudent(tok, "added", "予約が追加されました", `${md(ds)} ${a}・${a + 1}限（${L}）`); toast(`${s.name}さんに通知しました`); }
  else toast(`${md(ds)} ${a}・${a + 1}限に${s.name}さんの${L}を入れました`);
  render();
}

// mode：undefined＝通常、"hw"＝高速教習として確認済み、"force"＝日没期間の警告を確認したうえで強制
async function assign(tok, ds, p, mode) {
  const s = ST(tok);
  const ev = evaluate(s, ds, p);
  if (ev.ok === false) return toast(ev.reason);
  if (ev.ok === "hw" && !mode) return highwaySheet(s, ds, p, ev);
  if (ev.ok === "hw" && ev.dark && mode !== "force") return highwaySheet(s, ds, p, ev);
  const status = S.confirmed ? "confirmed" : "draft";
  const data = { instructorUid: S.uid, date: ds, period: p, weekId: wid(), status, cancelRequested: false, result: null, stage: s.stage, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  if (ev.ok === "hw") { data.highway = true; if (mode === "force") data.forced = true; }
  const ref = await addDoc(collection(db, "students", tok, "bookings"), data);
  S.bookings.push({ id: ref.id, token: tok, ...data }); S.pending.push(S.bookings.at(-1));
  if (ev.ok === "hw") {
    // 同じ日の残り2時限も高速教習として記録する
    for (const b of S.bookings.filter(x => x.token === tok && x.date === ds && ev.tri.includes(x.period) && !x.highway)) {
      await updateDoc(doc(db, "students", tok, "bookings", b.id), { highway: true, updatedAt: serverTimestamp() }); b.highway = true;
    }
  }
  if (S.confirmed) { await notifyStudent(tok, "added", "予約が追加されました", label(ds, p) + (data.highway ? "（高速教習）" : "")); toast(`${s.name}さんに通知しました`); }
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
async function markResult(ids, result) {
  const list = S.pending.filter(b => ids.includes(b.id));
  if (!list.length) return;
  const tok = list[0].token, s = ST(tok), it = lessonItems(list)[0];
  const batch = writeBatch(db);
  list.forEach(b => batch.update(doc(db, "students", tok, "bookings", b.id), { result, resultAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  const text = `${md(it.date)} ${list.map(b => b.period).sort((m, n) => m - n).join("・")}限${typeName(list[0]) ? `（${typeName(list[0])}）` : ""}`;
  if (result === "done") {
    const upd = { doneCount: increment(it.units) };
    if (it.lessonType === "kiken") upd.kikenDone = true;
    batch.update(doc(db, "students", tok), upd);
  } else {
    batch.set(doc(collection(db, "outbox")), outboxData(tok, "absent", "欠席のお知らせ", `${text} は欠席として記録しました。次の予約は担当指導員からお知らせします。`));
    batch.update(doc(db, "students", tok), { lastNotifiedAt: serverTimestamp() });
  }
  await batch.commit();
  if (s) {
    if (result === "done") { s.doneCount = (s.doneCount || 0) + it.units; if (it.lessonType === "kiken") s.kikenDone = true; }
    else s.lastNotifiedAt = Timestamp.now();
  }
  S.pending = S.pending.filter(b => !ids.includes(b.id));
  S.bookings.forEach(b => { if (ids.includes(b.id)) b.result = result; });
  render(); toast(result === "done" ? `${s ? s.name : ""}さん ${text} を実施にしました` : `${s ? s.name : ""}さんに欠席を通知しました`);
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
    batch.update(doc(db, "students", b.token), upd);
  }
  await batch.commit();
  if (s && was === "done") { s.doneCount = (s.doneCount || 0) - it.units; if (it.lessonType === "kiken") s.kikenDone = false; }
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
  drafts.forEach(b => b.status = "confirmed");
  S.pending.forEach(b => { if (drafts.some(d => d.id === b.id)) b.status = "confirmed"; });
  Object.keys(byStudent).forEach(tok => { const s = ST(tok); if (s) s.lastNotifiedAt = Timestamp.now(); });
  S.confirmed = true; render(); toast(`${Object.keys(byStudent).length}人に通知しました`);
}

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
    else if (a === "reload") { await loadWeek(); }
    else if (a === "wk") { S.week = addDays(S.week, +t.dataset.v); S.pick = null; await loadWeek(); }
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
    else if (a === "assignHw") { t.disabled = true; closeSheet(); await assign(t.dataset.s, t.dataset.d, +t.dataset.p, "hw"); }
    else if (a === "assignForce") { t.disabled = true; closeSheet(); await assign(t.dataset.s, t.dataset.d, +t.dataset.p, "force"); }
    else if (a === "booked") {
      const b = S.bookings.find(x => x.id === t.dataset.id); const s = ST(b.token);
      const it = itemOf(b);
      const head = `<h3>${label(b.date, b.period)}</h3><p><b>${esc(s ? s.name : "")}</b>（第${s ? s.stage : "-"}段階）${it && s ? `・${noText(s, it)}` : ""}${typeName(b) ? `<br>${typeName(b)}${b.pairId ? "（2時限まとめて扱います）" : ""}` : ""}`;
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
      t.disabled = true; await markResult(ids, a === "markDone" ? "done" : "absent");
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
    }
  } catch (err) { toast(friendlyError(err)); render(); }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pw") document.querySelector('[data-act="login"]').click(); });
