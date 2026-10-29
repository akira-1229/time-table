// 指導員の画面：週ごとの割り当て、確定と通知、キャンセル希望の対応、確認状況
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "./backend.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, getDocs,
  serverTimestamp, writeBatch, Timestamp, onSnapshot, increment
} from "./backend.js";
import {
  CFG, app as fbApp, db, WD, P, ymOf, dateStr, parseDate, addDays, mondayOf, today, md, label, slotKey, esc,
  toast, sheet, closeSheet, onOverlayClose, friendlyError, enablePush, pushReasonText, listenForeground,
  installButton, firstVisitInstall, indexLinkOf, sendNow, pushStatusHtml, isPC, applyView, onViewChange, lookSettingsHtml, getPref, isMikiwame, kenteiOn, kentei1AgeNg, lessonPlan, lessonItems, nextSpecial, isHwType, noRange, lessonMin, doneOf, bookingEnd, paceOf, paceText, karimenExpiryOf, expiriesOf, expiryText, trackAccess, noticeHead, busySheet, noticeRow, mdS, saveNotices, noticeHistoryHtml, DEMO } from "./common.js";

const auth = getAuth(fbApp);
self.__boot && self.__boot.push("instructor");
const root = document.getElementById("app");
const S = {
  uid: null, me: null, view: "assign", week: addDays(mondayOf(today()), getPref("startweek", "next") === "this" ? 0 : 7), mode: getPref("startmode", "slot"), balOpen: getPref("balopen", "0") === "1", pick: null, ptype: null,
  off: {}, offWeek: addDays(mondayOf(today()), 7), offTimers: {}, students: [], avail: {}, late: {}, bookings: [], pending: [], confirmed: false, cancelReqs: [], loading: false, indexLinks: new Set()
};
const wid = () => dateStr(S.week);
const days = () => { const r = []; for (let i = 0; i < 7; i++) { const d = addDays(S.week, i); if (CFG.openDays.includes(d.getDay())) r.push(dateStr(d)); } return r; };
const ST = tok => S.students.find(s => s.token === tok);
// 教習生の名前の出し方：「山田 太郎さん（0001）」（教習生番号が無い人は番号なし。依頼者指定）
const nm = s => s ? `${s.name}さん${s.studentNo ? `（${s.studentNo}）` : ""}` : "";
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
    showStaffNotice();
    if (location.hash === "#manage") showView("manage");
    else if (location.hash === "#settings") showView("settings");
    else if (location.hash === "#notice") showView("notice");
    else if (location.hash === "#off") showView("off");
  } catch (e) {
    // ログインはできているので、ログイン画面には戻さず、理由とやり直しのボタンを出す
    noteIndex(e);
    root.innerHTML = `<section class="panel"><div class="body"><div class="banner warn">${esc(friendlyError(e))}</div>${indexBanner()}
      <div class="list"><button class="btn primary full" data-act="retry">もう一度読み込む</button><button class="btn full" data-act="logout">ログアウト</button></div></div></section>`;
  }
});
// アプリを開いた時のお知らせ：あいさつと、キャンセル希望・本日の検定・チェック待ちなどを箇条書き（0件でも出す）
let noticeAt = 0, seenKeys = null, staffPending = false;
// お知らせの項目（key は新着かどうかを見分けるため）。1項目1行に収まるよう短く書く
const nsName = s => esc(nm(s));
function staffItems() {
  const items = [];
  cancelReqGroups().forEach(b => { const s = ST(b.token), ps = b.pairId ? S.cancelReqs.filter(x => x.pairId === b.pairId && x.token === b.token).map(x => x.period).sort((m, n) => m - n) : [b.period]; items.push([`cr:${b.id}`, noticeRow("キャンセル希望", `${nsName(s)}<small>${mdS(b.date)}${ps.join("・")}限</small>`, "warn")]); });
  S.students.filter(s => kenteiOn(s)).forEach(s => items.push([`kt:${s.token}:${dateStr(today())}`, noticeRow("本日検定", nsName(s), "ok")]));
  kenteiDue().forEach(s => items.push([`kr:${s.token}:${s[`mikiwame${s.stage}`].kenteiDate}`, noticeRow("検定結果", `${nsName(s)}<small>${KN(s)}の結果を入れてください</small>`, "warn")]));
  const unchecked = uncheckedItems();
  if (unchecked.length) items.push([`unc:${unchecked.map(it => it.bookings[0].id).join(",")}`, noticeRow("実施チェック", `終わった教習のチェック待ち ${unchecked.length}件`, "warn")]);
  S.students.flatMap(s => expiriesOf(s).map(e => [s, e])).sort((a, b) => a[1].days - b[1].days)
    .forEach(([s, e]) => items.push([`ex:${s.token}:${e.key}:${e.date}`, noticeRow("期限", `${nsName(s)}<small>${e.label} ${mdS(e.date)}（${e.days < 0 ? `${-e.days}日過ぎ` : e.days === 0 ? "今日" : `あと${e.days}日`}）</small>`, "warn")]));
  S.students.map(s => [s, paceOf(s)]).filter(([, pc]) => pc).forEach(([s, pc]) => items.push([`pace:${s.token}:${pc.label}`, noticeRow("ペース", `${nsName(s)}<small>${pc.label}に間に合わない見込み${pc.eta ? `（${mdS(pc.eta)}）` : ""}</small>`, "warn")]));
  S.students.map(s => [s, planOf(s)]).filter(([, pl]) => !pl.ok).forEach(([s, pl]) => items.push([`ng:${s.token}:${pl.reason}`, noticeRow("順番のずれ", `${nsName(s)}<small>${esc(pl.reason)}</small>`, "warn")]));
  const gones = S.bookings.filter(goneDraft);
  if (gones.length) items.push([`gone:${gones.map(b => b.id).join(",")}`, noticeRow("◯の取り消し", `未確定の予約から◯が外されました ${gones.length}件`, "warn")]);
  return items;
}
function showStaffNotice() {
  if (!S.uid || !S.me) return;
  noticeAt = Date.now();
  const items = staffItems(), prev = seenKeys;
  seenKeys = new Set(items.map(x => x[0]));
  const isNew = k => prev && !prev.has(k);
  saveNotices(`staff_${S.uid}`, items.map(([key, html]) => ({ key, html })));
  if (S.view === "notice") renderNoticeTab();
  sheet(`${noticeHead()}<p class="greet"><b>${esc(S.me.name)}さん</b>　お疲れ様です！</p>
    <p style="margin:0;text-align:center"><b>お知らせ ${items.length}件</b></p>
    ${items.length ? `<ul class="notice-list">${items.map(([k, x]) => `<li>${isNew(k) ? '<b class="newtag">新着</b>' : ""}${x}</li>`).join("")}</ul>` : `<p style="color:var(--muted);text-align:center">今日のお知らせはありません。</p>`}
    <div class="list"><button class="btn primary full" data-act="close">OK</button></div>`, { notice: true });
}
// 新着（キャンセル希望が届いた、◯が外された など）があれば、開いたままでもお知らせを出す
function checkStaffNews() {
  if (!S.uid || !S.me || !seenKeys || S.loading) return;
  if (!staffItems().some(([k]) => !seenKeys.has(k))) return;
  if (busySheet()) staffPending = true; else showStaffNotice();
}
setInterval(() => { if (staffPending && !busySheet()) { staffPending = false; checkStaffNews(); } }, 2000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.uid && Date.now() - noticeAt > 10 * 60 * 1000 && !document.querySelector("#overlay .sheet")) showStaffNotice();
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
    await loadOff(yms);
    const bq = query(collectionGroup(db, "bookings"), where("instructorUid", "==", S.uid), where("weekId", "==", wid()));
    // この週の予約。教習生が「確認しました」を押すと（ackAt）、開いたままの画面にもすぐ「確認済」を出す
    await new Promise((resolve, reject) => {
      let first = true;
      unwatch.push(onSnapshot(bq, r => {
        const docs = r.docs.map(d => ({ id: d.id, token: d.ref.parent.parent.id, ...d.data() }));
        if (first) { first = false; S.bookings = docs.filter(b => b.status !== "cancelled"); resolve(); return; }
        const m = new Map(docs.map(d => [d.id, d]));
        S.bookings.forEach(b => { const d = m.get(b.id); if (d) b.ackAt = d.ackAt || null; });
        laterRender();
      }, e => { if (first) { first = false; reject(e); } }));
    });
    // ほかの指導員から頼まれた教習（この週の分）
    try {
      const sq2 = query(collectionGroup(db, "bookings"), where("subUid", "==", S.uid), where("weekId", "==", wid()));
      S.subs = (await getDocs(sq2)).docs.map(d => ({ id: d.id, token: d.ref.parent.parent.id, ...d.data() })).filter(b => b.status !== "cancelled");
    } catch (e) { S.subs = []; noteIndex(e); }
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
/* ---------- 指導員の予定（教習に出られない枠に✕） ---------- */
// offs/{指導員UID}_{YYYY-MM} ＝ { uid, ym, slots: ["日-時限", …] }。教習生の画面にも✕で出し、予約は入れない
const offKey = ym => `${S.uid}_${ym}`;
async function loadOff(yms) {
  for (const ym of yms) {
    if (S.off[ym]) continue;
    const d = await getDoc(doc(db, "offs", offKey(ym)));
    S.off[ym] = new Set(d.exists() ? d.data().slots || [] : []);
  }
}
const isOff = (ds, p) => { const s = S.off[ds.slice(0, 7)]; return !!(s && s.has(slotKey(parseDate(ds).getDate(), p))); };
function saveOff(ym) {
  clearTimeout(S.offTimers[ym]);
  S.offTimers[ym] = setTimeout(async () => {
    try { await setDoc(doc(db, "offs", offKey(ym)), { uid: S.uid, ym, slots: [...S.off[ym]], updatedAt: serverTimestamp() }); }
    catch (e) { toast(friendlyError(e)); }
  }, 600);
}
// 予定の登録は週ごと（毎週水曜日に、来週の出られない時間に✕を付けてから自動で割り振る。依頼者指定）。最初は来週
const offDays = () => Array.from({ length: 7 }, (_, i) => dateStr(addDays(S.offWeek, i)));
async function renderOff() {
  if (!S.me) return;
  const ds = offDays(), tds = dateStr(today());
  await loadOff([...new Set(ds.map(d => d.slice(0, 7)))]);
  const n = ds.reduce((c, d) => c + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(p => isOff(d, p)).length, 0);
  const infoH = `<div class="banner info"><b>毎週水曜日に、来週の予定を入れてください。</b><br>休みの日や、ほかの予定があって<b>教習に出られない時間に✕</b>を付けます。押すとすぐに✕が付き、もう一度押すと外れます。日付の下の「全部」で、その日の全部の時限に✕を付けられます。<br><span style="font-size:12px">✕を付けた時間には予約が入りません（手で入れる時も、自動で割り振る時も）。教習生の画面には出ません。</span></div>`;
  let h = `<div class="weeknav"><button class="btn" data-act="offWk" data-v="-7" aria-label="前の週">◀</button><b>${md(ds[0])}〜${md(ds[6])}</b><button class="btn" data-act="offWk" data-v="7" aria-label="次の週">▶</button></div>
  <div class="gridwrap"><table class="cal calt"><thead><tr><th class="pl"></th>`;
  ds.forEach(d => { const w = parseDate(d).getDay(); h += `<th scope="col" class="day ${w === 6 ? "sat" : w === 0 ? "sun" : ""}${d === tds ? " tday t1" : ""}">${parseDate(d).getDate()}<small>${d === tds ? "今日" : WD[w]}</small></th>`; });
  h += `</tr><tr class="dayall"><th class="pl"><small>全部</small></th>`;
  ds.forEach(d => { const past = d < tds, all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every(p => isOff(d, p)); h += `<td class="${d === tds ? "tday" : ""}"><input type="checkbox" class="daychk" ${past ? "disabled" : `data-act="offDay" data-d="${d}"`} ${all ? "checked" : ""} aria-label="${md(d)}の全部の時限に✕"></td>`; });
  h += `</tr></thead><tbody>`;
  for (let p = 1; p <= 10; p++) {
    h += `<tr><th scope="row" class="pl">${p}限<small>${P[p][0]}</small></th>`;
    ds.forEach(d => { const x = isOff(d, p), past = d < tds; h += `<td class="${d === tds ? `tday${p === 10 ? " tN" : ""}` : ""}"><button class="cell ${x ? "ng" : ""}" ${past ? "disabled" : `data-act="offCell" data-d="${d}" data-p="${p}"`} aria-pressed="${x}" aria-label="${md(d)} ${p}限${x ? " 教習に出られない" : ""}">${x ? "✕" : ""}</button></td>`; });
    h += `</tr>`;
  }
  h += `</tbody></table></div>
  <div class="legend"><span><i class="sw" style="background:var(--lv3-soft);border-color:var(--lv3)"></i>教習に出られない（✕）</span><span><i class="sw"></i>教習に出られる</span></div>`;
  const endH = `<p style="font-size:13px;margin:10px 0 6px">この週の✕：<b>${n}</b>時限</p>
  <button class="btn primary full" data-act="offToAssign">この週の予約の管理へ（自動で割り振る）</button>`;
  // PC表示：予約の管理と同じく、左にマス目、右に説明・✕の数・ボタン（依頼者指定）
  document.getElementById("off").innerHTML = `<div class="topbar"><div><h1>予定の登録</h1><small>${esc(S.me.name)} 指導員</small></div></div>
  <section class="panel"><div class="body">${isPC()
    ? `<div class="asg"><div class="asg-main">${h}</div><aside class="asg-side">${infoH}${endH}</aside></div>`
    : infoH + h + endH}</div></section>`;
}
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
const laterRender = () => { if (S.loading) return; clearTimeout(renderTimer); renderTimer = setTimeout(() => { render(); checkStaffNews(); }, 300); };
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
// 教習生が、その予約を「確認しました」したか（実施・欠席のチェック前、キャンセル希望が出ていない時だけ出す）
const acked = b => b.status === "confirmed" && !!b.ackAt && !b.result && !b.cancelRequested;
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
const noText = (s, it) => it ? `${noRange(it)}時限目${it.no + it.units - 1 > lessonMin(s.stage, s) ? "（延長）" : ""}` : "";

