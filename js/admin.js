// 管理画面の本体。2つのページで使う（body の data-mode で切り替え）
// ・admin.html（data-mode="admin"）：大元の管理画面。管理者だけがログインする。指導員の登録・削除と指導員用QR、
//   全員の教習生（登録・編集・削除・担当の付け替え・QR）、設定
// ・instructor.html（data-mode="staff"）：指導員の画面に組み込んだ「教習生の管理」（#mng の中に描く）。
//   ログインは指導員の画面のものをそのまま使い、ここではログインしない。自分の担当の教習生の登録・編集・削除・QR
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "./backend.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, serverTimestamp, writeBatch
} from "./backend.js";
import { CFG, app as fbApp, db, esc, toast, sheet, closeSheet, onOverlayClose, friendlyError, lessonMin, doneOf, mikiwameOf, kenteiText, ageText, karimenExpiryOf, expiriesOf, expiryText, toKatakana, toHalfDigits, isKatakana, parseDate, today, isPC, viewToggle, onViewChange, applyView, lookSettingsHtml, pcTable, nextSort, WD, DEMO } from "./common.js";

const auth = getAuth(fbApp);
self.__boot && self.__boot.push("admin");
const MODE = document.body.dataset.mode === "staff" ? "staff" : "admin";
const root = document.getElementById(MODE === "staff" ? "mng" : "app");
const shown = () => MODE === "admin" || !document.getElementById("mngWrap").hidden;
const S = { uid: null, me: null, isAdmin: false, isInst: false, tab: "students", instructors: [], students: [], sel: new Set(), filter: "", msort: "no1", sort: { k: "studentNo", dir: 1 } };

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const studentUrl = tok => `${CFG.appUrl}student.html?t=${encodeURIComponent(tok)}`;
const instructorUrl = i => `${CFG.appUrl}instructor.html${i.email ? `?e=${encodeURIComponent(i.email)}` : ""}`;
const iname = uid => (S.instructors.find(i => i.uid === uid) || {}).name || "（未設定）";
const tabs = () => S.isAdmin ? [["students", `教習生（${S.students.length}人）`], ["instructors", `指導員（${S.instructors.length}人）`], ["access", "アクセス記録"], ["settings", "設定"]] : [["students", `担当の教習生（${S.students.length}人）`]];

// 教習生の管理（指導員）はここでログインしない。指導員の画面へ案内する
function gate(msg) { root.innerHTML = `<section class="panel"><div class="body"><div class="banner warn">${esc(msg)}</div></div></section>`; }
function renderLogin(msg = "") {
  root.innerHTML = `<section class="panel"><div class="phead"><div><h2>管理者ログイン</h2><small>${esc(CFG.schoolName)}</small></div></div>
  <div class="body"><form onsubmit="return false"><div class="field"><label for="em">メールアドレス</label><input id="em" type="email" autocomplete="username"></div>
  <div class="field"><label for="pw">パスワード</label><input id="pw" type="password" autocomplete="current-password"></div>
  ${msg ? `<div class="banner warn">${esc(msg)}</div>` : ""}<button class="btn primary full" data-act="login">ログイン</button></form></div></section>`;
}
// PC表示かどうかは指導員の画面全体で決める（教習生の管理が見えている時だけ描き直す）
onViewChange(() => { if (shown()) render(); });
document.addEventListener("pref:change", () => { if (shown()) render(); });
// 指導員の画面で「教習生の管理」を開いた時に、最新の内容で描き直す
document.addEventListener("mng:open", () => { applyView(); if (S.uid) loadAll(); });
let loginMsg = "";   // ログアウトさせた理由（ログアウト時の描き直しで消えないように取っておく）
onAuthStateChanged(auth, async user => {
  self.__boot && self.__boot.push("admin:ログイン確認");
  if (!user) { S.uid = null; MODE === "staff" ? gate("ログインしてください。") : renderLogin(loginMsg); loginMsg = ""; return; }
  S.uid = user.uid; S.tab = "students"; S.sel = new Set(); S.filter = "";
  try {
    const [ad, me] = await Promise.all([getDoc(doc(db, "admins", user.uid)), getDoc(doc(db, "instructors", user.uid))]);
    S.me = me.exists() ? me.data() : null;
    // 大元の管理画面は管理者だけ、教習生の管理は指導員だけ（ページごとに役割を1つに決める）
    S.isAdmin = MODE === "admin" && ad.exists(); S.isInst = MODE === "staff" && me.exists();
    if (MODE === "admin" && !S.isAdmin) { S.uid = null; loginMsg = `この画面は管理者専用です。（このアカウントのユーザーUID：${user.uid}。管理者にするには、Firestore の admins に、このUIDと同じ名前のドキュメントを作ります）`; await signOut(auth); return; }
    if (MODE === "staff" && !S.isInst) { S.uid = null; gate("指導員として登録されていません。事務所に確認してください。"); return; }
    await loadAll();
  } catch (e) {
    if (MODE === "staff") return gate(friendlyError(e));
    // ログインはできているので、ログイン画面には戻さず、理由とやり直しのボタンを出す
    root.innerHTML = `<section class="panel"><div class="body"><div class="banner warn">${esc(friendlyError(e))}</div>
      <div class="list"><button class="btn primary full" data-act="retry">もう一度読み込む</button><button class="btn full" data-act="logout">ログアウト</button></div></div></section>`;
  }
});

async function loadAll() {
  S.instructors = S.isAdmin ? (await getDocs(collection(db, "instructors"))).docs.map(d => ({ uid: d.id, ...d.data() })) : [{ uid: S.uid, ...S.me }];
  const sq = S.isAdmin ? collection(db, "students") : query(collection(db, "students"), where("instructorUid", "==", S.uid));
  S.students = (await getDocs(sq)).docs.map(d => ({ token: d.id, ...d.data() }))
    .sort((a, b) => String(a.studentNo || "").localeCompare(String(b.studentNo || "")));
  render();
}

