// 管理画面の本体。2つのページで使う（body の data-mode で切り替え）
// ・admin.html（data-mode="admin"）：大元の管理画面。管理者だけがログインする。指導員の登録・削除と指導員用QR、
//   全員の教習生（登録・編集・削除・担当の付け替え・QR）、設定
// ・manage.html（data-mode="staff"）：指導員の画面の中の「教習生の管理」。ログインは指導員の画面で済ませてあり、
//   ここではログインしない。自分の担当の教習生の登録・編集・削除・QR
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "./backend.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, serverTimestamp, writeBatch
} from "./backend.js";
import { CFG, app as fbApp, db, esc, toast, sheet, closeSheet, onOverlayClose, friendlyError, lessonMin, doneOf, ageText, karimenExpiryOf, expiriesOf, expiryText, toKatakana, isKatakana, isPC, viewToggle, onViewChange, pcTable, nextSort, DEMO } from "./common.js";

const auth = getAuth(fbApp);
const MODE = document.body.dataset.mode === "staff" ? "staff" : "admin";
const root = document.getElementById("app");
const S = { uid: null, me: null, isAdmin: false, isInst: false, tab: "students", instructors: [], students: [], sel: new Set(), filter: "", sort: { k: "studentNo", dir: 1 } };

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const studentUrl = tok => `${CFG.appUrl}student.html?t=${encodeURIComponent(tok)}`;
const instructorUrl = i => `${CFG.appUrl}instructor.html${i.email ? `?e=${encodeURIComponent(i.email)}` : ""}`;
const iname = uid => (S.instructors.find(i => i.uid === uid) || {}).name || "（未設定）";
const tabs = () => S.isAdmin ? [["students", `教習生（${S.students.length}人）`], ["instructors", `指導員（${S.instructors.length}人）`], ["settings", "設定"]] : [["students", `担当の教習生（${S.students.length}人）`]];