/* ---------- 判定 ---------- */
// その時限の自分の予約（ほかの指導員に依頼した予約は除く。依頼した時限には、別の教習生を入れられる）
const bookAt = (ds, p) => S.bookings.find(b => b.date === ds && b.period === p && !b.subUid);
// ほかの指導員から頼まれた教習（その時限は自分の予約が入っているのと同じ扱い）
const subAt = (ds, p) => (S.subs || []).find(b => b.date === ds && b.period === p);
const bookingsAt = (ds, p) => S.bookings.filter(b => b.date === ds && b.period === p);
// 何人かで一緒に受けられる教習：高速教習（3時限）は3人まで、危険予測は2人まで（config の capacity。依頼者指定）
const SHARED = ["hw3", "kiken"];
const CAP = type => type === "hw3" ? (CFG.hw3 || {}).capacity || 3 : type === "kiken" ? (CFG.kiken || {}).capacity || 2 : 1;
// a限から始まる、一緒に受けられる教習（高速教習3時限・危険予測2時限）の組に入っている教習生
// （その時限がその種類の同じ組の予約だけの時）。ほかの予約が混じっていれば null
function groupAt(ds, a, type) {
  const ps = span(a, type), list = S.bookings.filter(b => b.date === ds && ps.includes(b.period) && !b.subUid);
  if (!list.length) return [];
  if (list.some(b => b.lessonType !== type)) return null;
  const toks = [...new Set(list.map(b => b.token))];
  const ok = toks.every(t => { const mine = list.filter(b => b.token === t).map(b => b.period).sort((x, y) => x - y); return sameSet(mine, ps); });
  return ok ? toks : null;
}
// キャンセル希望を、危険予測・高速教習の組ごとに1件にまとめる
const cancelReqGroups = () => S.cancelReqs.filter((b, i, a) => !b.pairId || a.findIndex(x => x.pairId === b.pairId && x.token === b.token) === i);
// 実施にしようとしている教習が、危険予測（12時限目）・高速教習（13時限目から）の順番に合っているか。合っていなければ理由を返す
function orderNg(s, it) {
  const K = lessonsOf(s.stage, "kikenNo"), H = lessonsOf(s.stage, "hwNo"), on = n => n && it.no <= n && n < it.no + it.units;
  if (it.lessonType === "kiken" && !s.kikenDone && it.no !== K) return `${KK().label}は${K}時限目の教習ですが、今は${it.no}時限目になっています（欠席などで順番がずれています）`;
  if (isHwType(it.lessonType) && !s.hwDone && it.no !== H) return `高速教習は${H}時限目からの教習ですが、今は${it.no}時限目になっています（欠席などで順番がずれています）`;
  if (!it.lessonType && !s.kikenDone && on(K)) return `${K}時限目は${KK().label}ですが、通常の教習になっています`;
  if (!it.lessonType && !s.hwDone && on(H)) return `${H}時限目は高速教習ですが、通常の教習になっています`;
  return "";
}
// 検定の結果待ち：みきわめ合格・検定日が今日まで・結果をまだ入れていない人
const KN = s => s.stage === 1 ? "修了検定" : "卒業検定";
const kenteiDue = () => S.students.filter(s => { const mk = s[`mikiwame${s.stage}`]; return mk && mk.passed && mk.kenteiDate && mk.kenteiDate <= dateStr(today()) && !mk.kenteiResult; });
// 終わった教習（実施・欠席のチェック待ち）。危険予測・高速教習は組の最後の時限まで終わってから出す（途中でチェックして組が割れないように）
const uncheckedItems = () => lessonItems(S.pending.filter(b => b.status === "confirmed")).filter(it => it.bookings.every(b => bookingEnd(b) <= new Date()));
const weekCount = tok => S.bookings.filter(b => b.token === tok).length;
const dayCount = (tok, ds) => S.bookings.filter(b => b.token === tok && b.date === ds).length;
// 今日より前の日は、空き・予約とも一切さわれない（遡って予約を入れない。依頼者指定）
const isPast = ds => ds < dateStr(today());
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
// 教習期限・仮免期限（第2段階）を過ぎた日と、第1段階で教習開始日より前の日は入れない（依頼者指定）
// 第2段階は、検定の前に予約を入れておくことがあるため、仮免交付日より前でも入れられる
function dateBlock(s, ds) {
  if (s.deadline && ds > s.deadline) return `教習期限（${md(s.deadline)}）を過ぎています`;
  if (s.stage === 2 && s.karimenExpiry && ds > s.karimenExpiry) return `仮免期限（${md(s.karimenExpiry)}）を過ぎています`;
  if (s.stage === 1 && s.startDate && ds < s.startDate) return `教習開始日（${md(s.startDate)}）より前です`;
  return "";
}
// viaSub：ほかの指導員に依頼して入れる時（自動割り振り）。自分の✕・予約は見ない（相手が空いているかは呼ぶ側で見る）
function evaluate(s, ds, p, viaSub) {
  if (isPast(ds)) return { ok: false, reason: "過ぎた日には予約を入れられません" };
  { const r = dateBlock(s, ds); if (r) return { ok: false, reason: r }; }
  if (!viaSub && isOff(ds, p)) return { ok: false, reason: "指導員の予定（✕）が入っている枠です" };
  if (!viaSub && subAt(ds, p)) return { ok: false, reason: "ほかの指導員から頼まれた教習が入っている時間です" };
  if (!isFree(s.token, ds, p)) return { ok: false, reason: "空いていない枠です" };
  if (!viaSub && bookAt(ds, p)) return { ok: false, reason: "この枠はすでに予約が入っています" };
  if (viaSub && S.bookings.some(b => b.token === s.token && b.date === ds && b.period === p)) return { ok: false, reason: "この時限はすでに予約が入っています" };
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
const SHORT = { kiken: "危険", hwSolo: "単独", hw3: "高速" };   // マス目の小さい表示用
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
  if (isPast(ds)) return { ok: false, reason: "過ぎた日には予約を入れられません" };
  { const r = dateBlock(s, ds); if (r) return { ok: false, reason: r }; }
  if (!hasSpecial(s)) return { ok: false, reason: `第${s.stage}段階には${L}はありません` };
  if (!pairOk(a, type)) return { ok: false, reason: type === "hw3"
    ? `${spanText(a, type)}限の${L}は入れられません（${(CFG.highwaySets || []).map(x => x.join("・")).join(" / ")} 限のみ）`
    : `${spanText(a, type)}限は休憩をはさむため、${L}は入れられません` };
  // 高速教習（3時限）は、同じ時限の組に3人まで一緒に入れる
  const grp = SHARED.includes(type) ? groupAt(ds, a, type) : null;
  const joining = !!(grp && grp.length);
  if (joining && grp.includes(s.token)) return { ok: false, reason: `この${L}にはすでに入っています` };
  if (joining && grp.length >= CAP(type)) return { ok: false, reason: `この${L}は満員です（${CAP(type)}人まで）` };
  for (const q of ps) {
    if (isOff(ds, q)) return { ok: false, reason: `${q}限は指導員の予定（✕）が入っています` };
    if (subAt(ds, q)) return { ok: false, reason: `${q}限はほかの指導員から頼まれた教習が入っています` };
    if (!isFree(s.token, ds, q)) return { ok: false, reason: `${q}限が空いていません` };
    if (!joining && bookAt(ds, q)) return { ok: false, reason: `${q}限はすでに予約が入っています${SHARED.includes(type) ? `（${L}は、同じ時限の組にだけ一緒に入れます）` : ""}` };
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
  return { ok: true, dark, combo, join: joining ? grp.length : 0 };
}
const typeName = b => b.lessonType ? PT(b.lessonType).label : b.highway ? "高速教習" : "";
const blabel = b => label(b.date, b.period) + (typeName(b) ? `（${typeName(b)}）` : "");
const freeCount = s => { let n = 0; days().forEach(ds => { for (let p = 1; p <= 10; p++) if (isFree(s.token, ds, p)) n++; }); return n; };
const candidates = (ds, p) => S.students.filter(s => isFree(s.token, ds, p)).sort((a, b) => weekCount(a.token) - weekCount(b.token) || String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
const daysLeft = s => s.deadline ? Math.round((parseDate(s.deadline) - today()) / 86400000) : null;
const unacked = s => s.lastNotifiedAt && (!s.ackAt || s.lastNotifiedAt.toMillis() > s.ackAt.toMillis());
const info = s => {
  const dl = daysLeft(s), pl = planOf(s), min = lessonMin(s.stage, s);
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
    h += `<button class="balrow ${lv(r)}" data-act="balPick" data-s="${r.s.token}"><span class="nm">${esc(nm(r.s))}</span><span class="bar"><i style="width:${Math.round(r.n / top * 100)}%"></i></span><span class="n"><b>${r.n}</b>時限${r.d ? `<small>（未確定${r.d}）</small>` : ""}</span><span class="fr">${r.free ? `◯${r.free}枠` : "◯なし"}</span></button>`;
  });
  return h + `</div></details>`;
}