function render() {
  if (!S.uid) return;
  if (isPC()) return renderPC();
  let h = `<div class="topbar noprint"><div><h1>${S.isAdmin ? "管理画面" : "教習生の管理"}</h1><small>${esc(who())}</small></div>
    <span>${S.isInst ? "" : `<button class="linkbtn" data-act="logout">ログアウト</button>`}</span></div>
  ${tabs().length < 2 ? "" : `<div class="seg noprint" role="group" style="grid-template-columns:repeat(${tabs().length},1fr)">${tabs().map(([v, t]) => `<button aria-pressed="${S.tab === v}" data-act="tab" data-v="${v}">${t}</button>`).join("")}</div>`}`;
  h += S.tab === "instructors" ? renderInstructors() : S.tab === "settings" ? renderSettings() : S.tab === "access" ? renderAccess() : renderStudents();
  root.innerHTML = h + (S.isAdmin ? `<p class="center noprint">${viewToggle()}</p>` : "");
}
const who = () => S.isAdmin ? `${CFG.schoolName}・管理者` : `${S.me ? S.me.name : ""} 指導員の担当（${S.students.length}人）`;
const match = (s, f) => !f || String(s.name).includes(f) || String(s.nameKana || "").includes(toKatakana(f)) || String(s.studentNo).includes(f) || String(s.license || "").includes(f) || (S.isAdmin && iname(s.instructorUid).includes(f));
const assignSelect = s => `<select data-act="reassign" data-s="${s.token}" aria-label="${esc(s.name)}の担当">${S.instructors.map(i => `<option value="${esc(i.uid)}" ${i.uid === s.instructorUid ? "selected" : ""}>${esc(i.name)}</option>`).join("")}${S.instructors.some(i => i.uid === s.instructorUid) ? "" : `<option value="" selected>（未設定）</option>`}</select>`;
const filtered = () => { const f = S.filter.trim(); return S.students.filter(s => match(s, f)); };
// 並べ替え。日付は「今日からの近さ」で比べる（近い順＝今日に近いものから）。空のものはいつも最後
const kenteiOf = s => { const m = mikiwameOf(s); return m && m.passed ? m.kenteiDate || null : null; };
const distOf = d => d ? Math.abs(parseDate(d) - today()) : null;
const SORTS = [
  ["no1", "教習生番号（小さい順）", s => s.studentNo || null, 1], ["no-1", "教習生番号（大きい順）", s => s.studentNo || null, -1],
  ["kana1", "名前（アイウエオ順）", s => s.nameKana || s.name || null, 1], ["kana-1", "名前（逆順）", s => s.nameKana || s.name || null, -1],
  ["kentei1", "検定日が近い順", s => distOf(kenteiOf(s)), 1, true], ["kentei-1", "検定日が遠い順", s => distOf(kenteiOf(s)), -1, true],
  ["start1", "教習開始日が近い順", s => distOf(s.startDate), 1], ["start-1", "教習開始日が遠い順", s => distOf(s.startDate), -1]
];
const sortList = list => {
  const o = SORTS.find(x => x[0] === S.msort) || SORTS[0], [, , f, dir] = o, empty = v => v === null || v === undefined || v === "";
  return [...list].sort((a, b) => { const x = f(a), y = f(b); if (empty(x) || empty(y)) return empty(x) - empty(y); return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "ja")) * dir; });
};
// みきわめの状況（今の段階）。合格なら検定日（未確定もある）
const mkText = s => { const m = !S.isAdmin && mikiwameOf(s); return !m ? "" : !m.passed ? "みきわめ不合格" : `合格・検定 ${kenteiText(m)}${m.gakkaDone ? "" : "（学科・効果測定まだ）"}`; };
// 期限が近い・過ぎた日付は赤で出す
const dateCell = (s, k) => { const e = expiriesOf(s).find(x => x.key === k); return s[k] ? `<span style="${e ? "color:var(--lv3);font-weight:700" : ""}" title="${e ? esc(expiryText(e)) : ""}">${esc(s[k])}</span>` : ""; };
// PC表示：左にメニュー、右に全項目の表（見出しで並べ替え）。編集は右からパネルで開く
function renderPC() {
  const main = S.tab === "instructors" ? renderInstructorsPC() : S.tab === "access" ? `<h2>アクセス記録</h2><div style="max-width:760px">${renderAccess()}</div>` : S.tab === "settings" ? `<h2>設定</h2>${renderSettings().replace('<div class="list">', '<div class="list pcgrid">')}` : renderStudentsPC();
  // 指導員の画面では、左端のタブ（画面の切り替え）は指導員の画面のものを使う
  if (S.isInst) { root.innerHTML = `<main class="pcmain"><div class="noprint">${main}</div><div id="printArea"></div></main>`; return; }
  root.innerHTML = `<div class="pcl"><aside class="pcside noprint"><h1>${S.isAdmin ? "管理画面" : "教習生の管理"}</h1><small>${esc(who())}</small>
    <nav class="pcnav">${tabs().map(([v, t]) => `<button aria-pressed="${S.tab === v}" data-act="tab" data-v="${v}">${t}</button>`).join("")}${S.isInst ? `<button data-act="view" data-v="assign">予約の割り当てへ</button>` : ""}</nav>
    <div class="foot">${viewToggle()}${S.isAdmin ? `<button class="linkbtn" data-act="logout">ログアウト</button>` : ""}</div></aside>
  <main class="pcmain"><div class="noprint">${main}</div><div id="printArea"></div></main></div>`;
}
function renderStudentsPC() {
  const list = filtered();
  const cols = [
    { t: `<input type="checkbox" data-act="selPage" aria-label="表示中を全選択" ${list.length && list.every(s => S.sel.has(s.token)) ? "checked" : ""}>`, html: s => `<input type="checkbox" data-act="sel" data-s="${s.token}" ${S.sel.has(s.token) ? "checked" : ""} aria-label="選択">` },
    { k: "studentNo", t: "番号" }, { k: "nameKana", t: "名前", html: s => `${esc(s.name)}<br><small style="color:var(--muted)">${esc(s.nameKana || "")}</small>` },
    { k: "birthDate", t: "生年月日" }, { k: "age", t: "年齢", v: s => ageText(s.birthDate), sort: s => s.birthDate ? -new Date(s.birthDate) : 1 },
    { k: "stage", t: "段階", v: s => `第${s.stage}段階` }, { k: "license", t: "希望免許" }, { k: "heldLicense", t: "所持免許" },
    { k: "done", t: "進み具合", v: s => `${doneOf(s)}/${lessonMin(s.stage)}`, sort: s => doneOf(s) / (lessonMin(s.stage) || 1) },
    ...(S.isAdmin ? [] : [{ k: "kentei", t: "みきわめ・検定日", v: mkText, sort: s => distOf(kenteiOf(s)) }]),
    { k: "startDate", t: "教習開始", sort: s => distOf(s.startDate) }, { k: "classStart", t: "学科開始" }, { k: "skillStart", t: "技能開始" }, { k: "deadline", t: "教習期限", html: s => dateCell(s, "deadline") },
    { k: "karimenIssued", t: "仮免交付" }, { k: "karimenExpiry", t: "仮免期限", html: s => dateCell(s, "karimenExpiry") },
    { k: "active", t: "状態", html: s => s.active === false ? '<span class="tag wait">停止</span>' : '<span class="tag ok">利用中</span>', sort: s => s.active === false ? 1 : 0 },
    ...(S.isAdmin ? [{ k: "inst", t: "担当", html: assignSelect, sort: s => iname(s.instructorUid) }] : []),
    { t: "", html: s => `<button class="btn" data-act="edit" data-s="${s.token}">編集</button>` }
  ];
  return `<h2>${S.isAdmin ? "教習生（全員）" : "担当の教習生"}</h2>
    <div class="pctool"><button class="btn primary" data-act="new">＋ 教習生を追加</button><input id="flt" value="${esc(S.filter)}" placeholder="名前・番号・希望免許${S.isAdmin ? "・担当" : ""}で絞り込み" aria-label="絞り込み">
    <span class="sp"></span><span style="font-size:13px;color:var(--muted)">${list.length}人表示・${S.sel.size}人選択中</span><button class="btn" data-act="print" ${S.sel.size ? "" : "disabled"}>QRカードを印刷（${S.sel.size}人）</button></div>
    ${list.length ? pcTable(cols, list, S.sort) : '<div class="loading">教習生がいません</div>'}`;
}