// 教習生の管理（指導員）はここでログインしない。指導員の画面へ案内する
function gate(msg) {
  root.innerHTML = `<section class="panel"><div class="body"><div class="banner warn">${esc(msg)}</div><a class="btn accent full center" style="text-decoration:none" href="instructor.html">指導員の画面を開く</a></div></section>`;
}
function renderLogin(msg = "") {
  root.innerHTML = `<section class="panel"><div class="phead"><div><h2>管理者ログイン</h2><small>${esc(CFG.schoolName)}</small></div></div>
  <div class="body"><form onsubmit="return false"><div class="field"><label for="em">メールアドレス</label><input id="em" type="email" autocomplete="username"></div>
  <div class="field"><label for="pw">パスワード</label><input id="pw" type="password" autocomplete="current-password"></div>
  ${msg ? `<div class="banner warn">${esc(msg)}</div>` : ""}<button class="btn primary full" data-act="login">ログイン</button></form></div></section>`;
}
onViewChange(render);
onAuthStateChanged(auth, async user => {
  if (!user) { S.uid = null; MODE === "staff" ? gate("指導員の画面からログインしてください。") : renderLogin(); return; }
  S.uid = user.uid; S.tab = "students"; S.sel = new Set(); S.filter = "";
  try {
    const [ad, me] = await Promise.all([getDoc(doc(db, "admins", user.uid)), getDoc(doc(db, "instructors", user.uid))]);
    S.me = me.exists() ? me.data() : null;
    // 大元の管理画面は管理者だけ、教習生の管理は指導員だけ（ページごとに役割を1つに決める）
    S.isAdmin = MODE === "admin" && ad.exists(); S.isInst = MODE === "staff" && me.exists();
    if (MODE === "admin" && !S.isAdmin) { S.uid = null; await signOut(auth); renderLogin("この画面は管理者専用です。"); return; }
    if (MODE === "staff" && !S.isInst) { S.uid = null; gate("指導員として登録されていません。事務所に確認してください。"); return; }
    await loadAll();
  } catch (e) { renderLogin(friendlyError(e)); }
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
    <span>${S.isInst ? `<a class="linkbtn" href="instructor.html" style="text-decoration:none">割り当てに戻る</a>` : `<button class="linkbtn" data-act="logout">ログアウト</button>`}</span></div>
  ${tabs().length < 2 ? "" : `<div class="seg noprint" role="group" style="grid-template-columns:repeat(${tabs().length},1fr)">${tabs().map(([v, t]) => `<button aria-pressed="${S.tab === v}" data-act="tab" data-v="${v}">${t}</button>`).join("")}</div>`}`;
  h += S.tab === "instructors" ? renderInstructors() : S.tab === "settings" ? renderSettings() : renderStudents();
  root.innerHTML = h + `<p class="center noprint">${viewToggle()}</p>`;
}
const who = () => S.isAdmin ? `${CFG.schoolName}・管理者` : `${S.me ? S.me.name : ""} 指導員の担当（${S.students.length}人）`;
const match = (s, f) => !f || String(s.name).includes(f) || String(s.nameKana || "").includes(toKatakana(f)) || String(s.studentNo).includes(f) || String(s.license || "").includes(f) || (S.isAdmin && iname(s.instructorUid).includes(f));
const assignSelect = s => `<select data-act="reassign" data-s="${s.token}" aria-label="${esc(s.name)}の担当">${S.instructors.map(i => `<option value="${esc(i.uid)}" ${i.uid === s.instructorUid ? "selected" : ""}>${esc(i.name)}</option>`).join("")}${S.instructors.some(i => i.uid === s.instructorUid) ? "" : `<option value="" selected>（未設定）</option>`}</select>`;
const filtered = () => { const f = S.filter.trim(); return S.students.filter(s => match(s, f)); };
// 期限が近い・過ぎた日付は赤で出す
const dateCell = (s, k) => { const e = expiriesOf(s).find(x => x.key === k); return s[k] ? `<span style="${e ? "color:var(--lv3);font-weight:700" : ""}" title="${e ? esc(expiryText(e)) : ""}">${esc(s[k])}</span>` : ""; };
// PC表示：左にメニュー、右に全項目の表（見出しで並べ替え）。編集は右からパネルで開く
function renderPC() {
  const main = S.tab === "instructors" ? renderInstructorsPC() : S.tab === "settings" ? `<h2>設定</h2>${renderSettings().replace('<div class="list">', '<div class="list pcgrid">')}` : renderStudentsPC();
  root.innerHTML = `<div class="pcl"><aside class="pcside noprint"><h1>${S.isAdmin ? "管理画面" : "教習生の管理"}</h1><small>${esc(who())}</small>
    <nav class="pcnav">${tabs().map(([v, t]) => `<button aria-pressed="${S.tab === v}" data-act="tab" data-v="${v}">${t}</button>`).join("")}${S.isInst ? `<a href="instructor.html">予約の割り当てへ</a>` : ""}</nav>
    <div class="foot">${viewToggle()}${S.isAdmin ? `<button class="linkbtn" data-act="logout">ログアウト</button>` : ""}</div></aside>
  <main class="pcmain"><div class="noprint">${main}</div><div id="printArea"></div></main></div>`;
}
function renderStudentsPC() {
  const list = filtered();
  const cols = [
    { t: `<input type="checkbox" data-act="selPage" aria-label="表示中を全選択" ${list.length && list.every(s => S.sel.has(s.token)) ? "checked" : ""}>`, html: s => `<input type="checkbox" data-act="sel" data-s="${s.token}" ${S.sel.has(s.token) ? "checked" : ""} aria-label="選択">` },
    { k: "studentNo", t: "番号" }, { k: "nameKana", t: "名前", html: s => `${esc(s.name)}<br><small style="color:var(--muted)">${esc(s.nameKana || "")}</small>` },
    { k: "birthDate", t: "生年月日" }, { k: "age", t: "年齢", v: s => ageText(s.birthDate), sort: s => s.birthDate ? -new Date(s.birthDate) : 1 }, { k: "gender", t: "性別" },
    { k: "stage", t: "段階", v: s => `第${s.stage}段階` }, { k: "license", t: "希望免許" }, { k: "heldLicense", t: "所持免許" },
    { k: "done", t: "進み具合", v: s => `${doneOf(s)}/${lessonMin(s.stage)}`, sort: s => doneOf(s) / (lessonMin(s.stage) || 1) },
    { k: "startDate", t: "教習開始" }, { k: "classStart", t: "学科開始" }, { k: "skillStart", t: "技能開始" }, { k: "deadline", t: "教習期限", html: s => dateCell(s, "deadline") },
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
  const list = S.students.filter(s => match(s, f));
  let h = `<section class="panel noprint"><div class="body">
  <div class="tools" style="grid-template-columns:1fr 1fr 1fr"><button class="btn primary" data-act="new">教習生を追加</button><button class="btn" data-act="print" ${S.sel.size ? "" : "disabled"}>QRカードを印刷（${S.sel.size}人）</button><button class="btn" data-act="selAll">表示中を全選択</button></div>
  <div class="field" style="margin-top:10px"><label for="flt">絞り込み（名前・番号${S.isAdmin ? "・担当" : ""}）</label><input id="flt" value="${esc(S.filter)}"></div>
  <div class="gridwrap"><table class="adm"><thead><tr><th></th><th>番号</th><th>名前</th><th>段階</th><th>希望免許</th><th>進み具合</th><th>教習期限</th><th>仮免期限</th><th>状態</th>${S.isAdmin ? "<th>担当</th>" : ""}<th></th></tr></thead><tbody>`;
  list.forEach(s => {
    h += `<tr><td><input type="checkbox" data-act="sel" data-s="${s.token}" ${S.sel.has(s.token) ? "checked" : ""} aria-label="選択"></td><td>${esc(s.studentNo)}</td><td>${esc(s.name)}<br><small style="color:var(--muted)">${esc(s.nameKana || "")}</small></td><td>${s.stage}</td><td>${esc(s.license || "")}</td><td>${doneOf(s)}/${lessonMin(s.stage)}</td><td>${dateCell(s, "deadline")}</td><td>${dateCell(s, "karimenExpiry")}</td><td>${s.active === false ? '<span class="tag wait">停止</span>' : '<span class="tag ok">利用中</span>'}</td>${S.isAdmin ? `<td>${assignSelect(s)}</td>` : ""}<td><button class="btn" data-act="edit" data-s="${s.token}">編集</button></td></tr>`;
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
    ["入力の締切", `毎月${CFG.deadlineDay}日（次月分）。締切後は◯を外せない`],
    ["予約を入れる曜日", CFG.openDays.map(d => "日月火水木金土"[d]).join("・")],
    ["1日の上限", Object.entries(CFG.dailyMax).map(([k, v]) => `第${k}段階 ${v}時限`).join("、")],
    ["最低教習時限", Object.entries(CFG.lessons || {}).map(([k, v]) => `第${k}段階 ${v.min}時限${v.kikenNo ? `（${v.kikenNo}時限目が${(CFG.kiken || {}).label}）` : ""}`).join("、")],
    ["高速教習の組", (CFG.highwaySets || []).map(x => x.join("・")).join("／")],
    ["日没が早い期間", dk.from ? `${fmt(dk.from)}〜${fmt(dk.to)}（警告：高速 ${(dk.sets || []).map(x => x.join("・")).join("／")}、単独高速 ${(dk.hwSoloSets || []).map(x => x.join("・")).join("／")}）` : "なし"],
    ["時限", CFG.periods.slice(1).map((p, i) => `${i + 1}限 ${p[0]}〜${p[1]}`).join("、")]
  ];
  return `<section class="panel"><div class="body"><div class="banner info">いまの設定です。変更したい時は、設定ファイル（js/config.js）を書き換えます。</div>
  <div class="list">${rows.map(([k, v]) => `<div class="item" style="display:block"><div class="s">${esc(k)}</div><div class="t">${esc(v)}</div></div>`).join("")}</div></div></section>`;
}

function renderInstructors() {
  let h = `<section class="panel"><div class="body">
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
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">${S.instructors.map(i => `
  <div style="border:1.5px dashed #9AA3AE;border-radius:10px;padding:12px;display:flex;gap:12px;align-items:center;break-inside:avoid;background:#fff;color:#1F2A37">
    <div class="qr" data-url="${esc(instructorUrl(i))}" style="width:120px;height:120px;flex-shrink:0"></div>
    <div style="font-size:12px;line-height:1.5"><b style="font-size:14px">${esc(i.name)} 指導員</b><br>予約の割り当てはこちら<br>① スマホのカメラで読み取る<br>② ホーム画面に追加<br>③ ログインして「通知」をオン<br><span style="color:#4B5563">${esc(CFG.schoolName)}</span></div>
  </div>`).join("")}</div>`;
  area.querySelectorAll(".qr").forEach(el => new QRCode(el, { text: el.dataset.url, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M }));
  area.scrollIntoView({ behavior: "smooth" });
}

// 登録・編集フォーム。日付はすべて YYYY-MM-DD。年齢は登録時点の「○歳○ヶ月」
const DATES = [["startDate", "教習開始日"], ["classStart", "学科開始日"], ["deadline", "教習期限日"], ["skillStart", "技能開始日"], ["karimenIssued", "仮免交付日"], ["karimenExpiry", "仮免期限日"]];
function editSheet(s) {
  const isNew = !s; s = s || { studentNo: "", name: "", stage: 1, active: true };
  const opt = (v, cur, t = v) => `<option value="${esc(v)}" ${String(cur ?? "") === String(v) ? "selected" : ""}>${esc(t)}</option>`;
  sheet(`<h3>${isNew ? "教習生を追加" : "教習生を編集"}</h3>
  <datalist id="dl_lic">${(CFG.licenseTypes || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist>
  <datalist id="dl_held">${(CFG.heldLicenseTypes || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist>
  <div class="row"><div class="field"><label for="f_nm">名前（漢字）<span style="color:var(--lv3)">＊必須</span></label><input id="f_nm" value="${esc(s.name)}" autocomplete="off" placeholder="例：山田 太郎"></div>
  <div class="field"><label for="f_kana">フリガナ<span style="color:var(--lv3)">＊必須</span></label><input id="f_kana" value="${esc(s.nameKana || "")}" autocomplete="off" placeholder="例：ヤマダ タロウ"></div></div>
  <div class="row"><div class="field"><label for="f_no">教習生番号</label><input id="f_no" value="${esc(s.studentNo)}" autocomplete="off"></div>
  ${S.isAdmin ? `<div class="field"><label for="f_in">担当指導員<span style="color:var(--lv3)">＊必須</span></label><select id="f_in">${opt("", s.instructorUid || (S.isInst ? S.uid : ""), "選んでください")}${S.instructors.map(i => opt(i.uid, s.instructorUid || (S.isInst ? S.uid : ""), i.name)).join("")}</select></div>` : "<div></div>"}</div>
  <div class="row"><div class="field"><label for="f_birth">生年月日</label><input id="f_birth" type="date" value="${esc(s.birthDate || "")}"><span id="f_age" style="font-size:12px;color:var(--muted)">${s.birthDate ? `今日時点で ${ageText(s.birthDate)}` : ""}</span></div>
  <div class="field"><label for="f_sx">性別</label><select id="f_sx">${opt("", s.gender, "選んでください")}${opt("男", s.gender)}${opt("女", s.gender)}</select></div></div>
  <div class="row"><div class="field"><label for="f_lic">希望免許</label><input id="f_lic" list="dl_lic" value="${esc(s.license || "")}" autocomplete="off"></div>
  <div class="field"><label for="f_held">所持免許</label><input id="f_held" list="dl_held" value="${esc(s.heldLicense || "")}" autocomplete="off"></div></div>
  <div class="row">${DATES.map(([k, t]) => `<div class="field"><label for="f_${k}">${t}${k === "karimenExpiry" ? `<span style="font-weight:400;color:var(--muted);font-size:11px">（交付日から自動）</span>` : ""}</label><input id="f_${k}" type="date" value="${esc(s[k] || "")}"></div>`).join("")}</div>
  <h3 style="margin-top:6px">教習の状況</h3>
  <p style="font-size:12px;color:var(--muted);margin:0 0 8px">転校などで途中から始める人は、段階と「これまでに受けた時限数」を入れてください。</p>
  <div class="row"><div class="field"><label for="f_st">段階</label><select id="f_st">${opt(1, s.stage, "第1段階")}${opt(2, s.stage, "第2段階")}</select></div>
  <div class="field"><label for="f_ac">状態</label><select id="f_ac">${opt(1, s.active === false ? 0 : 1, "利用中")}${opt(0, s.active === false ? 0 : 1, "停止")}</select></div></div>
  <div class="row"><div class="field"><label for="f_pd">この段階で、これまでに受けた時限数</label><input id="f_pd" type="number" min="0" max="40" inputmode="numeric" value="${s.priorDone || 0}"></div>
  <div class="field"><label for="f_kd">危険予測</label><select id="f_kd">${opt(0, s.kikenDone ? 1 : 0, "まだ")}${opt(1, s.kikenDone ? 1 : 0, "受講済み")}</select></div></div>
  ${isNew ? "" : `<p style="font-size:12px;color:var(--muted);margin:0 0 10px">受講済みの時限数：これまでの分 ${s.priorDone || 0}＋このシステムで実施チェックした分 ${s.doneCount || 0}＝${doneOf(s)}時限（最低${lessonMin(s.stage)}時限）。段階を変えると、時限数と危険予測は0から数え直します。</p>`}
  <div class="list"><button class="btn primary full" data-act="save" data-s="${isNew ? "" : s.token}">保存する</button>
  ${isNew ? "" : `<button class="btn full" data-act="reissue" data-s="${s.token}">QRコードを再発行する（古いQRは使えなくなります）</button><button class="btn full" data-act="del" data-s="${s.token}" style="color:var(--orange)">この教習生のデータを削除する</button>`}
  <button class="btn full" data-act="close">閉じる</button></div>`);
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

function printCards() {
  const list = S.students.filter(s => S.sel.has(s.token));
  const area = document.getElementById("printArea");
  area.innerHTML = `<div class="noprint banner info" style="margin-top:12px">カードを確認して、印刷画面から印刷してください。<button class="btn" data-act="doPrint" style="margin-left:8px">印刷する</button></div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">${list.map(s => `
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
  const a = t.dataset.act;
  try {
    if (a === "login") { try { await signInWithEmailAndPassword(auth, document.getElementById("em").value.trim(), document.getElementById("pw").value); } catch (err) { renderLogin("メールアドレスかパスワードが違います。"); } }
    else if (a === "logout") await signOut(auth);
    else if (a === "tab") { S.tab = t.dataset.v; S.sort = { k: t.dataset.v === "instructors" ? "name" : "studentNo", dir: 1 }; render(); }
    else if (a === "printInst") printInstructorCards();
    else if (a === "new") editSheet(null);
    else if (a === "edit") editSheet(S.students.find(s => s.token === t.dataset.s));
    else if (a === "sort") { S.sort = nextSort(S.sort, t.dataset.k); render(); }
    else if (a === "selAll") { document.querySelectorAll('[data-act="sel"]').forEach(c => S.sel.add(c.dataset.s)); render(); }
    else if (a === "print") { printCards(); }
    else if (a === "doPrint") window.print();
    else if (a === "save") {
      const v = id => document.getElementById(id).value.trim();
      const num = (id, max) => { const x = v(id); return x === "" ? null : Math.min(max, Math.max(0, Math.floor(+x))); };
      const data = {
        studentNo: v("f_no"), name: v("f_nm").replace(/\s+/g, " "), nameKana: toKatakana(v("f_kana")), stage: +v("f_st"), instructorUid: S.isAdmin ? v("f_in") : S.uid, active: v("f_ac") === "1",
        birthDate: v("f_birth") || null, gender: v("f_sx") || null, license: v("f_lic") || null, heldLicense: v("f_held") || null
      };
      DATES.forEach(([k]) => { data[k] = v(`f_${k}`) || null; });
      if (!data.name) return toast("名前（漢字）を入れてください");
      if (!data.nameKana) return toast("フリガナを入れてください");
      if (!data.instructorUid) return toast("担当指導員を選んでください");
      if (!isKatakana(data.nameKana)) return toast("フリガナはカタカナで入れてください（ひらがなは自動でカタカナになります）");
      data.priorDone = Math.max(0, Math.floor(+document.getElementById("f_pd").value || 0));
      data.kikenDone = document.getElementById("f_kd").value === "1";
      const old = t.dataset.s ? S.students.find(x => x.token === t.dataset.s) : null;
      if (old && old.stage !== data.stage) {
        // 段階が変わったら、その段階の時限数は0から数え直す（入力欄を変えていなければ0にする）
        if (data.priorDone === (old.priorDone || 0)) data.priorDone = 0;
        if (data.kikenDone === !!old.kikenDone) data.kikenDone = false;
        data.doneCount = 0;
      }
      if (!old) data.doneCount = 0;
      t.disabled = true;
      if (t.dataset.s) await updateDoc(doc(db, "students", t.dataset.s), data);
      else await setDoc(doc(db, "students", newToken()), { ...data, createdAt: serverTimestamp() });
      closeSheet(); await loadAll(); toast("保存しました");
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
      S.sel = new Set([nt]); closeSheet(); await loadAll(); printCards(); toast("再発行しました。新しいQRカードを渡してください");
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