/* ---------- 画面 ---------- */
function render() {
  if (!S.uid) return;
  const ds = days(); const wEnd = ds[ds.length - 1];
  let h = `<div class="topbar"><div><h1>予約の管理</h1><small>${esc(S.me ? S.me.name : "")} 指導員・担当 ${S.students.length}人</small></div>
    <span><button class="linkbtn" data-act="reload">最新の情報に更新</button></span></div>`;
  // 週の切り替えは、マス目のすぐ上に出す（依頼者指定）
  const weekNav = `<div class="weeknav"><button class="btn" data-act="wk" data-v="-7" aria-label="前の週">◀</button><b>${md(ds[0])}〜${md(wEnd)}</b><button class="btn" data-act="wk" data-v="7" aria-label="次の週">▶</button></div>`;
  if (S.loading) { root.innerHTML = h + weekNav + `<div class="loading">読み込み中…</div>`; return; }
  const top = h + `<section class="panel"><div class="phead"><div><h2>割り当て</h2><small>マス目をタップして教習生を入れます</small></div>
    ${S.confirmed ? '<span class="tag ok">確定済み</span>' : '<span class="tag draft">未確定</span>'}</div><div class="body">`;
  h = indexBanner();
  const unchecked = uncheckedItems();
  if (unchecked.length) {
    h += `<div class="banner warn"><b>終わった教習のチェックが${unchecked.length}件あります</b><br><span style="font-size:12px">教習生が来たら「実施」、来なかったら「欠席」を押してください（欠席は教習生に通知されます）。</span>`;
    unchecked.forEach(it => {
      const s = ST(it.bookings[0].token), ids = it.bookings.map(b => b.id).join(",");
      const pit = s && planOf(s).items.find(x => x.bookings.some(b => b.id === it.bookings[0].id));
      const tn = (it.lessonType ? `（${PT(it.lessonType).label}）` : it.highway ? "（高速）" : "") + (s && pit && isMikiwame(s, pit) ? "（みきわめ）" : "");
      h += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span>${esc(nm(s))}<br>${md(it.date)} ${it.bookings.map(b => b.period).join("・")}限${tn}</span><span style="display:flex;gap:6px"><button class="btn" data-act="markAbsent" data-ids="${ids}">欠席</button><button class="btn accent" data-act="markDone" data-ids="${ids}">実施</button></span></div>`;
    });
    h += `</div>`;
  }
  const kt = S.students.filter(s => kenteiOn(s));
  const kdue = kenteiDue();
  if (kdue.length) h += `<div class="banner warn"><b>検定の結果を入れてください</b>${kdue.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span>${esc(nm(s))}<br>${md(s[`mikiwame${s.stage}`].kenteiDate)} ${KN(s)}</span><span style="display:flex;gap:6px"><button class="btn" data-act="kenteiFail" data-s="${s.token}">不合格</button><button class="btn accent" data-act="kenteiPass" data-s="${s.token}">合格</button></span></div>`).join("")}</div>`;
  if (kt.length) h += `<div class="banner ok"><b>本日、検定日の方</b><ul style="margin:6px 0 0;padding-left:1.4em">${kt.map(s => `<li>${esc(nm(s))}（第${[1, 2].find(n => s[`mikiwame${n}`] && s[`mikiwame${n}`].kenteiDate === dateStr(today()))}段階）</li>`).join("")}</ul></div>`;
  const exp = S.students.flatMap(s => expiriesOf(s).map(e => [s, e])).sort((a, b) => a[1].days - b[1].days);
  if (exp.length) h += `<div class="banner warn"><b>期限が近い教習生がいます（${CFG.expiryWarnDays || 30}日以内）</b>${exp.map(([s, e]) => `<br>${esc(nm(s))}：<span style="${e.days <= 7 ? "color:var(--lv3);font-weight:700" : ""}">${esc(expiryText(e))}</span>`).join("")}</div>`;
  const slow = S.students.map(s => [s, paceOf(s)]).filter(([, pc]) => pc);
  if (slow.length) h += `<div class="banner warn"><b>このペースでは期限に間に合わない教習生がいます</b>${slow.map(([s, pc]) => `<br>${esc(nm(s))}：${esc(paceText(pc))}`).join("")}<br><span style="font-size:12px">これまでの1日あたりの時限数から見込みを出しています。空き時間を増やしてもらうなど、早めに相談してください。</span></div>`;
  const ngs = S.students.map(s => [s, planOf(s)]).filter(([, pl]) => !pl.ok);
  if (ngs.length) h += `<div class="banner warn"><b>教習の順番がずれています</b>${ngs.map(([s, pl]) => `<br>${esc(nm(s))}：${esc(pl.reason)}`).join("")}<br><span style="font-size:12px">欠席などで順番がずれた時に出ます。予約を入れ直してください。</span></div>`;
  const gones = S.bookings.filter(goneDraft);
  if (gones.length) h += `<div class="banner warn"><b>教習生が◯を外した未確定の予約が${gones.length}件あります</b>（赤い枠）。取り消すか、教習生に確認してください。</div>`;
  if (S.cancelReqs.length) {
    const reqs = cancelReqGroups();
    h += `<div class="banner warn"><b>キャンセル希望が${reqs.length}件あります</b>`;
    reqs.forEach(b => {
      const s = ST(b.token), ps = S.cancelReqs.filter(x => b.pairId ? x.pairId === b.pairId && x.token === b.token : x.id === b.id).map(x => x.period).sort((m, n) => m - n);
      h += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span>${esc(nm(s))}<br>${b.pairId ? `${md(b.date)} ${ps.join("・")}限${ps.length < LEN(b.lessonType) ? "を含む" : ""}${typeName(b)}（${LEN(b.lessonType)}時限まとめて）` : label(b.date, b.period)}</span><span style="display:flex;gap:6px"><button class="btn" data-act="reject" data-id="${b.id}">却下</button><button class="btn accent" data-act="approve" data-id="${b.id}">承認</button></span></div>`;
    });
    h += `</div>`;
  }
  const alertsH = h; h = "";
  const none = S.students.filter(s => weekCount(s.token) === 0).length;
  const total = ds.length * 10;
  const usedSlots = new Set(S.bookings.map(b => `${b.date}-${b.period}`)).size;
  h += `<div class="sum"><div><b>${usedSlots}</b>予約した枠</div><div class="${none ? "alert" : ""}"><b>${none}</b>まだ予約のない人</div><div><b>${total - usedSlots}</b>空いている枠</div></div>`;
  h += balanceHtml();
  const sideTop = h; h = "";
  h += `<div class="seg" role="group" aria-label="割り当て方"><button aria-pressed="${S.mode === "slot"}" data-act="mode" data-v="slot">枠から選ぶ</button><button aria-pressed="${S.mode === "student"}" data-act="mode" data-v="student">教習生から選ぶ</button></div>`;

  let maxN = 1; ds.forEach(d => { for (let p = 1; p <= 10; p++) if (!isOff(d, p)) maxN = Math.max(maxN, S.students.filter(s => isFree(s.token, d, p)).length); });
  const T1 = Math.floor(maxN / 3), T2 = Math.floor(maxN * 2 / 3);
  const pk = S.mode === "student" && S.pick ? ST(S.pick) : null;
  // 危険予測・高速教習は、その教習生がその時限目に来た時だけ選べる（番の時はその種類だけ）
  const pkTypes = pk ? specialTypes(pk) : [];
  S.ptype = pkTypes.includes(S.ptype) ? S.ptype : pkTypes[0] || null;
  if (S.mode === "student") {
    h += pk ? `<div class="picking"><span><b>${esc(nm(pk))}</b>を割り当て中<br><span style="font-size:12px;color:var(--muted)">光っている枠をタップすると予約されます（第${pk.stage}段階・1日${dayMax(pk)}時限まで${(CFG.noTripleStages || []).includes(pk.stage) ? "・連続3時限は高速教習（3時限）のみ" : ""}）</span></span><button class="btn" data-act="unpick">やめる</button></div>
      ${pkTypes.length ? `<div class="banner ${S.ptype === "kiken" ? "ok" : "warn"}" style="margin-bottom:6px">次は<b>${lessonPlan(pk, pendingOf(pk)).total + 1}時限目</b>で、<b>${pkTypes[0] === "kiken" ? KK().label : "高速教習"}</b>の番です。${pkTypes.length > 1 ? "2時限（単独高速）か3時限かを選んでください。" : "2時限連続で入ります。"}</div>
        ${pkTypes.length > 1 ? `<div class="seg" role="group" aria-label="教習の種類">${pkTypes.map(v => `<button aria-pressed="${S.ptype === v}" data-act="ptype" data-v="${v}">${TYPE_BTN[v]()}</button>`).join("")}</div>` : ""}
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">光っているマスは開始の時限です。タップすると、その時限から${LEN(S.ptype)}時限がまとめて入ります。</div>` : ""}`
      : `<div class="banner info">下の一覧から教習生を選ぶと、その人が空いている枠だけが光ります。</div>`;
  } else {
    h += `<div class="heatleg"><span><i style="background:var(--lv1-soft);border-color:var(--lv1)"></i>少ない（${T1}人以下）</span><span><i style="background:var(--lv2-soft);border-color:var(--lv2)"></i>中間（${T1 + 1}〜${T2}人）</span><span><i style="background:var(--lv3-soft);border-color:var(--lv3)"></i>多い（${T2 + 1}人以上）</span></div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:6px">数字と棒の長さは、その枠に入れる人数（この週の最多${maxN}人を基準に色分け）</div>`;
  }
  if ((CFG.autoAssign || {}).weeklyMax && !S.confirmed) h += `<button class="btn primary full" style="margin-bottom:8px" data-act="autoAssign">この週を自動で割り振る（未確定で入ります）</button>`;
  h += weekNav + `<div class="gridwrap"><table class="wk"><thead><tr><th class="pl"></th>`;
  const tds = dateStr(today()), tc = d => d === tds ? "tday" : "";
  ds.forEach(d => { const w = parseDate(d).getDay(); h += `<th class="${d === tds ? "tday t1" : ""}" style="${w === 6 ? "color:var(--blue)" : w === 0 ? "color:#C0392B" : ""}">${parseDate(d).getDate()}(${WD[w]})${d === tds ? "<small>今日</small>" : ""}</th>`; });
  h += `</tr></thead><tbody>`;
  for (let p = 1; p <= 10; p++) {
    h += `<tr><th class="pl">${p}限<small>${P[p][0]}</small></th>`;
    ds.forEach(d => {
      const lb = label(d, p), bs = bookingsAt(d, p), b = bs.length === 1 ? bs[0] : bookAt(d, p), sb = subAt(d, p);
      const td = `<td class="${tc(d)}${d === tds && p === 10 ? " tN" : ""}">`;
      if (!bs.length && sb) { h += `${td}<button class="wc bk subx" data-act="subInfo" data-id="${sb.id}" aria-label="${lb} ${esc(sb.subFromName || "")}指導員から頼まれた教習">${esc(String(sb.subStudent || "?").replace(/さん.*$/, "").slice(0, 4))}<small class="subtag">${esc(String(sb.subFromName || "").slice(0, 2))}依頼</small></button></td>`; return; }
      if (!bs.length && isOff(d, p)) { h += `${td}<button class="wc offx" disabled aria-label="${lb} 指導員の予定あり">✕<small>予定</small></button></td>`; return; }
      if (isPast(d)) {
        // 過ぎた日：予約の変更・取り消しはできない。押せるのは実施・欠席のチェックだけ（依頼者指定）
        const one = bs.length > 1 ? null : b;
        const act = bs.length > 1 ? `data-act="pastMulti" data-d="${d}" data-p="${p}"` : one ? `data-act="pastCheck" data-id="${one.id}"` : "disabled";
        h += `${td}<button class="wc past ${bs.length ? "bk" : ""} ${one && acked(one) ? "ackd" : ""} ${one && one.status === "draft" ? "draft" : ""} ${one && one.result || ""}" ${act} aria-label="${lb}（過ぎた日）">${bs.length > 1 ? `${bs.length}人<small>${multiShort(bs)}</small>` : one ? `${esc(ST(one.token) ? shortName(ST(one.token)) : "?")}<small>${one.result === "done" ? "実施" : one.result === "absent" ? "欠席" : one.lessonType ? SHORT[one.lessonType] || PT(one.lessonType).label : ""}</small>` : ""}</button></td>`;
        return;
      }
      // 高速教習（3時限）に一緒に入れる人を選んでいる時は、その組の始まりの枠を光らせる
      const joinEv = b && pk && SHARED.includes(S.ptype) && b.lessonType === S.ptype ? evaluatePair(pk, d, p, S.ptype) : null;
      if (joinEv && joinEv.ok) {
        h += `${td}<button class="wc cand ${S.ptype === "kiken" ? "kk" : "hw"}" data-act="assignPair" data-s="${pk.token}" data-d="${d}" data-p="${p}" data-t="${S.ptype}" aria-label="${lb}から${PT(S.ptype).label}に一緒に入れる">${spanText(p, S.ptype)}<small>一緒に${joinEv.join + 1}/${CAP(S.ptype)}人</small></button></td>`;
      } else if (bs.length > 1) {
        const allAck = bs.every(acked);
        h += `${td}<button class="wc bk ${allAck ? "ackd" : ""} ${bs.every(x => x.status === "draft") ? "draft" : ""}" data-act="bookedMulti" data-d="${d}" data-p="${p}" aria-label="${lb} ${PT(bs[0].lessonType).label} ${bs.length}人">${bs.length}人<small>${multiShort(bs)}</small></button></td>`;
      } else if (b) {
        const s = ST(b.token);
        const gone = goneDraft(b);
        h += `${td}<button class="wc bk ${acked(b) ? "ackd" : ""} ${b.status === "draft" ? "draft" : ""} ${gone ? "gone" : ""} ${b.result || ""}" data-act="booked" data-id="${b.id}" aria-label="${lb} ${esc(nm(s))}${gone ? " 教習生が空き時間を取り消しました" : ""}${acked(b) ? " 教習生が確認済み" : ""}">${esc(s ? shortName(s) : "?")}<small>${b.subUid && !b.result ? `→${esc(String(b.subName || "").slice(0, 3))}` : b.result === "done" ? "実施" : b.result === "absent" ? "欠席" : gone ? "空き取消" : b.cancelRequested ? "キャンセル希望" : b.lessonType ? SHORT[b.lessonType] || PT(b.lessonType).label : b.highway ? "高速" : b.status === "draft" ? "未確定" : acked(b) ? "確認済" : "通知済み"}</small></button></td>`;
      } else if (pk && S.ptype && hasSpecial(pk)) {
        const ev = evaluatePair(pk, d, p, S.ptype), ok = ev.ok, L = PT(S.ptype).label;
        h += `${td}<button class="wc ${ok ? `cand ${S.ptype === "kiken" ? "kk" : "hw"}` : "off"}" ${ok ? `data-act="assignPair" data-s="${pk.token}" data-d="${d}" data-p="${p}" data-t="${S.ptype}"` : "disabled"} aria-label="${lb}${ok ? `から${L}で割り当て可${ev.dark ? "（日没が早い期間のため要確認）" : ""}` : ""}">${ok ? `${spanText(p, S.ptype)}<small>${L}${ev.dark ? "・要確認" : ""}</small>` : ""}</button></td>`;
      } else if (pk) {
        const ok = evaluate(pk, d, p).ok !== false;
        h += `${td}<button class="wc ${ok ? "cand" : "off"}" ${ok ? `data-act="assign" data-s="${pk.token}" data-d="${d}" data-p="${p}"` : "disabled"} aria-label="${lb}${ok ? " 割り当て可" : ""}">${ok ? "◯" : ""}</button></td>`;
      } else {
        const n = S.students.filter(s => isFree(s.token, d, p)).length;
        const c = n === 0 ? "" : n <= T1 ? "lv1" : n <= T2 ? "lv2" : "lv3";
        h += `${td}<button class="wc ${c}" ${n && S.mode === "slot" ? `data-act="open" data-d="${d}" data-p="${p}"` : "disabled"} aria-label="${lb} 空き${n}人">${n ? `${n}人<span class="bar"><i style="width:${Math.round(n / maxN * 100)}%"></i></span>` : "—"}</button></td>`;
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
      h += `<button class="srow" aria-pressed="${S.pick === s.token}" data-act="pick" data-s="${s.token}"><span><span class="t">${esc(nm(s))}</span>${S.late[s.token] ? ' <span class="tag late">締切後に変更あり</span>' : ""}<br><span class="s">${info(s)}・この週の空き${freeCount(s)}枠</span></span><span class="cnt ${n ? "some" : "zero"}">${n ? `今週${n}時限` : "予約なし"}</span></button>`;
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
    un.forEach(s => { h += `<div class="item"><div class="t">${esc(nm(s))}</div><span style="display:flex;gap:6px;align-items:center"><span class="tag wait">未確認</span><button class="btn" data-act="renotify" data-s="${s.token}">再通知</button></span></div>`; });
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
    h += `<div class="item"><div><div class="t">${esc(nm(s))}${S.late[s.token] ? ' <span class="tag late">締切後に変更</span>' : ""}</div><div class="s">${info(s)}</div>${note}</div>${btn}</div>`;
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
  const grp0 = SHARED.includes(type) ? groupAt(ds, a, type) || [] : [];
  if (grp0.length) h += `<div class="banner info">この時限の${L}には、すでに${grp0.map(t => esc(nm(ST(t)))).join("・")}が入っています（${CAP(type)}人まで一緒に入れます）。</div>`;
  const c = S.students.filter(s => !grp0.includes(s.token) && specialTypes(s).includes(want) && ps.every(q => isFree(s.token, ds, q)))
    .sort((x, y) => weekCount(x.token) - weekCount(y.token) || String(x.deadline || "9").localeCompare(String(y.deadline || "9")));
  h += `<div style="font-size:13px;color:var(--muted);margin-bottom:8px">${type === "kiken" ? `${KK().label}（${lessonsOf(2, "kikenNo")}時限目）` : `高速教習（${lessonsOf(2, "hwNo")}時限目から）`}の番で、${spanText(a, type)}限がすべて空いている教習生 ${c.length}人</div><div class="list">`;
  c.forEach(s => {
    const ev = evaluatePair(s, ds, a, type);
    const note = !ev.ok ? `<div class="s" style="color:var(--orange)">${esc(ev.reason)}</div>`
      : ev.dark ? `<div class="s" style="color:var(--orange)">日没が早い期間のため要確認</div>`
      : ev.combo ? `<div class="s" style="color:var(--muted)">${KK().label}→${PT("hwSolo").label}の組み合わせ（この日は4時限）</div>` : "";
    h += `<div class="item"><div><div class="t">${esc(nm(s))}</div><div class="s">${info(s)}</div>${note}</div><button class="btn accent" data-act="assignPair" data-s="${s.token}" data-d="${ds}" data-p="${a}" data-t="${type}" ${ev.ok ? "" : "disabled"}>${L}で入れる</button></div>`;
  });
  if (!c.length) h += `<div class="hist"><div>入れられる教習生はいません。</div></div>`;
  sheet(h + `</div><button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
}
// 高速教習（3時限）・危険予測の予約に、ほかの教習生を一緒に入れるボタン（満員でない時）
function joinBtn(b) {
  if (!b || !SHARED.includes(b.lessonType) || b.result || isPast(b.date)) return "";
  const a = Math.min(...S.bookings.filter(x => x.pairId === b.pairId && x.token === b.token).map(x => x.period));
  const grp = groupAt(b.date, a, b.lessonType);
  if (!grp || grp.length >= CAP(b.lessonType)) return "";
  return `<button class="btn primary full" data-act="groupJoin" data-d="${b.date}" data-p="${a}" data-t="${b.lessonType}">この${PT(b.lessonType).label}に一緒に入れる（あと${CAP(b.lessonType) - grp.length}人）</button>`;
}
// 何人かで入っている枠の短い表示（「高速」「危険」）
const multiShort = bs => bs.some(b => b.subUid) ? "依頼含む" : bs[0].lessonType === "kiken" ? SHORT.kiken || "危険" : "高速";
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
  // 「はい」にチェックを付けないとOKを押せない（依頼者指定）
  sheet(`<h3>学科の受講確認</h3><p>${esc(nm(s))}（第${s.stage}段階 ${rules.map(r => `${r.no}時限目`).join("・")}）</p>
  ${rules.map(r => `<p style="font-size:16px"><b>${esc(r.ask || `学科の${r.gakka}教程は終了していますか？`)}</b></p>`).join("")}
  <label class="ackchk">はい <input type="checkbox" id="gk_chk"></label>
  <div class="list" style="margin-top:10px"><button class="btn primary full" id="gk_ok" data-act="gakkaOk" disabled>OK</button></div>`);
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
  <p>${esc(nm(s))}（第${s.stage}段階）<br>${md(ds)} の <b>${spanText(a, type)}限</b></p>
  <div class="banner warn"><b>注意：${fmt(dk.from)}〜${fmt(dk.to)}は日没が早いため、${spanText(a, type)}限の${L}は原則入れられません。</b><br>それでも入れる場合は「警告を確認して入れる」を押してください。</div>
  <div class="list"><button class="btn accent full" data-act="assignPairForce" data-s="${s.token}" data-d="${ds}" data-p="${a}" data-t="${type}">警告を確認して入れる（強制）</button>
  <button class="btn full" data-act="close">やめる</button></div>`);
}
async function assignPair(tok, ds, a, type = "kiken", force, gk, quiet) {
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
  if (S.confirmed) { await notifyStudent(tok, "added", "予約が追加されました", `${md(ds)} ${spanText(a, type)}限（${L}）`); toast(`${nm(s)}に通知しました`); }
  else if (!quiet) toast(`${md(ds)} ${spanText(a, type)}限に${nm(s)}の${L}を入れました`);
  if (!quiet) render();
}

async function assign(tok, ds, p, gk, quiet) {
  const s = ST(tok);
  const ev = evaluate(s, ds, p);
  if (ev.ok === false) return toast(ev.reason);
  if (!gk) { const r = gakkaAsk(s, ds, [p]); if (r.length) return gakkaSheet(s, r, () => assign(tok, ds, p, true)); }
  const status = S.confirmed ? "confirmed" : "draft";
  const data = { instructorUid: S.uid, date: ds, period: p, weekId: wid(), status, cancelRequested: false, result: null, stage: s.stage, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const ref = await addDoc(collection(db, "students", tok, "bookings"), data);
  S.bookings.push({ id: ref.id, token: tok, ...data }); S.pending.push(S.bookings.at(-1));
  if (S.confirmed) { await notifyStudent(tok, "added", "予約が追加されました", label(ds, p)); toast(`${nm(s)}に通知しました`); }
  else if (!quiet) toast(`${label(ds, p)} に${nm(s)}を入れました`);
  if (!quiet) render();
}
// この週の空いている枠に、ルールどおり自動で割り振る（未確定で入る。指導員が見て直してから確定する。依頼者と決めた考え方）
//  ・この週の予約が少ない人から1人ずつ交代で（並んだら教習期限が近い人）。1人1週 autoAssign.weeklyMax 時限まで。日時の早い枠から
//  ・その段階の最低時限まで入れたら、みきわめの結果が出るまで入れない。不合格なら、未実施の予約が2時限になるまで入れる（延びる人がいるため。依頼者指定）。教習の順番がずれている人は入れない
//  ・高校生（教習生番号 3001〜3999）は優先：順番を lead 時限分だけ先にし、1週の上限も extraMax だけ多い（依頼者指定。不公平にならない程度）
//  ・危険予測・高速教習は番の人だけ（高速教習は3時限→単独高速の順。一緒に入れる組があれば一緒に）
//  ・日没が早い期間の警告が出る枠と、学科の確認が要る教習（第2段階10・13時限目）は入れない（指導員が手で入れる）
//  ・どんなに空きが少なくても、全員が週1回は乗れるようにする（最低ライン）。基本は担当制なので、ほかの指導員への依頼（helpersOf・assignVia）は
//    担当の枠がどうしても無くて週1回に届かない人だけに使う（乱用しない。依頼者指定）
// 自動で入れる枠の順番。ふつうは日時の早い順。みきわめ不合格で検定日（予定）が決まっている人は、
// 検定日の前日の1〜7限を一番に、あとは検定日に近い日から（検定日当日以降には入れない。依頼者指定）
function slotOrder(s, mk) {
  const all = days().flatMap(d => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(q => [d, q]));
  const plan = mk && !mk.passed && s[`kenteiPlan${s.stage}`];
  if (!plan) return all;
  const eve = dateStr(addDays(parseDate(plan), -1)), day = q => q <= 7 ? 0 : 1;
  return all.filter(([d]) => d < plan).sort((a, b) => ((a[0] === eve ? 0 : 1) + day(a[1])) - ((b[0] === eve ? 0 : 1) + day(b[1])) || b[0].localeCompare(a[0]) || day(a[1]) - day(b[1]) || a[1] - b[1]);
}
// 高校生か（教習生番号が config の highSchool の範囲。依頼者指定：3001〜3999）
const isHighSchool = s => { const h = (CFG.autoAssign || {}).highSchool, n = +s.studentNo; return !!h && n >= h.from && n <= h.to; };
// 担当の枠がどうしても無くて週1回に届かない人だけ、その時間に空いているほかの指導員への依頼として入れる（通常の教習だけ。依頼者指定）。
// 相手の✕・自分の予約・頼まれた教習のある時間は使わない。1人の指導員に頼むのは1週 autoAssign.delegateMax 時限まで、少ない人から
async function helpersOf() {
  const ins = (await getDocs(collection(db, "instructors"))).docs.map(d => ({ uid: d.id, ...d.data() })).filter(i => i.uid !== S.uid);
  const yms = [...new Set(days().map(d => d.slice(0, 7)))];
  for (const i of ins) {
    i.busy = new Set(); i.n = 0;
    for (const ym of yms) {
      const od = await getDoc(doc(db, "offs", `${i.uid}_${ym}`));
      (od.exists() ? od.data().slots || [] : []).forEach(k => { const [dd, q] = k.split("-"); i.busy.add(`${ym}-${String(dd).padStart(2, "0")}|${q}`); });
    }
    const own = await getDocs(query(collectionGroup(db, "bookings"), where("instructorUid", "==", i.uid), where("weekId", "==", wid())));
    own.docs.map(d => d.data()).filter(b => b.status !== "cancelled" && !b.subUid).forEach(b => i.busy.add(`${b.date}|${b.period}`));
    const sub = await getDocs(query(collectionGroup(db, "bookings"), where("subUid", "==", i.uid), where("weekId", "==", wid())));
    sub.docs.map(d => d.data()).filter(b => b.status !== "cancelled").forEach(b => { i.busy.add(`${b.date}|${b.period}`); if (b.subFrom === S.uid) i.n++; });
  }
  return ins;
}
async function assignVia(s, ds, p, h) {
  const data = { instructorUid: S.uid, date: ds, period: p, weekId: wid(), status: "draft", cancelRequested: false, result: null, stage: s.stage,
    subUid: h.uid, subName: h.name, subFrom: S.uid, subFromName: S.me.name, subStudent: nm(s), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const ref = await addDoc(collection(db, "students", s.token, "bookings"), data);
  S.bookings.push({ id: ref.id, token: s.token, ...data }); S.pending.push(S.bookings.at(-1));
  h.busy.add(`${ds}|${p}`); h.n++;
}
async function autoAssign() {
  if (S.confirmed) return toast("確定済みの週は自動で割り振れません");
  const AA = CFG.autoAssign || {}, max = AA.weeklyMax || 6, extra = AA.extra ?? 2, hs = AA.highSchool || {}, minW = AA.minPerWeek ?? 1, gk = new Map(), ng = new Set();
  let made = 0, viaN = 0, helpers = null, hErr = "";
  sheet(`<h3>自動で割り振っています…</h3><p style="font-size:13px;color:var(--muted)">少しお待ちください。</p>`);
  // 今週の予約が少ない人から（高校生は lead 時限分だけ先に。並んだら高校生→教習期限が近い人）
  const key = s => weekCount(s.token) - (isHighSchool(s) ? hs.lead || 0 : 0);
  const order = () => S.students.slice().sort((a, b) => key(a) - key(b) || isHighSchool(b) - isHighSchool(a) || String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
  // まだ入れてよい人か（入れてよければ、入れる教習の種類の候補を返す）
  const want = s => {
    if (weekCount(s.token) >= max + (isHighSchool(s) ? hs.extraMax || 0 : 0) || gk.has(s.token)) return null;
    const mk = s[`mikiwame${s.stage}`], pl = planOf(s);
    if (mk && mk.passed) return null;
    if (!pl.ok) { ng.add(s.token); return null; }
    if (mk ? pendingOf(s).length >= extra : pl.total >= lessonMin(s.stage, s)) return null;
    const types = specialTypes(s);
    return types.includes("kiken") ? ["kiken"] : types.length ? ["hw3", "hwSolo"] : [""];
  };
  // 担当（自分）の枠に1つ入れる。"ok"＝入れた、"skip"＝学科の確認が要るので入れない、""＝入る枠がない
  const ownOne = async (s, tries) => {
    for (const [d, q] of slotOrder(s, s[`mikiwame${s.stage}`])) for (const ty of tries) {
      const ev = ty ? evaluatePair(s, d, q, ty) : evaluate(s, d, q);
      if (ev.ok === false || ev.dark) continue;
      const r = gakkaAsk(s, d, ty ? span(q, ty) : [q], ty);
      if (r.length) { gk.set(s.token, r.map(x => `${x.no}時限目`).join("・")); return "skip"; }
      if (ty) await assignPair(s.token, d, q, ty, false, true, true); else await assign(s.token, d, q, true, true);
      return "ok";
    }
    return "";
  };
  const ownSlots = s => days().reduce((c, d) => c + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(q => canBook(s, d, q)).length, 0);
  // 担当の枠がどうしても無い時だけ、空いているほかの指導員に1つ依頼する（通常の教習だけ）
  const viaOne = async s => {
    if (AA.delegate === false) return "";
    if (!helpers) { try { helpers = await helpersOf(); } catch (e) { helpers = []; noteIndex(e); hErr = friendlyError(e); } }
    const cap = AA.delegateMax || 6;
    for (const [d, q] of slotOrder(s, s[`mikiwame${s.stage}`])) {
      const ev = evaluate(s, d, q, true);
      if (ev.ok === false || ev.dark) continue;
      const free = helpers.filter(h => h.n < cap && !h.busy.has(`${d}|${q}`)).sort((a, b) => a.n - b.n);
      if (!free.length) continue;
      const r = gakkaAsk(s, d, [q]);
      if (r.length) { gk.set(s.token, r.map(x => `${x.no}時限目`).join("・")); return "skip"; }
      await assignVia(s, d, q, free[0]); return "ok";
    }
    return "";
  };
  try {
    // 1回目：どんなに空きが少なくても、全員が週 minPerWeek 回は乗れるように（最低ライン。依頼者指定）。
    // 入れる枠が少ない人から先に、まず担当の枠へ。担当の枠がどうしても無い人だけ、ほかの指導員に依頼する
    for (let k = 0; k < minW; k++) {
      const need = S.students.filter(s => weekCount(s.token) <= k && want(s)).sort((a, b) => ownSlots(a) - ownSlots(b));
      for (const s of need) {
        const tries = want(s); if (!tries) continue;
        let r = await ownOne(s, tries);
        if (!r && tries[0] === "") { r = await viaOne(s); if (r === "ok") viaN++; }
        if (r === "ok") made++;
      }
    }
    // 2回目：担当の枠に、予約の少ない人から1人ずつ交代で入れる（基本は担当制。ほかの指導員への依頼はしない。依頼者指定）
    for (let round = 0; round < 80; round++) {
      let progress = false;
      for (const s of order()) {
        const tries = want(s); if (!tries) continue;
        if (await ownOne(s, tries) === "ok") { made++; progress = true; }
      }
      if (!progress) break;
    }
  } finally { closeSheet(); render(); }
  const none = S.students.filter(s => !weekCount(s.token) && !(s[`mikiwame${s.stage}`] || {}).passed);
  const used = (helpers || []).filter(h => h.n);
  sheet(`<h3>自動で割り振りました</h3><p style="font-size:16px"><b>${made}件</b>を未確定で入れました。マス目を見て、直したいところは直してから「この週の予約を確定して通知」を押してください（確定するまで教習生には通知されません）。</p>
    ${viaN ? `<div class="banner info"><b>そのうち${viaN}件は、ほかの指導員への依頼として入れました</b>${used.map(h => `<br>${esc(h.name)} 指導員：${h.n}時限`).join("")}<br><span style="font-size:12px">マス目には「名字→依頼先」で出ます。依頼先を変える・やめる時は、そのマスを押してください。</span></div>` : ""}
    ${hErr ? `<div class="banner warn">ほかの指導員の空きを調べられませんでした（${esc(hErr)}）。</div>${indexBanner()}` : ""}
    ${gk.size ? `<div class="banner warn"><b>学科の確認が要るため入れていません</b>${[...gk].map(([t, n]) => `<br>${esc(nm(ST(t)))}：${n}`).join("")}<br><span style="font-size:12px">学科の受講を確かめてから、手で入れてください。</span></div>` : ""}
    ${ng.size ? `<div class="banner warn"><b>教習の順番がずれているため入れていません</b>${[...ng].map(t => `<br>${esc(nm(ST(t)))}`).join("")}</div>` : ""}
    ${none.length ? `<div class="banner info"><b>この週に1つも入らなかった教習生</b>${none.map(s => `<br>${esc(nm(s))}（${freeCount(s) ? `空き${freeCount(s)}枠` : "空き時間なし"}）`).join("")}</div>` : ""}
    <div class="list"><button class="btn primary full" data-act="close">OK</button></div>`);
}
// 危険予測・高速教習の組（2時限・3時限）を全部集める。表示中の週に無い予約（別の週のキャンセル希望など）もあるので、DBから読む
async function pairGroup(b) {
  if (!b.pairId) return [b];
  const snap = await getDocs(query(collection(db, "students", b.token, "bookings"), where("pairId", "==", b.pairId)));
  const group = snap.docs.map(d => ({ id: d.id, token: b.token, ...d.data() })).filter(x => x.status !== "cancelled");
  if (!group.some(x => x.id === b.id)) group.push(b);
  return group.sort((x, y) => x.period - y.period);
}
async function removeBooking(b, why) {
  // 危険予測・高速教習は組で1つ。1時限だけ残らないように、必ず組ごと取り消す
  const group = await pairGroup(b);
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
  // 危険予測・高速教習は組の全部をまとめてチェックする
  const pairs = new Set(S.pending.filter(b => ids.includes(b.id) && b.pairId).map(b => `${b.token}|${b.pairId}`));
  ids = S.pending.filter(b => ids.includes(b.id) || (b.pairId && pairs.has(`${b.token}|${b.pairId}`))).map(b => b.id);
  const list = S.pending.filter(b => ids.includes(b.id));
  if (!list.length) return;
  const tok = list[0].token, s = ST(tok), it = lessonItems(list)[0], planWas = s && s[`kenteiPlan${s.stage}`];
  const batch = writeBatch(db);
  list.forEach(b => batch.update(doc(db, "students", tok, "bookings", b.id), { result, resultAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  const text = `${md(it.date)} ${list.map(b => b.period).sort((m, n) => m - n).join("・")}限${typeName(list[0]) ? `（${typeName(list[0])}）` : ""}`;
  if (result === "done") {
    const upd = { doneCount: increment(it.units) };
    if (it.lessonType === "kiken") upd.kikenDone = true;
    if (isHwType(it.lessonType)) upd.hwDone = true;
    // 決まっていた検定日（予定）は、合格ならみきわめの検定日へ移り、不合格なら取り消す（依頼者指定）
    if (mk) { upd[`mikiwame${s.stage}`] = { ...mk, date: it.date, bookingIds: ids, at: Timestamp.now() }; upd[`kenteiPlan${s.stage}`] = null; }
    // 技能開始日：最初に「実施」にした教習の日を自動で入れる（依頼者指定）
    if (s && (!s.skillStart || s.skillStart > it.date)) upd.skillStart = it.date;
    batch.update(doc(db, "students", tok), upd);
  } else {
    batch.set(doc(collection(db, "outbox")), outboxData(tok, "absent", "欠席のお知らせ", `${text} は欠席として記録しました。次の予約は担当指導員からお知らせします。`));
    batch.update(doc(db, "students", tok), { lastNotifiedAt: serverTimestamp() });
  }
  await batch.commit();
  if (result !== "done") sendNow();
  if (s) {
    if (result === "done") { if (!s.skillStart || s.skillStart > it.date) s.skillStart = it.date; s.doneCount = (s.doneCount || 0) + it.units; if (it.lessonType === "kiken") s.kikenDone = true; if (isHwType(it.lessonType)) s.hwDone = true; if (mk) { s[`mikiwame${s.stage}`] = { ...mk, date: it.date, bookingIds: ids }; s[`kenteiPlan${s.stage}`] = null; } }
    else s.lastNotifiedAt = Timestamp.now();
  }
  S.pending = S.pending.filter(b => !ids.includes(b.id));
  S.bookings.forEach(b => { if (ids.includes(b.id)) b.result = result; });
  render();
  const planGone = mk && !mk.passed && planWas ? `。決まっていた検定日（${md(planWas)}）は取り消しました` : "";
  if (!mk || mk.gakkaDone) toast(result === "done" ? `${nm(s)} ${text} を実施にしました${mk ? `（みきわめ${mk.passed ? "合格" : "不合格"}）` : ""}${planGone}` : `${nm(s)}に欠席を通知しました`);
  else sheet(`<h3>${esc(nm(s))}を実施にしました（みきわめ${mk.passed ? "合格" : "不合格"}）</h3>
    <div class="banner warn">「<b>検定日の2日前までに学科及び効果測定を終わらせておかないといけません</b>」ということを教習生に伝えてください。</div>
    <div class="banner warn">学科及び効果測定が終了していない教習生に対する<b>みきわめ報告書</b>を提出してください。</div>
    <div class="list"><button class="btn primary full" data-act="close">OK</button></div>`);
}
// みきわめの教習を「実施」にする時のフォーム（合否・検定日・学科及び効果測定）
// 第1段階の検定日の欄：生年月日を持たせて、18歳の誕生日より前の日を入れた時にすぐ警告する（高校生。依頼者指定）
const ageAttr = s => s.stage === 1 && s.birthDate ? ` data-birth="${esc(s.birthDate)}"` : "";
const ageOk = el => { const ng = el && el.dataset.birth && kentei1AgeNg(el.dataset.birth, el.value); return !ng || confirm(`${ng}\n\nこのまま検定日を入れますか？`); };
function mikiwameSheet(s, it, ids) {
  const r = (n, v, t) => `<label class="radio"><input type="radio" name="${n}" value="${v}"> ${t}</label>`;
  sheet(`<h3>みきわめ（第${s.stage}段階 ${it.no}時限目）</h3>
  <p>${esc(nm(s))}<br>${md(it.date)} ${it.bookings.map(b => b.period).join("・")}限</p>
  <div class="field"><label>みきわめの結果</label><div class="radios">${r("mk_pass", "1", "合格")}${r("mk_pass", "0", "不合格")}</div></div>
  ${s[`kenteiPlan${s.stage}`] ? `<p style="font-size:12px;color:var(--muted);margin:-4px 0 10px">決まっている検定日：${md(s[`kenteiPlan${s.stage}`])}（不合格の時は取り消します）</p>` : ""}
  <div id="mk_kentei" hidden><div class="field"><label for="mk_date">検定日</label><input id="mk_date" type="date" value="${esc(s[`kenteiPlan${s.stage}`] || "")}"${ageAttr(s)}><div class="agewarn"></div></div>
    <label class="radio" style="margin:-4px 0 12px"><input type="checkbox" id="mk_und"> 検定日は未確定</label></div>
  <div class="field"><label>学科及び効果測定</label><div class="radios">${r("mk_gakka", "1", "終わっている")}${r("mk_gakka", "0", "終わっていない")}</div></div>
  <div class="list"><button class="btn accent full" data-act="mkOk" data-ids="${ids.join(",")}">OK</button><button class="btn full" data-act="close">やめる</button></div>`);
}
// チェックの付け間違いを戻す
async function unmarkResult(b) {
  const group = await pairGroup(b);
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
  group.forEach(x => { x.result = null; const lb = S.bookings.find(y => y.id === x.id); if (lb) lb.result = null; if (!S.pending.some(y => y.id === x.id)) S.pending.push(lb || x); });
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
  document.getElementById("ntcWrap").hidden = v !== "notice";
  document.getElementById("offWrap").hidden = v !== "off";
  if (v === "off") renderOff();
  if (v === "notice") renderNoticeTab();
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
  off: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M9 13l6 5M15 13l-6 5"/></svg>',
  notice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>'
};
const NAV = [["manage", "教習生の管理"], ["off", "予定の登録"], ["assign", "予約の管理"], ["notice", "お知らせ"], ["settings", "設定"]];
function renderNav() {
  const nav = document.getElementById("tabnav"), on = !!(S.uid && S.me);
  document.body.classList.toggle("shell", on); nav.hidden = !on;
  if (!on) { nav.innerHTML = ""; return; }
  nav.innerHTML = `<div class="tn-head"><b>${esc(CFG.schoolName)}</b><small>${esc(S.me.name)} 指導員</small></div>
    <div class="tn-tabs" role="tablist">${NAV.map(([v, t]) => `<button role="tab" aria-selected="${S.view === v}" data-act="view" data-v="${v}">${ICON[v]}<span>${t}</span></button>`).join("")}</div>
    <div class="tn-foot"><a class="linkbtn" href="guide-instructor.html">使い方</a><button class="linkbtn" data-act="logout">ログアウト</button></div>`;
}

/* ---------- お知らせ（これまでに入った新着情報。新しい順） ---------- */
function renderNoticeTab() {
  if (!S.me) return;
  document.getElementById("ntc").innerHTML = `<div class="topbar"><div><h1>お知らせ</h1><small>${esc(S.me.name)} 指導員</small></div></div>
  <section class="panel"><div class="body">${noticeHistoryHtml(`staff_${S.uid}`)}</div></section>`;
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
onViewChange(() => { if (S.uid && S.me) { render(); if (S.view === "settings") renderSettings(); if (S.view === "off") renderOff(); } });

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
    else if (a === "gakkaOk") { if (!document.getElementById("gk_chk")?.checked) return; const go = S.gakkaGo; S.gakkaGo = null; t.disabled = true; closeSheet(); if (go) await go(); }
    else if (a === "booked") {
      const b = S.bookings.find(x => x.id === t.dataset.id); const s = ST(b.token);
      const it = itemOf(b);
      const head = `<h3>${label(b.date, b.period)}</h3><p><b>${esc(nm(s))}</b>（第${s ? s.stage : "-"}段階）${it && s ? `・${noText(s, it)}` : ""}${typeName(b) ? `<br>${typeName(b)}${b.pairId ? `（${LEN(b.lessonType)}時限まとめて扱います）` : ""}` : ""}${b.status === "confirmed" ? `<br><span class="tag ${b.ackAt ? "ok" : "wait"}">${b.ackAt ? `教習生が確認済み${b.ackAt.toDate ? `（${md(dateStr(b.ackAt.toDate()))} ${String(b.ackAt.toDate().getHours()).padStart(2, "0")}:${String(b.ackAt.toDate().getMinutes()).padStart(2, "0")}）` : ""}` : "教習生はまだ確認していません"}</span>` : ""}`;
      if (b.result) {
        sheet(`${head}<br><span class="tag ${b.result === "done" ? "ok" : "wait"}">${b.result === "done" ? "実施済み" : "欠席"}</span></p>
        <div class="list"><button class="btn full" data-act="unmark" data-id="${b.id}">チェックを取り消す（付け間違いの時）</button><button class="btn full" data-act="close">閉じる</button></div>`);
      } else {
        sheet(`${head}<br><span style="font-size:13px;color:var(--muted)">${b.status === "draft" ? "まだ確定していません。" : "教習生に通知済みです。取り消すと自動で通知されます。"}</span></p>
        ${b.subUid ? `<div class="banner info" style="margin-top:0"><b>${esc(b.subName)} 指導員に依頼しています。</b><br><span style="font-size:12px">この時限には、別の教習生を入れることもできます。</span></div>` : ""}
        <div class="list">${isPast(b.date) ? "" : b.subUid ? `<button class="btn full" data-act="undelegate" data-id="${b.id}">依頼をやめる（自分で教える）</button><button class="btn full" data-act="open" data-d="${b.date}" data-p="${b.period}">この時限に別の教習生を入れる</button>` : `<button class="btn primary full" data-act="delegate" data-id="${b.id}">他の人に依頼する</button>`}${joinBtn(b)}<button class="btn full" data-act="swap" data-id="${b.id}">別の教習生に変える</button><button class="btn accent full" data-act="unbook" data-id="${b.id}">この予約を取り消す</button><button class="btn full" data-act="close">閉じる</button></div>`);
      }
    }
    else if (a === "delegate") {
      // この予約（危険予測・高速教習は組ごと）を、その時間に空いているほかの指導員に頼む
      const b = S.bookings.find(x => x.id === t.dataset.id), s = ST(b.token), group = await pairGroup(b), ps = group.map(x => x.period);
      sheet(`<h3>他の人に依頼する</h3><p>探しています…</p>`);
      const rows = [];
      try {
      const ins = (await getDocs(collection(db, "instructors"))).docs.map(d => ({ uid: d.id, ...d.data() })).filter(i => i.uid !== S.uid);
      for (const i of ins) {
        const od = await getDoc(doc(db, "offs", `${i.uid}_${b.date.slice(0, 7)}`)), off = new Set(od.exists() ? od.data().slots || [] : []);
        const day = parseDate(b.date).getDate();
        const own = (await getDocs(query(collectionGroup(db, "bookings"), where("instructorUid", "==", i.uid), where("date", "==", b.date)))).docs.map(d => d.data()).filter(x => x.status !== "cancelled" && !x.subUid);
        const sub = (await getDocs(query(collectionGroup(db, "bookings"), where("subUid", "==", i.uid), where("date", "==", b.date)))).docs.map(d => d.data()).filter(x => x.status !== "cancelled");
        const why = ps.some(q => off.has(slotKey(day, q))) ? "予定（✕）あり" : ps.some(q => own.some(x => x.period === q) || sub.some(x => x.period === q)) ? "ほかの予約あり" : "";
        rows.push(`<div class="item"><div><div class="t">${esc(i.name)} 指導員</div><div class="s" style="${why ? "color:var(--orange)" : ""}">${why || "空いています"}</div></div><button class="btn accent" data-act="delegateTo" data-id="${b.id}" data-u="${i.uid}" data-n="${esc(i.name)}" ${why ? "disabled" : ""}>依頼する</button></div>`);
      }
      } catch (e) { closeSheet(); noteIndex(e); render(); return toast(friendlyError(e)); }
      sheet(`<h3>他の人に依頼する</h3><p>${esc(nm(s))}<br>${md(b.date)} ${ps.join("・")}限${typeName(b) ? `（${typeName(b)}）` : ""}</p>
        <p style="font-size:12px;color:var(--muted);margin-top:0">依頼した時限は、相手の指導員のマス目に「（あなたの名字）依頼」の印付きで出ます。担当（進み具合・実施のチェックなど）は今まで通りです。</p>
        <div class="list">${rows.join("") || '<div class="hist"><div>ほかの指導員が登録されていません。</div></div>'}</div><button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
    }
    else if (a === "delegateTo" || a === "undelegate") {
      const b = S.bookings.find(x => x.id === t.dataset.id), group = await pairGroup(b), on = a === "delegateTo";
      const upd = on ? { subUid: t.dataset.u, subName: t.dataset.n, subFrom: S.uid, subFromName: S.me.name, subStudent: nm(ST(b.token)) } : { subUid: null, subName: null, subFrom: null, subFromName: null, subStudent: null };
      if (!on && group.some(x => bookAt(x.date, x.period))) return toast("この時限には、すでに別の教習生が入っています。先にそちらを動かしてください");
      t.disabled = true;
      for (const x of group) await updateDoc(doc(db, "students", x.token, "bookings", x.id), { ...upd, updatedAt: serverTimestamp() });
      S.bookings.forEach(x => { if (group.some(g => g.id === x.id)) Object.assign(x, upd); });
      closeSheet(); render(); toast(on ? `${t.dataset.n} 指導員に依頼しました` : "依頼をやめました");
    }
    else if (a === "subInfo") {
      const b = S.subs.find(x => x.id === t.dataset.id);
      sheet(`<h3>${label(b.date, b.period)}　依頼された教習</h3><p><b>${esc(b.subStudent || "")}</b><br>この教習生は、<b>${esc(b.subFromName || "")}さんからの依頼</b>です。${typeName(b) ? `<br>${typeName(b)}` : ""}</p>
        <p style="font-size:13px;color:var(--muted)">実施・欠席のチェックは、担当の指導員がします。</p><div class="list"><button class="btn full" data-act="close">閉じる</button></div>`);
    }
    else if (a === "pastCheck") {
      // 過ぎた日の予約：実施・欠席のチェック（と付け間違いの取り消し）だけ
      const b = S.bookings.find(x => x.id === t.dataset.id), s = ST(b.token);
      const ids = S.pending.filter(x => x.token === b.token && (b.pairId ? x.pairId === b.pairId : x.id === b.id)).map(x => x.id);
      const head = `<h3>${label(b.date, b.period)}</h3><p><b>${esc(nm(s))}</b>${typeName(b) ? `<br>${typeName(b)}${b.pairId ? `（${LEN(b.lessonType)}時限まとめて扱います）` : ""}` : ""}<br><span style="font-size:13px;color:var(--muted)">過ぎた日の予約は、実施・欠席のチェックだけできます。</span></p>`;
      if (b.result) sheet(`${head}<p><span class="tag ${b.result === "done" ? "ok" : "wait"}">${b.result === "done" ? "実施済み" : "欠席"}</span></p>
        <div class="list"><button class="btn full" data-act="unmark" data-id="${b.id}">チェックを取り消す（付け間違いの時）</button><button class="btn full" data-act="close">閉じる</button></div>`);
      else if (b.status !== "confirmed" || !ids.length) sheet(`${head}<p>確定されなかった予約のため、チェックはできません。</p><div class="list"><button class="btn full" data-act="close">閉じる</button></div>`);
      else sheet(`${head}<p style="font-size:13px">教習生が来たら「実施」、来なかったら「欠席」を押してください（欠席は教習生に通知されます）。</p>
        <div class="tools"><button class="btn" data-act="markAbsent" data-ids="${ids.join(",")}">欠席</button><button class="btn accent" data-act="markDone" data-ids="${ids.join(",")}">実施</button></div>
        <div class="list" style="margin-top:10px"><button class="btn full" data-act="close">閉じる</button></div>`);
    }
    else if (a === "pastMulti") {
      const bs = bookingsAt(t.dataset.d, +t.dataset.p);
      sheet(`<h3>${label(t.dataset.d, +t.dataset.p)}　${PT(bs[0].lessonType).label}（${bs.length}人）</h3><p style="font-size:13px;color:var(--muted);margin-top:0">名前を押すと、実施・欠席のチェックができます。</p>
        <div class="list">${bs.map(x => { const s = ST(x.token); return `<button class="item" style="width:100%;text-align:left;font:inherit;color:inherit;background:none" data-act="pastCheck" data-id="${x.id}"><div><div class="t">${esc(nm(s) || "?")}</div><div class="s">${x.result === "done" ? "実施" : x.result === "absent" ? "欠席" : "チェック前"}</div></div></button>`; }).join("")}</div>
        <div class="list" style="margin-top:10px"><button class="btn full" data-act="close">閉じる</button></div>`);
    }
    else if (a === "bookedMulti") {
      const ds = t.dataset.d, p = +t.dataset.p, bs = bookingsAt(ds, p);
      sheet(`<h3>${label(ds, p)}　${bs.some(b => b.subUid) || !bs[0].lessonType ? "この時限の予約" : PT(bs[0].lessonType).label}（${bs.length}人）</h3><p style="font-size:13px;color:var(--muted);margin-top:0">名前を押すと、その教習生の予約の詳細（取り消し・変更）を開きます。</p>
        <div class="list">${bs.map(x => { const s = ST(x.token); return `<button class="item" style="width:100%;text-align:left;font:inherit;color:inherit;background:none" data-act="booked" data-id="${x.id}"><div><div class="t">${esc(nm(s) || "?")}</div><div class="s">${x.status === "draft" ? "未確定" : acked(x) ? "確認済" : "通知済み"}</div></div></button>`; }).join("")}</div>
        <div class="list" style="margin-top:10px">${joinBtn(bs[0])}<button class="btn full" data-act="close">閉じる</button></div>`);
    }
    else if (a === "groupJoin") { slotSheet(t.dataset.d, +t.dataset.p, t.dataset.t, +t.dataset.p); }
    else if (a === "unbook") { closeSheet(); const b = S.bookings.find(x => x.id === t.dataset.id); await removeBooking(b, "remove"); render(); toast("取り消しました"); }
    else if (a === "swap") { closeSheet(); const b = S.bookings.find(x => x.id === t.dataset.id); await removeBooking(b, "remove"); render(); slotSheet(b.date, b.period, b.lessonType || "normal"); }
    else if (a === "offWk") { S.offWeek = addDays(S.offWeek, +t.dataset.v); await renderOff(); }
    else if (a === "offCell" || a === "offDay") {
      // 確認なしで、押すたびに✕を付ける／外す（依頼者指定）。「全部」は、全部✕ならすべて外し、そうでなければすべて✕
      const ds = t.dataset.d, ym = ds.slice(0, 7), set = S.off[ym], d = parseDate(ds).getDate();
      if (ds < dateStr(today())) return;
      if (a === "offCell") { const k = slotKey(d, +t.dataset.p); set.has(k) ? set.delete(k) : set.add(k); }
      else { const ks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p => slotKey(d, p)), all = ks.every(k => set.has(k)); ks.forEach(k => all ? set.delete(k) : set.add(k)); }
      const wrap = document.querySelector("#off .gridwrap"), sl = wrap ? wrap.scrollLeft : 0;
      await renderOff(); saveOff(ym);
      const w2 = document.querySelector("#off .gridwrap"); if (w2) w2.scrollLeft = sl;
    }
    else if (a === "offToAssign") {
      // この週の予約の管理を開いて、未確定なら自動で割り振る
      S.week = S.offWeek; showView("assign"); await loadWeek();
      if (!S.confirmed && confirm("この週の空いている枠に、ルールどおり自動で予約を入れます（未確定で入ります。確定するまで教習生には通知されません）。よろしいですか？")) await autoAssign();
    }
    else if (a === "kenteiPass") {
      const st = ST(t.dataset.s), mk = st[`mikiwame${st.stage}`];
      sheet(st.stage === 1 ? `<h3>修了検定 合格</h3><p>${esc(nm(st))}（検定日 ${md(mk.kenteiDate)}）</p>
        <div class="field"><label for="kp_date">仮免交付日</label><input id="kp_date" type="date" value="${esc(mk.kenteiDate)}"></div>
        <p style="font-size:13px;color:var(--muted)">第2段階に進みます。時限数は0から数え直し、仮免期限日は交付日から自動で入ります。</p>
        <div class="list"><button class="btn accent full" data-act="kpOk" data-s="${st.token}">OK</button><button class="btn full" data-act="close">やめる</button></div>`
        : `<h3>卒業検定 合格</h3><p>${esc(nm(st))}（検定日 ${md(mk.kenteiDate)}）</p>
        <p style="font-size:13px;color:var(--muted)">卒業として記録し、担当の教習生の一覧から外します（「教習生の管理」には「卒業」で残ります）。</p>
        <div class="list"><button class="btn accent full" data-act="kpOk" data-s="${st.token}">OK</button><button class="btn full" data-act="close">やめる</button></div>`);
    }
    else if (a === "kpOk") {
      const st = ST(t.dataset.s), key = `mikiwame${st.stage}`, mk = st[key];
      let upd;
      if (st.stage === 1) {
        const d = document.getElementById("kp_date").value;
        if (!d) return toast("仮免交付日を入れてください");
        upd = { stage: 2, priorDone: 0, doneCount: 0, kikenDone: false, hwDone: false, karimenIssued: d, karimenExpiry: karimenExpiryOf(d), [key]: { ...mk, kenteiResult: "pass" } };
      } else upd = { active: false, graduatedOn: mk.kenteiDate, [key]: { ...mk, kenteiResult: "pass" } };
      t.disabled = true;
      await updateDoc(doc(db, "students", st.token), upd);
      // 検定日以降に入っている（まだチェックしていない）予約：修了検定の合格なら第2段階の1時限目からに付け替える。
      // 卒業検定の合格なら取り消す（卒業なので教習生への通知はしない）（依頼者指定）
      let moved = 0;
      if (mk.kenteiDate) {
        const bs = (await getDocs(collection(db, "students", st.token, "bookings"))).docs.filter(x => { const b = x.data(); return b.date >= mk.kenteiDate && b.status !== "cancelled" && !b.result && b.instructorUid === S.uid; });
        const batch = writeBatch(db);
        bs.forEach(x => st.stage === 1 ? batch.update(x.ref, { stage: 2, updatedAt: serverTimestamp() })
          : x.data().status === "draft" ? batch.delete(x.ref) : batch.update(x.ref, { status: "cancelled", cancelRequested: false, updatedAt: serverTimestamp() }));
        if (bs.length) await batch.commit();
        const ids = new Set(bs.map(x => x.id)); moved = ids.size;
        if (st.stage === 1) [...S.bookings, ...S.pending].forEach(b => { if (ids.has(b.id)) b.stage = 2; });
        else { S.bookings = S.bookings.filter(b => !ids.has(b.id)); S.pending = S.pending.filter(b => !ids.has(b.id)); }
      }
      Object.assign(st, upd);
      if (st.active === false) S.students = S.students.filter(x => x.token !== st.token);
      closeSheet(); render(); toast(st.active === false ? `${nm(st)}の卒業を記録しました${moved ? `（検定日以降の予約${moved}件を取り消しました）` : ""}` : `${nm(st)}は第2段階に進みました${moved ? `（検定日以降の予約${moved}件は第2段階の1時限目からになります）` : ""}`);
    }
    else if (a === "kenteiFail") {
      const st = ST(t.dataset.s), mk = st[`mikiwame${st.stage}`];
      sheet(`<h3>${KN(st)} 不合格</h3><p>${esc(nm(st))}（検定日 ${md(mk.kenteiDate)}）</p>
        <div class="field"><label for="kf_date">次の検定日</label><input id="kf_date" type="date"${ageAttr(st)}><div class="agewarn"></div></div>
        <label class="radio" style="margin:-4px 0 12px"><input type="checkbox" id="kf_und"> 次の検定日は未確定</label>
        <div class="list"><button class="btn accent full" data-act="kfOk" data-s="${st.token}">OK</button><button class="btn full" data-act="close">やめる</button></div>`);
    }
    else if (a === "kfOk") {
      const st = ST(t.dataset.s), key = `mikiwame${st.stage}`, mk = st[key];
      const d = document.getElementById("kf_date").value, und = document.getElementById("kf_und").checked;
      if (!d && !und) return toast("次の検定日を入れるか、「未確定」にチェックしてください");
      if (d && d <= mk.kenteiDate) return toast("次の検定日は、今回の検定日より後の日にしてください");
      if (!und && !ageOk(document.getElementById("kf_date"))) return;
      const upd = { [key]: { ...mk, kenteiDate: und ? null : d, kenteiUndecided: und, kenteiFails: [...(mk.kenteiFails || []), mk.kenteiDate] } };
      t.disabled = true;
      await updateDoc(doc(db, "students", st.token), upd);
      Object.assign(st, upd); closeSheet(); render(); toast(`${nm(st)}の${KN(st)}を不合格として記録しました`);
    }
    else if (a === "autoAssign") { if (confirm("この週の空いている枠に、ルールどおり自動で予約を入れます（未確定で入ります。確定するまで教習生には通知されません）。よろしいですか？")) await autoAssign(); }
    else if (a === "confirm") { t.disabled = true; await confirmWeek(); }
    else if (a === "markDone" || a === "markAbsent") {
      const ids = t.dataset.ids.split(",");
      if (a === "markAbsent" && !confirm("欠席として記録し、教習生に通知します。よろしいですか？")) return;
      if (a === "markDone") {
        const s = ST(S.pending.find(b => b.id === ids[0])?.token), it = s && planOf(s).items.find(x => x.bookings.some(b => b.id === ids[0]));
        // 欠席などで危険予測・高速教習の順番がずれたままなら、実施にする前に警告する（依頼者指定）
        const ng = s && it && orderNg(s, it);
        if (ng && !confirm(`${nm(s)}の教習の順番がずれています。\n${ng}\n\nこのまま実施にしますか？`)) return;
        if (it && isMikiwame(s, it)) return mikiwameSheet(s, it, ids);
      }
      t.disabled = true; closeSheet(); await markResult(ids, a === "markDone" ? "done" : "absent");
    }
    else if (a === "mkOk") {
      const val = n => (document.querySelector(`input[name="${n}"]:checked`) || {}).value;
      const pass = val("mk_pass"), gakka = val("mk_gakka");
      const date = document.getElementById("mk_date").value, und = document.getElementById("mk_und").checked;
      if (!pass) return toast("みきわめの結果を選んでください");
      if (pass === "1" && !date && !und) return toast("検定日を入れるか、「未確定」にチェックしてください");
      if (!gakka) return toast("学科及び効果測定が終わっているか選んでください");
      if (pass === "1" && !und && !ageOk(document.getElementById("mk_date"))) return;
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
      const group = await pairGroup(b), ids = group.map(x => x.id);
      for (const x of group) await updateDoc(doc(db, "students", x.token, "bookings", x.id), { cancelRequested: false, updatedAt: serverTimestamp() });
      await notifyStudent(b.token, "cancelRejected", "キャンセル希望についてのお知らせ", `${md(b.date)} ${group.map(x => x.period).join("・")}限 は予約のままです。詳しくは学園までお問い合わせください。`);
      S.cancelReqs = S.cancelReqs.filter(x => !ids.includes(x.id));
      S.bookings.forEach(x => { if (ids.includes(x.id)) x.cancelRequested = false; });
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
const ageHint = el => { const w = el.parentElement.querySelector(".agewarn"), ng = kentei1AgeNg(el.dataset.birth, el.value); if (w) w.innerHTML = ng ? `<p style="color:var(--lv3);font-size:13px;font-weight:700;margin:6px 0 0">⚠ ${esc(ng)}</p>` : ""; if (ng) toast(ng); };
// みきわめのフォーム：合格の時だけ検定日を出す。「未確定」なら日付は入れない
document.addEventListener("change", e => {
  if (e.target.name === "mk_pass") document.getElementById("mk_kentei").hidden = e.target.value !== "1";
  if (e.target.dataset && e.target.dataset.birth) ageHint(e.target);
  if (e.target.id === "gk_chk") document.getElementById("gk_ok").disabled = !e.target.checked;
  if (e.target.id === "kf_und") { const d = document.getElementById("kf_date"); d.disabled = e.target.checked; if (e.target.checked) d.value = ""; }
  if (e.target.id === "mk_und") { const d = document.getElementById("mk_date"); d.disabled = e.target.checked; if (e.target.checked) d.value = ""; }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pw") document.querySelector('[data-act="login"]').click(); });
// 手元の確認用（デモの時だけ）：ルール判定を外から呼べるようにする
if (DEMO) self.__t = { S, evaluate, evaluatePair, specialTypes, assign, assignPair, removeBooking, days, render, loadWeek, confirmWeek, markResult, planOf, pendingOf, weekCount, autoAssign };