function renderStudents() {
  const f = S.filter.trim();
  const list = sortList(S.students.filter(s => match(s, f)));
  let h = `<section class="panel noprint"><div class="body">
  <div class="tools" style="grid-template-columns:1fr 1fr 1fr"><button class="btn primary" data-act="new">教習生を追加</button><button class="btn" data-act="print" ${S.sel.size ? "" : "disabled"}>QRカードを印刷（${S.sel.size}人）</button><button class="btn" data-act="selAll">表示中を全選択</button></div>
  <div class="row" style="margin-top:10px"><div class="field"><label for="flt">絞り込み（名前・番号${S.isAdmin ? "・担当" : ""}）</label><input id="flt" value="${esc(S.filter)}"></div>
  <div class="field"><label for="msort">並べ替え</label><select id="msort">${SORTS.filter(x => !(x[4] && S.isAdmin)).map(([k, t]) => `<option value="${k}" ${S.msort === k ? "selected" : ""}>${t}</option>`).join("")}</select></div></div>
  <div class="gridwrap"><table class="adm"><thead><tr><th></th><th>番号</th><th>名前</th><th>段階</th><th>希望免許</th><th>進み具合</th><th>教習期限</th><th>仮免期限</th><th>状態</th>${S.isAdmin ? "<th>担当</th>" : ""}<th></th></tr></thead><tbody>`;
  list.forEach(s => {
    h += `<tr><td><input type="checkbox" data-act="sel" data-s="${s.token}" ${S.sel.has(s.token) ? "checked" : ""} aria-label="選択"></td><td>${esc(s.studentNo)}</td><td>${esc(s.name)}<br><small style="color:var(--muted)">${esc(s.nameKana || "")}</small></td><td>${s.stage}</td><td>${esc(s.license || "")}</td><td>${doneOf(s)}/${lessonMin(s.stage)}${mkText(s) ? `<br><small style="color:var(--muted)">${esc(mkText(s))}</small>` : ""}</td><td>${dateCell(s, "deadline")}</td><td>${dateCell(s, "karimenExpiry")}</td><td>${s.active === false ? '<span class="tag wait">停止</span>' : '<span class="tag ok">利用中</span>'}</td>${S.isAdmin ? `<td>${assignSelect(s)}</td>` : ""}<td><button class="btn" data-act="edit" data-s="${s.token}">編集</button></td></tr>`;
  });
  h += `</tbody></table></div>${list.length ? "" : '<div class="loading">教習生がいません</div>'}</div></section>`;
  h += `<div id="printArea"></div>`;
  return h;
}

// ---------- 設定・指導員（指導員タブは管理者だけ） ----------
function renderSettings() {
  const fmt = k => `${+k.slice(0, 2)}月${+k.slice(3)}日`, dk = CFG.darkSeason || {};
  const rows = [
    ["学園名", CFG.schoolName], ["学園の電話番号", CFG.schoolTel], ["公開URL", CFG.appUrl],
    ["入力の締切", `毎月${CFG.deadlineDay}日（次月分。教習生ごとに編集画面で変えられます）。締切後は◯を外せない`],
    ["予約を入れる曜日", CFG.openDays.map(d => "日月火水木金土"[d]).join("・")],
    ["1日の上限", Object.entries(CFG.dailyMax).map(([k, v]) => `第${k}段階 ${v}時限`).join("、")],
    ["最低教習時限", Object.entries(CFG.lessons || {}).map(([k, v]) => `第${k}段階 ${v.min}時限${v.kikenNo ? `（${v.kikenNo}時限目が${(CFG.kiken || {}).label}）` : ""}`).join("、")],
    ["高速教習の組", (CFG.highwaySets || []).map(x => x.join("・")).join("／")],
    ["日没が早い期間", dk.from ? `${fmt(dk.from)}〜${fmt(dk.to)}（警告：高速 ${(dk.sets || []).map(x => x.join("・")).join("／")}、単独高速 ${(dk.hwSoloSets || []).map(x => x.join("・")).join("／")}／不可：単独高速 ${(dk.hwSoloNo || []).map(x => x.join("・")).join("／")}）` : "なし"],
    ["時限", CFG.periods.slice(1).map((p, i) => `${i + 1}限 ${p[0]}〜${p[1]}`).join("、")]
  ];
  return `<section class="panel"><div class="body setpage"><h3 style="margin-top:0">この端末の表示</h3>${lookSettingsHtml()}</div></section>
  <section class="panel"><div class="body"><h3 style="margin-top:0">学園のルール</h3><div class="banner info">いまの設定です。変更したい時は、設定ファイル（js/config.js）を書き換えます。</div>
  <div class="list">${rows.map(([k, v]) => `<div class="item" style="display:block"><div class="s">${esc(k)}</div><div class="t">${esc(v)}</div></div>`).join("")}</div></div></section>`;
}

/* ---------- アクセス記録（管理者だけ） ---------- */
// 教習生・指導員がアプリを開いた記録（access コレクション）。古い分は Apps Script が毎朝消す（ACCESS_KEEP_DAYS、省略時90日）
const dt = ts => { if (!ts || !ts.toDate) return ""; const d = ts.toDate(), p2 = n => String(n).padStart(2, "0"); return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]}) ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const ms = ts => ts && ts.toMillis ? ts.toMillis() : 0;
const accName = (k, w) => { const x = k === "student" ? S.students.find(s => s.token === w) : S.instructors.find(i => i.uid === w); return x ? x.name : "（削除済み）"; };
async function loadRecent() {
  S.accRecent = null; render();
  try { S.accRecent = (await getDocs(query(collection(db, "access"), orderBy("at", "desc"), limit(100)))).docs.map(d => d.data()); }
  catch (e) { S.accRecent = []; toast(friendlyError(e)); }
  if (S.tab === "access") render();
}
function renderAccess() {
  const k = S.accKind || "student";
  const people = (k === "student" ? S.students.map(s => ({ w: s.token, name: s.name, sub: s.studentNo ? `教習生番号 ${s.studentNo}` : "", at: s.lastAccessAt }))
    : S.instructors.map(i => ({ w: i.uid, name: i.name, sub: i.email || "", at: i.lastAccessAt }))).sort((a, b) => ms(b.at) - ms(a.at));
  const never = people.filter(x => !x.at).length;
  let h = `<section class="panel noprint"><div class="body">
  <div class="seg" role="group" aria-label="対象"><button aria-pressed="${k === "student"}" data-act="accKind" data-v="student">教習生</button><button aria-pressed="${k === "instructor"}" data-act="accKind" data-v="instructor">指導員</button></div>
  <p style="font-size:12px;color:var(--muted);margin:0 0 8px">アプリを開いた日時の記録です（開いた時と、10分以上たって戻ってきた時に1件）。記録は${CFG.accessKeepDays || 90}日分残し、それより古いものは毎朝自動で消します。名前を押すと、その人の記録をすべて見られます。</p>
  <h3>最後に開いた日時（${people.length}人${never ? `・まだ開いていない人 ${never}人` : ""}）</h3><div class="list">`;
  people.forEach(x => { h += `<button class="item" style="width:100%;text-align:left;font:inherit;color:inherit;background:none" data-act="accHist" data-k="${k}" data-w="${esc(x.w)}"><div><div class="t">${esc(x.name)}</div><div class="s">${esc(x.sub)}</div></div><span class="${x.at ? "" : "tag wait"}" style="font-size:13px;white-space:nowrap">${x.at ? dt(x.at) : "まだ開いていません"}</span></button>`; });
  h += `</div><h3>最近のアクセス（全員・新しい順）<button class="linkbtn" data-act="accReload" style="margin-left:8px;font-size:13px">更新</button></h3>`;
  if (!S.accRecent) h += `<div class="hist"><div>読み込み中…</div></div>`;
  else {
    const list = S.accRecent.filter(r => r.kind === k);
    h += list.length ? `<div class="hist">${list.map(r => `<div>${dt(r.at)}　${esc(accName(r.kind, r.who))}<span style="color:var(--muted);font-size:12px">　${esc(r.device || "")}</span></div>`).join("")}</div>` : `<div class="hist"><div>まだ記録がありません。</div></div>`;
  }
  return h + `</div></section>`;
}
async function accessHistory(k, w) {
  sheet(`<h3>${esc(accName(k, w))} さんのアクセス記録</h3><div class="hist"><div>読み込み中…</div></div>`);
  try {
    const list = (await getDocs(query(collection(db, "access"), where("who", "==", w)))).docs.map(d => d.data()).sort((a, b) => ms(b.at) - ms(a.at));
    const d30 = Date.now() - 30 * 86400000, n30 = list.filter(r => ms(r.at) >= d30).length;
    sheet(`<h3>${esc(accName(k, w))} さんのアクセス記録</h3>
      <p style="font-size:13px;color:var(--muted);margin-top:0">全${list.length}件（${CFG.accessKeepDays || 90}日分まで）・最近30日で${n30}回</p>
      ${list.length ? `<div class="hist" style="max-height:55vh;overflow:auto">${list.map(r => `<div>${dt(r.at)}<span style="color:var(--muted);font-size:12px">　${esc(r.device || "")}</span></div>`).join("")}</div>` : `<div class="hist"><div>まだ記録がありません。</div></div>`}
      <button class="btn full" style="margin-top:10px" data-act="close">閉じる</button>`);
  } catch (e) { closeSheet(); toast(friendlyError(e)); }
}

function renderInstructors() {
  let h = `<section class="panel noprint"><div class="body">
  <div class="banner info">指導員のログイン用アカウントは、Firebaseコンソールの Authentication →「ユーザーを追加」で作り、表示された「ユーザーUID」をここに登録します。</div>
  <div class="list">`;
  S.instructors.forEach(i => { h += `<div class="item"><div><div class="t">${esc(i.name)}</div><div class="s">${esc(i.email || "")}　UID: ${esc(i.uid)}</div><div class="s">${S.students.filter(s => s.instructorUid === i.uid).length}人担当</div></div><button class="btn" data-act="delInst" data-u="${esc(i.uid)}" style="color:var(--orange)">削除</button></div>`; });
  h += `</div><h3>指導員を登録</h3>
  <div class="field"><label for="iu">ユーザーUID</label><input id="iu"></div>
  <div class="row"><div class="field"><label for="in">名前</label><input id="in"></div><div class="field"><label for="ie">メールアドレス</label><input id="ie" type="email"></div></div>
  <button class="btn primary full" data-act="addInst">登録する</button>
  <h3>指導員用のQRカード</h3><p style="font-size:13px;color:var(--muted);margin-top:0">読み取ると指導員の画面（ログイン画面）が開きます。メールアドレスは入力済みの状態で開きます。</p>
  <button class="btn full" data-act="printInst" ${S.instructors.length ? "" : "disabled"}>指導員用のQRカードを印刷（${S.instructors.length}人）</button></div></section>`;
  h += `<div id="printArea"></div>`;
  return h;
}

function renderInstructorsPC() {
    const cols = [
      { k: "name", t: "名前" }, { k: "email", t: "メールアドレス" }, { k: "uid", t: "ユーザーUID" },
      { k: "count", t: "担当", v: i => `${S.students.filter(s => s.instructorUid === i.uid).length}人`, sort: i => S.students.filter(s => s.instructorUid === i.uid).length },
      { t: "", html: i => `<button class="btn" data-act="delInst" data-u="${esc(i.uid)}" style="color:var(--orange)">削除</button>` }
    ];
  return `<h2>指導員</h2><div style="display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start">
      <div>${pcTable(cols, S.instructors, S.sort)}
        <div class="pctool" style="margin-top:12px"><button class="btn" data-act="printInst" ${S.instructors.length ? "" : "disabled"}>指導員用のQRカードを印刷（${S.instructors.length}人）</button></div></div>
      <section class="panel" style="margin-top:0"><div class="body"><h3 style="margin-top:0">指導員を登録</h3>
        <p style="font-size:12px;color:var(--muted);margin-top:0">ログイン用アカウントは、Firebaseコンソールの Authentication →「ユーザーを追加」で作り、表示された「ユーザーUID」をここに登録します。</p>
        <div class="field"><label for="iu">ユーザーUID</label><input id="iu"></div><div class="field"><label for="in">名前</label><input id="in"></div><div class="field"><label for="ie">メールアドレス</label><input id="ie" type="email"></div>
        <button class="btn primary full" data-act="addInst">登録する</button></div></section></div>`;
}

function printInstructorCards() {
  const area = document.getElementById("printArea");
  area.innerHTML = `<div class="noprint banner info" style="margin-top:12px">カードを確認して、印刷画面から印刷してください。<button class="btn" data-act="doPrint" style="margin-left:8px">印刷する</button></div>
  <div class="qrcards">${S.instructors.map(i => `
  <div style="border:1.5px dashed #9AA3AE;border-radius:10px;padding:12px;display:flex;gap:12px;align-items:center;break-inside:avoid;background:#fff;color:#1F2A37">
    <div class="qr" data-url="${esc(instructorUrl(i))}" style="width:120px;height:120px;flex-shrink:0"></div>
    <div style="font-size:12px;line-height:1.5"><b style="font-size:14px">${esc(i.name)} 指導員</b><br>予約の割り当てはこちら<br>① スマホのカメラで読み取る<br>② ホーム画面に追加<br>③ ログインして「通知」をオン<br><span style="color:#4B5563">${esc(CFG.schoolName)}</span></div>
  </div>`).join("")}</div>`;
  area.querySelectorAll(".qr").forEach(el => new QRCode(el, { text: el.dataset.url, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M }));
  area.scrollIntoView({ behavior: "smooth" });
}

// 登録・編集フォーム。日付はすべて YYYY-MM-DD。年齢は登録時点の「○歳○ヶ月」
const DATES = [["startDate", "教習開始日"], ["classStart", "学科開始日"], ["deadline", "教習期限日"], ["skillStart", "技能開始日"], ["karimenIssued", "仮免交付日"], ["karimenExpiry", "仮免期限日"]];
// みきわめに合格している時だけ、検定日・学科及び効果測定を直せる（あとから検定日が決まった時など）
function mkFields(s) {
  const m = !S.isAdmin && s.token && mikiwameOf(s);
  if (!m) return "";
  if (!m.passed) return `<p style="font-size:13px;margin:0 0 10px">みきわめ（第${s.stage}段階）：<b>不合格</b>（${esc(m.date || "")}）。次の教習の「実施」で、もう一度みきわめを記録します。</p>`;
  return `<div class="row"><div class="field"><label for="f_kentei">検定日（みきわめ合格 ${esc(m.date || "")}）</label><input id="f_kentei" type="date" value="${esc(m.kenteiDate || "")}"></div>
  <div class="field"><label for="f_gakka">学科及び効果測定</label><select id="f_gakka"><option value="1" ${m.gakkaDone ? "selected" : ""}>終わっている</option><option value="0" ${m.gakkaDone ? "" : "selected"}>終わっていない</option></select></div></div>
  <p style="font-size:12px;color:var(--muted);margin:-4px 0 10px">検定日を空にすると「未確定」になります。</p>`;
}
function editSheet(s) {
  const isNew = !s; s = s || { studentNo: "", name: "", stage: 1, active: true };
  const opt = (v, cur, t = v) => `<option value="${esc(v)}" ${String(cur ?? "") === String(v) ? "selected" : ""}>${esc(t)}</option>`;
  sheet(`<h3>${isNew ? "教習生を追加" : "教習生を編集"}</h3>
  <datalist id="dl_lic">${(CFG.licenseTypes || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist>
  <datalist id="dl_held">${(CFG.heldLicenseTypes || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist>
  <div class="row"><div class="field"><label for="f_nm">名前（漢字）<span style="color:var(--lv3)">＊必須</span></label><input id="f_nm" value="${esc(s.name)}" autocomplete="off" placeholder="例：山田 太郎"></div>
  <div class="field"><label for="f_kana">フリガナ<span style="color:var(--lv3)">＊必須</span></label><input id="f_kana" value="${esc(s.nameKana || "")}" autocomplete="off" placeholder="例：ヤマダ タロウ"></div></div>
  <div class="row"><div class="field"><label for="f_no">教習生番号</label><input id="f_no" value="${esc(s.studentNo)}" autocomplete="off" inputmode="numeric" maxlength="4" placeholder="数字4桁（例：0123）"></div>
  ${S.isAdmin ? `<div class="field"><label for="f_in">担当指導員<span style="color:var(--lv3)">＊必須</span></label><select id="f_in">${opt("", s.instructorUid || (S.isInst ? S.uid : ""), "選んでください")}${S.instructors.map(i => opt(i.uid, s.instructorUid || (S.isInst ? S.uid : ""), i.name)).join("")}</select></div>` : "<div></div>"}</div>
  <div class="row"><div class="field"><label for="f_birth">生年月日</label><input id="f_birth" type="date" value="${esc(s.birthDate || "")}"><span id="f_age" style="font-size:12px;color:var(--muted)">${s.birthDate ? `今日時点で ${ageText(s.birthDate)}` : ""}</span></div>
  <div></div></div>
  <div class="row"><div class="field"><label for="f_lic">希望免許</label><input id="f_lic" list="dl_lic" value="${esc(s.license || "")}" autocomplete="off"></div>
  <div class="field"><label for="f_held">所持免許</label><input id="f_held" list="dl_held" value="${esc(s.heldLicense || "")}" autocomplete="off"></div></div>
  <div class="row">${DATES.map(([k, t]) => `<div class="field"><label for="f_${k}">${t}${k === "karimenExpiry" ? `<span style="font-weight:400;color:var(--muted);font-size:11px">（交付日から自動）</span>` : ""}</label><input id="f_${k}" type="date" value="${esc(s[k] || "")}"></div>`).join("")}</div>
  <h3 style="margin-top:6px">教習の状況</h3>
  <p style="font-size:12px;color:var(--muted);margin:0 0 8px">転校などで途中から始める人は、段階と「これまでに受けた時限数」を入れてください。</p>
  <div class="row"><div class="field"><label for="f_st">段階</label><select id="f_st">${opt(1, s.stage, "第1段階")}${opt(2, s.stage, "第2段階")}</select></div>
  <div class="field"><label for="f_ac">状態</label><select id="f_ac">${opt(1, s.active === false ? 0 : 1, "利用中")}${opt(0, s.active === false ? 0 : 1, "停止")}</select></div></div>
  <div class="row"><div class="field"><label for="f_pd">この段階で、これまでに受けた時限数</label><input id="f_pd" type="number" min="0" max="40" inputmode="numeric" value="${s.priorDone || 0}"></div>
  <div class="field"><label for="f_kd">危険予測</label><select id="f_kd">${opt(0, s.kikenDone ? 1 : 0, "まだ")}${opt(1, s.kikenDone ? 1 : 0, "受講済み")}</select></div></div>
  <div class="row"><div class="field"><label for="f_hd">高速教習</label><select id="f_hd">${opt(0, s.hwDone ? 1 : 0, "まだ")}${opt(1, s.hwDone ? 1 : 0, "受講済み")}</select></div><div></div></div>
  <div class="field"><label for="f_idl">空き時間の入力締切</label><select id="f_idl">${idlOptions(s.inputDeadline || "")}</select>
    <span style="font-size:12px;color:var(--muted)">社会人などで月末・月初に予定が分かる人は、締切を遅らせてください。締切を過ぎると、教習生は◯を外せなくなります。</span></div>
  ${mkFields(s)}
  ${isNew ? "" : `<p style="font-size:12px;color:var(--muted);margin:0 0 10px">受講済みの時限数：これまでの分 ${s.priorDone || 0}＋このシステムで実施チェックした分 ${s.doneCount || 0}＝${doneOf(s)}時限（最低${lessonMin(s.stage)}時限）。段階を変えると、時限数・危険予測・高速教習は0から数え直します。</p>`}
  <div class="list"><button class="btn primary full" data-act="save" data-s="${isNew ? "" : s.token}">保存する</button>
  ${isNew ? "" : `<button class="btn full" data-act="showQR" data-s="${s.token}">QRコードを表示する</button><button class="btn full" data-act="reissue" data-s="${s.token}">QRコードを再発行する（古いQRは使えなくなります）</button><button class="btn full" data-act="del" data-s="${s.token}" style="color:var(--orange)">この教習生のデータを削除する</button>`}
  <button class="btn full" data-act="close">閉じる</button></div>`);
}

// 入力締切の選択肢：標準／前の月の1〜30日・末日／その月の1〜15日
function idlOptions(cur) {
  const o = (v, t) => `<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`;
  let h = o("", `標準（前の月の${CFG.deadlineDay}日）`) + `<optgroup label="前の月">`;
  for (let d = 1; d <= 30; d++) if (d !== CFG.deadlineDay) h += o(`p${d}`, `前の月の${d}日`);
  h += o("pe", "前の月の末日") + `</optgroup><optgroup label="その月に入ってから">`;
  for (let d = 1; d <= 15; d++) h += o(`c${d}`, `その月の${d}日`);
  return h + `</optgroup>`;
}
async function copySub(fromTok, toTok, sub, batch) {
  const snap = await getDocs(collection(db, "students", fromTok, sub));
  snap.docs.forEach(d => { batch.set(doc(db, "students", toTok, sub, d.id), d.data()); batch.delete(d.ref); });
}
async function deleteStudent(tok) {
  const batch = writeBatch(db);
  for (const sub of ["months", "bookings"]) (await getDocs(collection(db, "students", tok, sub))).docs.forEach(d => batch.delete(d.ref));
  batch.delete(doc(db, "students", tok));
  await batch.commit();
}

// 1人分のQRコードを大きく出す。登録・再発行の直後と、編集画面の「QRコードを表示する」から
function qrSheet(st, done = "") {
  sheet(`${done ? `<div class="banner ok" style="margin-top:0">${esc(done)}</div>` : ""}<h3 style="margin-top:0">${esc(st.name)} さんのQRコード</h3>
  <p style="font-size:13px;margin-top:0">教習生のスマホのカメラで読み取ってもらってください。開いたら「ホーム画面に追加」と「通知をオン」まで一緒に進めると安心です。</p>
  <div style="background:#fff;padding:14px;border-radius:12px;width:max-content;margin:0 auto 12px"><div id="qrBig"></div></div>
  <p style="font-size:12px;color:var(--muted);text-align:center;margin-top:0">このQRコードは本人だけに渡してください（他の人が読み取ると、その人の画面が開きます）</p>
  <div class="list"><button class="btn full" data-act="printOne" data-s="${st.token}">QRカードを印刷する</button><button class="btn primary full" data-act="close">閉じる</button></div>`);
  new QRCode(document.getElementById("qrBig"), { text: studentUrl(st.token), width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
}
function printCards() {
  const list = S.students.filter(s => S.sel.has(s.token));
  const area = document.getElementById("printArea");
  area.innerHTML = `<div class="noprint banner info" style="margin-top:12px">カードを確認して、印刷画面から印刷してください。<button class="btn" data-act="doPrint" style="margin-left:8px">印刷する</button></div>
  <div class="qrcards">${list.map(s => `
  <div style="border:1.5px dashed #9AA3AE;border-radius:10px;padding:12px;display:flex;gap:12px;align-items:center;break-inside:avoid;background:#fff;color:#1F2A37">
    <div class="qr" data-url="${esc(studentUrl(s.token))}" style="width:120px;height:120px;flex-shrink:0"></div>
    <div style="font-size:12px;line-height:1.5"><b style="font-size:14px">${esc(s.name)} さん</b><br>空き時間の登録はこちら<br>① スマホのカメラで読み取る<br>② ホーム画面に追加<br>③「通知の設定」で通知をオン<br><span style="color:#4B5563">このQRは他の人に見せないでください<br>${esc(CFG.schoolName)}</span></div>
  </div>`).join("")}</div>`;
  area.querySelectorAll(".qr").forEach(el => new QRCode(el, { text: el.dataset.url, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M }));
  area.scrollIntoView({ behavior: "smooth" });
}

document.addEventListener("input", e => {
  if (e.target.id === "f_karimenIssued") { const x = document.getElementById("f_karimenExpiry"); if (x) x.value = karimenExpiryOf(e.target.value); return; }
  if (e.target.id === "f_birth") { const el = document.getElementById("f_age"); if (el) el.textContent = e.target.value ? `今日時点で ${ageText(e.target.value)}` : ""; return; }
  if (e.target.id === "flt") { S.filter = e.target.value; const pos = e.target.selectionStart; render(); const f = document.getElementById("flt"); f.focus(); f.setSelectionRange(pos, pos); } });
document.addEventListener("change", async e => {
  if (e.target.id === "msort") { S.msort = e.target.value; render(); return; }
  if (e.target.dataset.act !== "reassign") return;
  const s = S.students.find(x => x.token === e.target.dataset.s), uid = e.target.value;
  if (!uid || !confirm(`${s.name}さんの担当を${iname(uid)}さんに変えます。すでに入っている予約は、前の担当のまま残ります。よろしいですか？`)) { render(); return; }
  try { await updateDoc(doc(db, "students", s.token), { instructorUid: uid }); await loadAll(); toast("担当を変えました"); } catch (err) { toast(friendlyError(err)); }
});
document.addEventListener("change", e => {
  if (e.target.dataset.act === "selPage") { filtered().forEach(s => e.target.checked ? S.sel.add(s.token) : S.sel.delete(s.token)); render(); return; }
  if (e.target.dataset.act === "sel") { const k = e.target.dataset.s; e.target.checked ? S.sel.add(k) : S.sel.delete(k); render(); } });
document.addEventListener("click", async e => {
  if (onOverlayClose(e)) return;
  const t = e.target.closest("[data-act]"); if (!t || ["sel", "selPage", "reassign"].includes(t.dataset.act)) return;
  // 指導員の画面に組み込んだ時は、自分の部分（#mng と自分が開いたシート）の操作だけを受け持つ。ログイン・ログアウトは指導員の画面に任せる
  if (MODE === "staff" && (!shown() || ["login", "logout"].includes(t.dataset.act))) return;
  const a = t.dataset.act;
  try {
    if (a === "login") { try { await signInWithEmailAndPassword(auth, document.getElementById("em").value.trim(), document.getElementById("pw").value); } catch (err) { renderLogin("メールアドレスかパスワードが違います。"); } }
    else if (a === "logout") await signOut(auth);
    else if (a === "retry") location.reload();
    else if (a === "tab") { S.tab = t.dataset.v; S.sort = { k: t.dataset.v === "instructors" ? "name" : "studentNo", dir: 1 }; render(); if (S.tab === "access") loadRecent(); }
    else if (a === "accKind") { S.accKind = t.dataset.v; render(); }
    else if (a === "accReload") loadRecent();
    else if (a === "accHist") accessHistory(t.dataset.k, t.dataset.w);
    else if (a === "printInst") printInstructorCards();
    else if (a === "new") editSheet(null);
    else if (a === "edit") editSheet(S.students.find(s => s.token === t.dataset.s));
    else if (a === "sort") { S.sort = nextSort(S.sort, t.dataset.k); render(); }
    else if (a === "selAll") { document.querySelectorAll('[data-act="sel"]').forEach(c => S.sel.add(c.dataset.s)); render(); }
    else if (a === "print") { printCards(); }
    else if (a === "showQR") qrSheet(S.students.find(s => s.token === t.dataset.s));
    else if (a === "printOne") { S.sel = new Set([t.dataset.s]); closeSheet(); render(); printCards(); }
    else if (a === "doPrint") window.print();
    else if (a === "save") {
      const v = id => document.getElementById(id).value.trim();
      const num = (id, max) => { const x = v(id); return x === "" ? null : Math.min(max, Math.max(0, Math.floor(+x))); };
      const data = {
        studentNo: toHalfDigits(v("f_no")), name: v("f_nm").replace(/\s+/g, " "), nameKana: toKatakana(v("f_kana")), stage: +v("f_st"), instructorUid: S.isAdmin ? v("f_in") : S.uid, active: v("f_ac") === "1",
        birthDate: v("f_birth") || null, license: v("f_lic") || null, heldLicense: v("f_held") || null
      };
      DATES.forEach(([k]) => { data[k] = v(`f_${k}`) || null; });
      if (data.studentNo && !/^\d{4}$/.test(data.studentNo)) return toast("教習生番号は数字4桁で入れてください（例：0123）");
      if (!data.name) return toast("名前（漢字）を入れてください");
      if (!data.nameKana) return toast("フリガナを入れてください");
      if (!data.instructorUid) return toast("担当指導員を選んでください");
      if (!isKatakana(data.nameKana)) return toast("フリガナはカタカナで入れてください（ひらがなは自動でカタカナになります）");
      data.inputDeadline = v("f_idl") || null;
      data.priorDone = Math.max(0, Math.floor(+document.getElementById("f_pd").value || 0));
      data.kikenDone = document.getElementById("f_kd").value === "1";
      data.hwDone = document.getElementById("f_hd").value === "1";
      const old = t.dataset.s ? S.students.find(x => x.token === t.dataset.s) : null;
      if (old && old.stage !== data.stage) {
        // 段階が変わったら、その段階の時限数は0から数え直す（入力欄を変えていなければ0にする）
        if (data.priorDone === (old.priorDone || 0)) data.priorDone = 0;
        if (data.kikenDone === !!old.kikenDone) data.kikenDone = false;
        if (data.hwDone === !!old.hwDone) data.hwDone = false;
        data.doneCount = 0;
      }
      if (!old) data.doneCount = 0;
      const kd = document.getElementById("f_kentei");
      if (old && kd && old.stage === data.stage) {
        const m = mikiwameOf(old);
        data[`mikiwame${old.stage}`] = { ...m, kenteiDate: kd.value || null, kenteiUndecided: !kd.value, gakkaDone: document.getElementById("f_gakka").value === "1" };
      }
      t.disabled = true;
      if (t.dataset.s) { await updateDoc(doc(db, "students", t.dataset.s), data); closeSheet(); await loadAll(); toast("保存しました"); }
      else {
        // 新しく登録した時は、そのままQRコードを出す（その場で教習生のスマホで読み取ってもらう）
        const nt = newToken();
        await setDoc(doc(db, "students", nt), { ...data, createdAt: serverTimestamp() });
        await loadAll(); qrSheet({ token: nt, ...data }, "登録しました");
      }
    }
    else if (a === "reissue") {
      if (!confirm("QRコードを再発行します。古いQRコードは使えなくなります。よろしいですか？")) return;
      const old = t.dataset.s; const nt = newToken(); t.disabled = true;
      const sd = await getDoc(doc(db, "students", old));
      const data = sd.data(); delete data.fcmTokens;            // 通知の登録はやり直してもらう
      await setDoc(doc(db, "students", nt), { ...data, reissuedAt: serverTimestamp() });   // 先に作る（担当の確認のため）
      const batch = writeBatch(db);
      await copySub(old, nt, "months", batch); await copySub(old, nt, "bookings", batch);
      batch.delete(doc(db, "students", old));
      await batch.commit();
      await loadAll(); qrSheet({ token: nt, ...data }, "再発行しました");
    }
    else if (a === "delInst") {
      const i = S.instructors.find(x => x.uid === t.dataset.u), n = S.students.filter(x => x.instructorUid === i.uid).length;
      if (n) return toast(`${i.name}さんの担当の教習生が${n}人います。先に「教習生」タブで担当を付け替えてください`);
      if (!confirm(`${i.name}さんを指導員から削除します。よろしいですか？（ログイン用アカウントは、Firebaseコンソールの Authentication で削除してください）`)) return;
      await deleteDoc(doc(db, "instructors", i.uid)); await loadAll(); toast("削除しました");
    }
    else if (a === "addInst") {
      const uid = document.getElementById("iu").value.trim(), name = document.getElementById("in").value.trim(), email = document.getElementById("ie").value.trim();
      if (!uid || !name) return toast("UIDと名前は必須です");
      await setDoc(doc(db, "instructors", uid), { name, email, createdAt: serverTimestamp() });
      await loadAll(); toast("登録しました");
    }
    else if (a === "del") {
      if (!confirm("この教習生の空き時間・予約を含むすべてのデータを削除します。元に戻せません。よろしいですか？")) return;
      t.disabled = true; await deleteStudent(t.dataset.s); S.sel.delete(t.dataset.s); closeSheet(); await loadAll(); toast("削除しました");
    }
  } catch (err) { toast(friendlyError(err)); }
});
