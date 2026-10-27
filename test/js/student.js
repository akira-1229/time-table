// 教習生の画面：空き時間の登録、予約の確認、キャンセル希望、通知の設定
import {
  doc, getDoc, setDoc, updateDoc, addDoc, collection, query, where, getDocs, serverTimestamp, onSnapshot
} from "./backend.js";
import {
  CFG, db, WD, P, ymOf, dateStr, parseDate, daysIn, today, md, label, slotKey, esc, toast, sheet, closeSheet,
  onOverlayClose, friendlyError, enablePush, pushReasonText, isIOS, isStandalone, listenForeground,
  installButton, firstVisitInstall, sendNow, pushStatusHtml, lessonPlan, lessonItems, noRange, bookingEnd, lessonMin, doneOf, mikiwameOf, kenteiOn, lookSettingsHtml,
  inputDeadlineOf, pastInputDeadline, hwWaitDays, isHwType, trackAccess, greeting, noticeHead, busySheet, noticeRow, mdS, saveNotices, noticeHistoryHtml
} from "./common.js";

const app = document.getElementById("app");

// QRのURL（?t=）から本人のキーを取り出す。ホーム画面から開いた時のために端末にも控える
const params = new URLSearchParams(location.search);
let T = params.get("t");
try { if (T) localStorage.setItem("timetable_t", T); else T = localStorage.getItem("timetable_t"); } catch (e) { }

const now = today();
const MONTHS = [
  { y: now.getFullYear(), m: now.getMonth() + 1 },
  { y: new Date(now.getFullYear(), now.getMonth() + 1, 1).getFullYear(), m: new Date(now.getFullYear(), now.getMonth() + 1, 1).getMonth() + 1 }
];
const S = { tab: "cal", mi: 1, student: null, avail: {}, off: {}, bookings: [], saveTimers: {}, bulkW: new Set(), bulkP: new Set(), addedNow: {} };

async function load() {
  if (!T) return fail("QRコードから開いてください。QRコードが手元にない場合は、事務所にお問い合わせください。");
  try {
    const sdoc = await getDoc(doc(db, "students", T));
    if (!sdoc.exists()) return fail("このQRコードは使えなくなっています。事務所で新しいQRコードを受け取ってください。");
    S.student = sdoc.data();
    for (const { y, m } of MONTHS) {
      const md_ = await getDoc(doc(db, "students", T, "months", ymOf(y, m)));
      S.avail[ymOf(y, m)] = new Set(md_.exists() ? md_.data().slots || [] : []);
    }
    // 担当の指導員の予定（✕）。✕の時間は◯を付けられない
    for (const { y, m } of MONTHS) {
      const od = S.student.instructorUid ? await getDoc(doc(db, "offs", `${S.student.instructorUid}_${ymOf(y, m)}`)) : null;
      S.off[ymOf(y, m)] = new Set(od && od.exists() ? od.data().slots || [] : []);
    }
    const bq = query(collection(db, "students", T, "bookings"), where("status", "in", ["confirmed", "cancelled"]));
    S.bookings = (await getDocs(bq)).docs.map(d => ({ id: d.id, ...d.data() }));
    S.mi = nextMonthFilled() ? 0 : 1;
    render();
    if (!watching) { watching = true; watch(bq); listenForeground(() => load()); showNextLesson(); firstVisitInstall("student"); trackAccess("student", T, S.student.instructorUid); }
  } catch (e) { fail(friendlyError(e)); }
}
// 指導員が予約を確定・取り消しした時や、通知を送った時に、開いたままの画面にもすぐ反映する
let watching = false;
function watch(bq) {
  onSnapshot(bq, r => { S.bookings = r.docs.map(d => ({ id: d.id, ...d.data() })); render(); checkNews(); }, () => { });
  onSnapshot(doc(db, "students", T), d => { if (d.exists()) { S.student = d.data(); render(); checkNews(); } }, () => { });
}
// 新着（予約が決まった・変わった・取り消された、検定日など）があれば、開いたままでもお知らせを出す
let lastSig = null, newsPending = false;
const noticeSig = () => { const n = nextLesson(); return JSON.stringify([n && [n.date, n.ps], kenteiOn(S.student), S.bookings.filter(b => b.status === "cancelled").length, S.student.lastNotifiedAt && S.student.lastNotifiedAt.toMillis ? S.student.lastNotifiedAt.toMillis() : 0]); };
function checkNews() {
  if (!S.student) return;
  const sig = noticeSig();
  if (lastSig === null || sig === lastSig) { if (lastSig === null) lastSig = sig; return; }
  lastSig = sig;
  if (busySheet()) newsPending = true; else showNextLesson();
}
setInterval(() => { if (newsPending && !busySheet()) { newsPending = false; showNextLesson(); } }, 2000);
function fail(msg) { app.innerHTML = `<div class="err">${esc(msg)}</div>`; }

const nextYm = () => ymOf(MONTHS[1].y, MONTHS[1].m);
const nextMonthFilled = () => (S.avail[nextYm()] || new Set()).size > 0;
// 締切は教習生ごと（標準は前の月の deadlineDay 日。指導員が「その月の3日」などに変えられる）。締切を過ぎた月は◯を外せない
const dlOf = ym => inputDeadlineOf(S.student, ym);
const pastDeadline = ym => pastInputDeadline(S.student, ym);
// 「締切後に変更あり」：今月に締切が来た月（ふつうは来月分）を、締切後に変えた時
const isLate = ym => pastDeadline(ym) && dlOf(ym).slice(0, 7) === ymOf(MONTHS[0].y, MONTHS[0].m);
const dlText = ym => { const [, m, d] = dlOf(ym).split("-").map(Number); return `${m}月${d}日`; };
// この画面を開いてから付けた◯は、締切後でも付け間違いとして外せる
const addSlot = (ym, k) => { if (!S.avail[ym].has(k)) { S.avail[ym].add(k); (S.addedNow[ym] = S.addedNow[ym] || new Set()).add(k); } };
const canRemove = (ym, k) => !CFG.noRemoveAfterDeadline || !pastDeadline(ym) || (S.addedNow[ym] && S.addedNow[ym].has(k));
function confirmedAt(ds, p) { return S.bookings.find(b => b.status === "confirmed" && b.date === ds && b.period === p); }
function unacked() {
  const n = S.student.lastNotifiedAt, a = S.student.ackAt;
  return n && (!a || n.toMillis() > a.toMillis());
}

// 次の教習（確定済みで、まだ終わっていない一番早い予約の日）。同じ日の予約はまとめて出す（2・3時限連続の教習は1つにまとめる）
const kindOf = it => it.lessonType === "kiken" ? (CFG.kiken || {}).label || "危険予測" : it.lessonType === "hwSolo" ? (CFG.hwSolo || {}).label || "単独高速" : it.lessonType === "hw3" || it.highway ? "高速教習" : "";
function nextLesson() {
  const st = S.student, t = new Date();
  const list = S.bookings.filter(b => b.status === "confirmed" && !b.result && bookingEnd(b) > t);
  const first = lessonItems(list)[0]; if (!first) return null;
  const day = lessonItems(list.filter(b => b.date === first.date));
  const plan = lessonPlan(st, S.bookings.filter(b => b.status === "confirmed" && !b.result && (b.stage ?? st.stage) === st.stage));
  const psOf = it => it.bookings.map(b => b.period).sort((a, b) => a - b);
  // 例：「2時限目」「4・5時限目（2時限連続）」「2時限目と6時限目」
  const parts = day.map(it => { const ps = psOf(it); return `${ps.join("・")}時限目${ps.length > 1 ? `（${ps.length}時限連続）` : ""}`; });
  const nos = day.map(it => plan.items.find(x => x.bookings.some(y => y.id === it.bookings[0].id))).filter(Boolean).map(pi => `${noRange(pi)}時限目`);
  const all = day.flatMap(it => it.bookings);
  return {
    ids: all.filter(b => !b.ackAt).map(b => b.id), date: first.date, ps: all.map(b => b.period).sort((a, b) => a - b), parts,
    time: day.map(it => { const ps = psOf(it); return `${P[ps[0]][0]}〜${P[ps.at(-1)][1]}`; }).join("、"),
    kind: [...new Set(day.map(kindOf).filter(Boolean))].join("・"), no: nos.join("・"), req: all.some(b => b.cancelRequested)
  };
}
const nextText = n => `${md(n.date)} ${n.ps.join("・")}限`;
// アプリを開くたびに（ホーム画面から戻ってきた時も、10分以上たっていれば）お知らせ（あいさつと次の教習）を出す
let nextShownAt = 0;
function showNextLesson() {
  const n = nextLesson(), st = S.student;
  nextShownAt = Date.now(); lastSig = noticeSig();
  const head = `${noticeHead()}<p class="greet"><b>${esc(st.name)}さん</b>　${greeting()}</p>`;
  if (!n) {
    sheet(`${head}<p>次の教習の予定は、まだ決まっていません。予約が決まると通知でお知らせします。</p>
    <div class="list"><button class="btn primary full" data-act="close">OK</button></div>`, { notice: true });
    return;
  }
  saveNotices(NSCOPE(), [{ key: `nx:${n.date}:${n.ps.join(",")}`, html: noticeRow(n.date === dateStr(today()) ? "今日の教習" : "次の教習", `${mdS(n.date)} ${n.parts.join("と")}${n.kind ? `<small>${esc(n.kind)}</small>` : ""}`) }]);
  if (S.tab === "ntc") render();
  sheet(`${head}<p style="font-size:16px">次の教習の予定は、<b>${md(n.date)}の${n.parts.join("と")}</b>になります！</p>
  <div class="nextl"><div class="d">${md(n.date)}</div><div class="p">${n.ps.join("・")}限</div><div class="s">${n.time}${n.kind ? `・${esc(n.kind)}` : ""}</div></div>
  ${n.req ? '<div class="banner warn">キャンセル希望を送信済みです。指導員の確認を待っています。</div>' : ""}
  <p style="font-size:13px;color:var(--muted)">教習開始の5分前には到着して、配車券の発行をお願い致します。都合が悪くなった時は、早めに学園にお電話ください。</p>
  <label class="ackchk"><input type="checkbox" id="nl_chk"> 確認しました</label>
  <div class="list"><button class="btn primary full" id="nl_ok" data-act="nextOk" data-ids="${n.ids.join(",")}" disabled>OK</button></div>`, { notice: true });
  // 「確認しました」にチェックを付けてOKを押すまで閉じない（外側を押しても閉じない）
  const bg = document.querySelector("#overlay .sheet-bg"); if (bg) bg.removeAttribute("data-act");
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.student && Date.now() - nextShownAt > 10 * 60 * 1000 && !document.querySelector("#overlay .sheet")) showNextLesson();
});

// 画面の下にいつも出すタブ：左「空き時間の登録」、真ん中「教習の進み具合」、右「設定」
const TABS = [
  ["cal", "空き時間の登録", '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M8.5 15l2.3 2.3 4.7-4.6"/></svg>'],
  ["book", "教習の進み具合", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'],
  ["ntc", "お知らせ", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/></svg>'],
  ["set", "設定", '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>']
];
function renderNav() {
  const nav = document.getElementById("tabnav");
  document.body.classList.add("shell"); nav.hidden = false;
  nav.innerHTML = `<div class="tn-tabs" role="tablist">${TABS.map(([v, t, ic]) => `<button role="tab" aria-selected="${S.tab === v}" data-act="tab" data-v="${v}">${ic}<span>${t}${v === "book" && unacked() ? '<span class="dot">!</span>' : ""}</span></button>`).join("")}</div>`;
}
function render() {
  const st = S.student, title = TABS.find(x => x[0] === S.tab)[1];
  let h = `<div class="topbar"><div><h1>${title}</h1><small>${esc(CFG.schoolName)}・${esc(st.name)} さん</small></div></div>`;
  const nx = nextLesson();
  if (nx) h += `<button class="nextbar" data-act="next"><span>${nx.date === dateStr(today()) ? "今日の教習" : "次の教習"}</span><b>${nextText(nx)}</b><small>${nx.time}</small></button>`;
  if (kenteiOn(st)) h += `<div class="banner ok" style="font-size:16px;text-align:center"><b>本日はいよいよ検定日です！</b><br>これまでに教わった事をよく思い出して頑張りましょう！</div>`;
  h += `<section class="panel"><div class="body${S.tab === "set" ? " setpage" : ""}">`;
  h += S.tab === "cal" ? renderCal() : S.tab === "book" ? renderBook() : S.tab === "ntc" ? renderNtc() : renderSet();
  app.innerHTML = h + `</div></section>`;
  renderNav();
}
// お知らせ：これまでに入った新着情報（新しい順。この端末に保存）
const NSCOPE = () => `student_${T}`;
function renderNtc() {
  return noticeHistoryHtml(NSCOPE());
}
// 設定：見た目（明るさ・文字の大きさ）、通知、ホーム画面に追加、困った時
function renderSet() {
  const st = S.student;
  return `${lookSettingsHtml({ view: false })}
  <div class="setgrp"><h3>通知・アプリ</h3>${pushStatusHtml()}<div class="list"><button class="btn primary full" data-act="push">通知の設定</button>${installButton() ? `<div>${installButton()}</div>` : ""}</div>
    <p class="setnote">予約が決まった時や変更があった時に、スマホに通知が届きます。${isIOS() ? "iPhoneは、ホーム画面に追加したアイコンから開いた時だけ通知を受け取れます。" : ""}</p></div>
  <div class="setgrp"><h3>あなたの情報</h3><div class="item"><div><div class="t">${esc(st.name)} さん</div><div class="s">${st.studentNo ? `教習生番号 ${esc(st.studentNo)}・` : ""}第${st.stage}段階</div></div></div>
    <p class="setnote">登録内容が違う時は、担当の指導員に伝えてください。</p></div>
  <div class="setgrp"><h3>困った時は</h3><div class="list"><a class="btn full center" style="text-decoration:none" href="guide-student.html">使い方を見る</a><a class="btn full center" style="text-decoration:none" href="tel:${esc(CFG.schoolTel)}">学園に電話する</a></div>
    <p class="setnote">${esc(CFG.schoolName)}　電話 <span class="tel">${esc(CFG.schoolTel)}</span></p></div>`;
}
document.addEventListener("pref:change", () => { if (S.student) render(); });

// 利用停止中（指導員が「停止」にした人）は◯を付けられない（依頼者指定の文言）
const stopped = () => S.student && S.student.active === false;
// 卒業した人（卒業検定に合格）も利用停止と同じく◯は付けられない
const stopMsg = () => S.student.graduatedOn ? "卒業おめでとうございます。空き時間の登録は終わりました。" : "現在、指導員により利用停止中です。詳しくは指導員にご連絡ください。";
const stopSheet = () => sheet(`<h3>◯を付けられません</h3><p style="font-size:16px">${stopMsg()}</p><div class="list"><button class="btn primary full" data-act="close">閉じる</button></div>`);
// 第2段階で高速教習がまだの人：付けた◯では高速教習をしばらく（hwWaitWarnDays 日以上）入れられない時に知らせる
// （夜だけの人は、日没が早い期間に高速教習が入らないため。依頼者指定の文言。開いている間に1回だけ）
function hwCheck() {
  const st = S.student;
  if (S.hwWarned || st.stage !== 2 || st.hwDone || S.bookings.some(b => b.status === "confirmed" && !b.result && isHwType(b.lessonType))) return false;
  const n = hwWaitDays(S.avail);
  if (n === null || n < (CFG.hwWaitWarnDays || 14)) return false;
  S.hwWarned = true;
  sheet(`<h3>高速教習について</h3><p style="font-size:16px">${n === Infinity ? "この空き時間では高速教習を入れることができません" : `この空き時間では${n}日間高速教習を入れることができません`}　昼間に空き時間を作ってください</p>
    <div class="list"><button class="btn primary full" data-act="close">閉じる</button></div>`);
  return true;
}
const isOffSlot = (ym, k) => !!(S.off[ym] && S.off[ym].has(k));
const lockedNote = () => CFG.noRemoveAfterDeadline
  ? "締切を過ぎているため、◯を付けることはできますが、外すことはできません。都合が悪くなった場合は学園にお電話ください。"
  : "予約が入っていない枠は変更できます。";
function renderCal() {
  const { y, m } = MONTHS[S.mi]; const ym = ymOf(y, m); const set = S.avail[ym];
  let h = "";
  const filled = set.size > 0, open = !pastDeadline(ym);
  if (stopped()) h += `<div class="banner ${S.student.graduatedOn ? "ok" : "warn"}">${stopMsg()}</div>`;
  if (open && filled) h += `<div class="banner ok">${m}月分は入力済みです。締切の${dlText(ym)}までは何度でも変更できます。${CFG.noRemoveAfterDeadline ? "締切を過ぎると、◯を付けることはできますが、外すことはできなくなります。" : ""}</div>`;
  else if (open) h += `<div class="banner warn"><b>${m}月分の入力締切は${dlText(ym)}です。</b><br>空いている時間帯をタップして◯を付けてください。</div>`;
  else if (S.mi === 1 && !filled) h += `<div class="banner warn"><b>${m}月分の入力締切（${dlText(ym)}）を過ぎています。</b><br>空いている時間帯をタップして◯を付けてください。</div>`;
  else h += `<div class="banner info">${lockedNote()}タップするとすぐ保存されます。</div>`;
  // 縦が時限、横が日付（日付が多いので横にスクロール。時限の列は左に固定）
  const start = S.mi === 0 ? now.getDate() : 1;
  const dl = []; for (let d = start; d <= daysIn(y, m); d++) dl.push(d);
  h += `<div class="calhint">縦が時限、横が日付です。横にスクロールすると月末まで見られます。</div>`;
  // 月の切り替えは、表のすぐ上に出す（指導員画面の週の切り替えと同じ位置。依頼者指定）
  h += `<div class="months">${MONTHS.map((x, i) => `<button class="chip" aria-pressed="${S.mi === i}" data-act="month" data-v="${i}">${x.m}月</button>`).join("")}</div>`;
  h += `<div class="gridwrap calwrap"><table class="cal calt"><thead><tr><th class="pl"></th>`;
  const isToday = d => S.mi === 0 && d === now.getDate(), tc = (d, last) => isToday(d) ? ` class="tday${last ? " tN" : ""}"` : "";
  dl.forEach(d => { const w = new Date(y, m - 1, d).getDay(); h += `<th scope="col" class="day ${w === 6 ? "sat" : w === 0 ? "sun" : ""}${isToday(d) ? " tday t1" : ""}">${d}<small>${isToday(d) ? "今日" : WD[w]}</small></th>`; });
  // 日付の下の行：その日の全部の時限にまとめて◯を付ける／外すチェック（押すと確認を出す）
  h += `</tr><tr class="dayall"><th class="pl"><small>全部</small></th>`;
  dl.forEach(d => {
    const st = dayState(ym, y, m, d);
    h += `<td${tc(d)}><input type="checkbox" class="daychk" data-act="dayAll" data-d="${d}" ${st.all ? "checked" : ""} ${st.free.length ? "" : "disabled"} aria-label="${m}月${d}日の全部の時限"></td>`;
  });
  h += `</tr></thead><tbody>`;
  for (let p = 1; p <= 10; p++) {
    h += `<tr><th scope="row" class="pl">${p}限<small>${P[p][0]}</small></th>`;
    dl.forEach(d => {
      const ds = dateStr(new Date(y, m - 1, d));
      const b = confirmedAt(ds, p);
      if (b) {
        h += `<td${tc(d, p === 10)}><button class="cell ${b.cancelRequested ? "req" : "booked"}" data-act="locked" data-id="${b.id}" aria-label="${label(ds, p)} 予約済み">予</button></td>`;
      } else if (isOffSlot(ym, slotKey(d, p))) {
        h += `<td${tc(d, p === 10)}><button class="cell ng" data-act="offInfo" aria-label="${label(ds, p)} 指導員の都合で教習がありません">✕</button></td>`;
      } else {
        const on = set.has(slotKey(d, p));
        h += `<td${tc(d, p === 10)}><button class="cell ${on ? "on" : ""}" data-act="toggle" data-d="${d}" data-p="${p}" aria-pressed="${on}" aria-label="${label(ds, p)}">${on ? "◯" : ""}</button></td>`;
      }
    });
    h += `</tr>`;
  }
  h += `</tbody></table></div>
  <div class="legend"><span><i class="sw" style="background:var(--blue);border-color:var(--blue)"></i>空いている</span><span><i class="sw" style="background:var(--lv3-soft);border-color:var(--lv3)"></i>✕ 教習がない時間</span><span><i class="sw" style="background:var(--orange-soft);border-color:var(--orange)"></i>予約済み（変更不可）</span><span><i class="sw"></i>空いていない</span></div>
  <div class="tools">${S.mi === 1 ? `<button class="btn" data-act="copy">今月と同じにする</button>` : "<span></span>"}<button class="btn" data-act="bulk">曜日でまとめて選ぶ</button></div>`;
  return h;
}

function renderBook() {
  const t0 = dateStr(now);
  const st = S.student, min = lessonMin(st.stage, st), done = doneOf(st);
  const plan = lessonPlan(st, S.bookings.filter(b => b.status === "confirmed" && !b.result && (b.stage ?? st.stage) === st.stage));
  const noOf = b => { const it = plan.items.find(x => x.bookings.some(y => y.id === b.id)); if (!it) return ""; const k = it.units > 1 ? it.bookings.slice().sort((x, y) => x.period - y.period).findIndex(y => y.id === b.id) : 0, n = it.no + Math.max(0, k); return `${n}時限目${n > min ? "（延長）" : ""}`; };
  const up = S.bookings.filter(b => b.status === "confirmed" && !b.result && b.date >= t0).sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period);
  const can = S.bookings.filter(b => b.status === "cancelled" && b.date >= t0);
  const absent = S.bookings.filter(b => b.result === "absent").sort((a, b) => b.date.localeCompare(a.date) || a.period - b.period);
  let h = "";
  if (min) {
    const pct = Math.min(100, Math.round(done / min * 100));
    h += `<div class="prog"><div style="font-size:13px;color:var(--muted)">第${st.stage}段階の進み具合</div>
      <div><b style="font-size:22px">${done}</b> / ${min}時限<span style="font-size:12px;color:var(--muted)">（最低教習時限）</span></div>
      <div class="bar"><i class="${done > min ? "over" : ""}" style="width:${pct}%"></i></div>
      <div style="font-size:12px;color:var(--muted)">受講済み ${done}時限${plan.items.length ? `・予約済み ${plan.total - done}時限` : ""}${done >= min ? "・最低教習時限に達しました" : `・あと${min - done}時限`}</div></div>`;
  }
  const mk = mikiwameOf(st);
  if (mk && mk.passed && !kenteiOn(st) && !(mk.kenteiDate && mk.kenteiDate < t0))
    h += `<div class="banner ok">みきわめに合格しました。<br><b>検定日：${mk.kenteiDate ? md(mk.kenteiDate) : "決まり次第、指導員からお知らせします"}</b></div>`;
  if (!up.length) h += `<div class="banner info">これからの予約はまだありません。指導員が予約を確定すると、ここに表示され通知が届きます。</div>`;
  else {
    h += `<h3 style="margin-top:0">これからの予約</h3><div class="list">`;
    up.forEach(b => {
      h += `<div class="item"><div><div class="t">${label(b.date, b.period)}</div><div class="s">${noOf(b) ? `${noOf(b)}・` : ""}${P[b.period][0]}〜${P[b.period][1]}${b.lessonType === "kiken" ? `・${esc((CFG.kiken || {}).label || "危険予測")}` : b.lessonType === "hwSolo" ? `・${esc((CFG.hwSolo || {}).label || "単独高速")}` : b.highway ? "・高速教習" : ""}</div></div>${b.cancelRequested ? '<span class="tag wait">キャンセル希望中</span>' : ""}</div>`;
    });
    h += `</div>`;
  }
  if (absent.length) h += `<h3>欠席になった教習</h3><div class="hist">${absent.slice(0, 5).map(b => `<div>${label(b.date, b.period)}</div>`).join("")}</div>`;
  if (unacked()) h += `<button class="btn primary full" style="margin-top:12px" data-act="ack">確認しました</button>`;
  else if (up.length) h += `<div class="banner ok" style="margin-top:12px">確認済みです。</div>`;
  if (can.length) {
    h += `<h3>取り消しになった予約</h3><div class="hist">${can.map(b => `<div>${label(b.date, b.period)}</div>`).join("")}</div>`;
  }
  h += `<p style="font-size:12px;color:var(--muted);margin-top:16px">正式な予定はこの画面の表示です。通知はお知らせとして届きます。</p>`;
  return h;
}

// 予約ごとの「確認しました」（bookings/{id}.ackAt）
function ackBookings(ids) {
  ids.forEach(id => {
    const b = S.bookings.find(x => x.id === id); if (b) b.ackAt = { toMillis: () => Date.now() };
    updateDoc(doc(db, "students", T, "bookings", id), { ackAt: serverTimestamp() }).catch(err => toast(friendlyError(err)));
  });
}

/* ---------- 保存 ---------- */
function scheduleSave(ym) {
  clearTimeout(S.saveTimers[ym]);
  S.saveTimers[ym] = setTimeout(async () => {
    try {
      await setDoc(doc(db, "students", T, "months", ym), { slots: [...S.avail[ym]], updatedAt: serverTimestamp(), late: isLate(ym) });
    } catch (e) { toast(friendlyError(e)); }
  }, 700);
}

// その日の、予約が入っていない時限と、全部に◯が付いているか
function dayState(ym, y, m, d) {
  const ds = dateStr(new Date(y, m - 1, d));
  const free = []; for (let p = 1; p <= 10; p++) if (!confirmedAt(ds, p) && !isOffSlot(ym, slotKey(d, p))) free.push(p);
  return { ds, free, all: free.length > 0 && free.every(p => S.avail[ym].has(slotKey(d, p))) };
}
function dayAllSheet(d) {
  const { y, m } = MONTHS[S.mi], ym = ymOf(y, m), st = dayState(ym, y, m, d), on = st.all;
  if (!on && stopped()) return stopSheet();
  sheet(`<h3>${on ? "◯を全て外しますか？" : "◯を全て付けますか？"}</h3>
    <p style="font-size:16px"><b>${m}月${d}日</b>${on ? "の◯を全て外しますか？" : "に全て◯を付けますか？"}</p>
    <label class="ackchk"><input type="checkbox" id="da_chk"> はい</label>
    <div class="tools"><button class="btn" data-act="close">やめる</button><button class="btn primary" id="da_ok" data-act="dayAllOk" data-mi="${S.mi}" data-d="${d}" data-on="${on ? 1 : 0}" disabled>OK</button></div>`);
}
function removeLockedSheet(ym, d, p) {
  const [y, m] = ym.split("-").map(Number);
  sheet(`<h3>この◯は外せません</h3><p>${label(dateStr(new Date(y, m - 1, d)), p)}<br><span style="color:var(--muted);font-size:13px">締切を過ぎているため、すでに付いている◯は外せません（指導員が予約を組んでいる途中のためです）。都合が悪くなった場合は学園にお電話ください。</span></p>
    <div class="list"><a class="btn accent full center" style="text-decoration:none;display:block;line-height:22px" href="tel:${esc(CFG.schoolTel)}">学園に電話する</a><button class="btn full" data-act="close">閉じる</button></div>`);
}

/* ---------- 操作 ---------- */
function bulkSheet() {
  let h = `<h3>曜日でまとめて選ぶ（${MONTHS[S.mi].m}月）</h3><div style="font-size:13px;font-weight:700;margin-bottom:6px">曜日</div><div class="chips">`;
  [1, 2, 3, 4, 5, 6, 0].forEach(w => { h += `<button class="chip" aria-pressed="${S.bulkW.has(w)}" data-act="bw" data-v="${w}">${WD[w]}</button>`; });
  h += `</div><div style="font-size:13px;font-weight:700;margin:10px 0 6px">時限</div><div class="chips" style="flex-wrap:wrap">`;
  for (let p = 1; p <= 10; p++) h += `<button class="chip" aria-pressed="${S.bulkP.has(p)}" data-act="bp" data-v="${p}">${p}限</button>`;
  h += `</div><div class="tools" style="margin-top:14px"><button class="btn" data-act="close">閉じる</button><button class="btn primary" data-act="bulkApply">◯を付ける</button></div>`;
  sheet(h);
}

document.addEventListener("change", e => {
  if (e.target.id === "nl_chk") document.getElementById("nl_ok").disabled = !e.target.checked;
  if (e.target.id === "da_chk") document.getElementById("da_ok").disabled = !e.target.checked;
});
document.addEventListener("click", async e => {
  if (onOverlayClose(e)) return;
  const t = e.target.closest("[data-act]"); if (!t) return;
  const a = t.dataset.act;
  if (a === "tab") { S.tab = t.dataset.v; render(); window.scrollTo(0, 0); }
  else if (a === "next") showNextLesson();
  else if (a === "nextOk") {
    if (!document.getElementById("nl_chk")?.checked) return;
    closeSheet();
    // この予約を確認済みにする（指導員の予約画面のその時限に「確認済」が出る）
    ackBookings((t.dataset.ids || "").split(",").filter(Boolean));
    // 指導員の画面の「確認状況」も確認済みにする（未確認の時だけ書く）
    if (unacked()) {
      try { await updateDoc(doc(db, "students", T), { ackAt: serverTimestamp() }); S.student.ackAt = { toMillis: () => Date.now() }; render(); }
      catch (err) { toast(friendlyError(err)); }
    }
  }
  else if (a === "dayAll") { e.preventDefault(); dayAllSheet(+t.dataset.d); }
  else if (a === "dayAllOk") {
    if (!document.getElementById("da_chk")?.checked) return;
    const mi = +t.dataset.mi, d = +t.dataset.d, { y, m } = MONTHS[mi], ym = ymOf(y, m), st = dayState(ym, y, m, d);
    if (t.dataset.on === "1") {
      // 締切を過ぎた月は、この画面で付けた◯しか外せない
      const ng = st.free.filter(p => S.avail[ym].has(slotKey(d, p)) && !canRemove(ym, slotKey(d, p)));
      st.free.filter(p => !ng.includes(p)).forEach(p => S.avail[ym].delete(slotKey(d, p)));
      render(); scheduleSave(ym);
      if (!ng.length) { closeSheet(); toast(`${m}月${d}日の◯を全て外しました`); }
      else sheet(`<h3>外せない◯があります</h3><p>${m}月${d}日の <b>${ng.join("・")}限</b> は、締切を過ぎているため外せません（指導員が予約を組んでいる途中のためです）。ほかの◯は外しました。<br><span style="color:var(--muted);font-size:13px">都合が悪くなった場合は学園にお電話ください。</span></p>
        <div class="list"><a class="btn accent full center" style="text-decoration:none;display:block;line-height:22px" href="tel:${esc(CFG.schoolTel)}">学園に電話する</a><button class="btn full" data-act="close">閉じる</button></div>`);
    } else {
      if (stopped()) return stopSheet();
      st.free.forEach(p => addSlot(ym, slotKey(d, p)));
      closeSheet(); render(); scheduleSave(ym); if (!hwCheck()) toast(`${m}月${d}日の全ての時限に◯を付けました`);
    }
  }
  else if (a === "addOk") {
    if (stopped()) return stopSheet();
    const mi = +t.dataset.mi, { y, m } = MONTHS[mi], ym = ymOf(y, m), k = slotKey(+t.dataset.d, +t.dataset.p);
    closeSheet(); addSlot(ym, k); render(); scheduleSave(ym); hwCheck();
  }
  else if (a === "month") { S.mi = +t.dataset.v; render(); }
  else if (a === "offInfo") toast("この時間は指導員の都合で教習がありません");
  else if (a === "toggle") {
    const { y, m } = MONTHS[S.mi]; const ym = ymOf(y, m); const k = slotKey(+t.dataset.d, +t.dataset.p);
    if (S.avail[ym].has(k)) {
      if (!canRemove(ym, k)) return removeLockedSheet(ym, +t.dataset.d, +t.dataset.p);
      S.avail[ym].delete(k);
      render(); scheduleSave(ym);
    } else {
      if (stopped()) return stopSheet();
      // 指が触れただけで◯が付かないように、付ける前に確認する
      const ds = dateStr(new Date(y, m - 1, +t.dataset.d)), p = +t.dataset.p;
      sheet(`<h3>◯を付けますか？</h3><p style="font-size:16px"><b>${label(ds, p)}</b>（${P[p][0]}〜${P[p][1]}）に◯を付けますか？</p>
        <div class="tools"><button class="btn" data-act="close">やめる</button><button class="btn primary" data-act="addOk" data-mi="${S.mi}" data-d="${t.dataset.d}" data-p="${p}">OK</button></div>`);
    }
  }
  else if (a === "copy") {
    if (stopped()) return stopSheet();
    // 今月の曜日ごとのパターン（よく◯が付いている時限）を来月に写す
    const cur = MONTHS[0], nx = MONTHS[1]; const pat = {};
    for (let d = 1; d <= daysIn(cur.y, cur.m); d++) {
      const w = new Date(cur.y, cur.m - 1, d).getDay();
      for (let p = 1; p <= 10; p++) if (S.avail[ymOf(cur.y, cur.m)].has(slotKey(d, p))) { pat[w] = pat[w] || {}; pat[w][p] = (pat[w][p] || 0) + 1; }
    }
    const ym = ymOf(nx.y, nx.m); let n = 0;
    for (let d = 1; d <= daysIn(nx.y, nx.m); d++) {
      const w = new Date(nx.y, nx.m - 1, d).getDay();
      Object.entries(pat[w] || {}).forEach(([p, c]) => { if (c >= 2 && !isOffSlot(ym, slotKey(d, +p))) { addSlot(ym, slotKey(d, +p)); n++; } });
    }
    render(); scheduleSave(ym); if (!(n && hwCheck())) toast(n ? "今月と同じ曜日・時限に◯を付けました" : "今月の入力が少ないため、写せる予定がありませんでした");
  }
  else if (a === "bulk" && stopped()) stopSheet();
  else if (a === "bulk") { S.bulkW = new Set(); S.bulkP = new Set(); bulkSheet(); }
  else if (a === "bw") { const v = +t.dataset.v; S.bulkW.has(v) ? S.bulkW.delete(v) : S.bulkW.add(v); bulkSheet(); }
  else if (a === "bp") { const v = +t.dataset.v; S.bulkP.has(v) ? S.bulkP.delete(v) : S.bulkP.add(v); bulkSheet(); }
  else if (a === "bulkApply") {
    const { y, m } = MONTHS[S.mi]; const ym = ymOf(y, m); let n = 0;
    // 今月は今日から（過ぎた日には付けない）
    for (let d = S.mi === 0 ? now.getDate() : 1; d <= daysIn(y, m); d++) if (S.bulkW.has(new Date(y, m - 1, d).getDay())) S.bulkP.forEach(p => {
      const ds = dateStr(new Date(y, m - 1, d)); if (!confirmedAt(ds, p) && !isOffSlot(ym, slotKey(d, p))) { addSlot(ym, slotKey(d, p)); n++; }
    });
    closeSheet(); render(); if (n) scheduleSave(ym); if (!(n && hwCheck())) toast(n ? `${n}枠に◯を付けました` : "曜日と時限を選んでください");
  }
  else if (a === "locked") {
    const b = S.bookings.find(x => x.id === t.dataset.id);
    sheet(`<h3>この枠は予約済みです</h3><p>${label(b.date, b.period)}（${P[b.period][0]}〜）${b.pairId ? `<br>${esc(b.lessonType === "hwSolo" ? (CFG.hwSolo || {}).label || "単独高速" : b.lessonType === "hw3" ? (CFG.hw3 || {}).label || "高速教習" : (CFG.kiken || {}).label || "危険予測")}（${b.lessonType === "hw3" ? 3 : 2}時限連続のため、キャンセルは${b.lessonType === "hw3" ? 3 : 2}時限まとめてになります）` : ""}<br><span style="color:var(--muted);font-size:13px">予約済みの枠は、この画面からは外せません。</span></p>
      ${b.cancelRequested ? '<div class="banner warn">キャンセル希望を送信済みです。指導員の確認を待っています。</div><button class="btn full" data-act="close">閉じる</button>'
        : `<div class="list"><button class="btn accent full" data-act="reqCancel" data-id="${b.id}">キャンセル希望を送る</button><a class="btn full center" style="text-decoration:none;display:block;line-height:22px" href="tel:${esc(CFG.schoolTel)}">学園に電話する</a><button class="btn full" data-act="close">閉じる</button></div>`}`);
  }
  else if (a === "reqCancel") {
    const b = S.bookings.find(x => x.id === t.dataset.id); t.disabled = true;
    try {
      // 危険予測・高速教習は2〜3時限で1組。組の全部にキャンセル希望を付ける（1時限だけキャンセルにならないように）
      const group = b.pairId ? S.bookings.filter(x => x.pairId === b.pairId && x.status === "confirmed") : [b];
      for (const x of group) await updateDoc(doc(db, "students", T, "bookings", x.id), { cancelRequested: true, cancelRequestedAt: serverTimestamp() });
      await addDoc(collection(db, "outbox"), {
        to: "instructor", type: "cancelRequest", studentToken: T, instructorUid: S.student.instructorUid,
        title: "キャンセル希望", body: `${S.student.name}さん ${b.pairId ? `${md(b.date)} ${group.map(x => x.period).sort((m, n) => m - n).join("・")}限` : label(b.date, b.period)}`, createdAt: serverTimestamp(), sent: false
      });
      sendNow();
      group.forEach(x => { x.cancelRequested = true; }); closeSheet(); render(); toast("キャンセル希望を送りました");
    } catch (err) { toast(friendlyError(err)); t.disabled = false; }
  }
  else if (a === "ack") {
    // これからの予約をまとめて確認済みにする
    const t0 = dateStr(now);
    ackBookings(S.bookings.filter(b => b.status === "confirmed" && !b.result && !b.ackAt && b.date >= t0).map(b => b.id));
    try { await updateDoc(doc(db, "students", T), { ackAt: serverTimestamp() }); S.student.ackAt = { toMillis: () => Date.now() }; render(); toast("確認しました"); }
    catch (err) { toast(friendlyError(err)); }
  }
  else if (a === "push") {
    const ios = isIOS() && !isStandalone();
    sheet(`<h3>通知の設定</h3><p style="font-size:14px">予約が決まった時や変更があった時に、スマホに通知が届きます。</p>
      ${ios ? `<div class="banner warn">iPhoneの場合は先に、画面下の共有ボタン →「ホーム画面に追加」をしてください。追加したアイコンから開くと、通知を受け取れるようになります。</div>` : ""}
      <div class="list"><button class="btn primary full" data-act="pushOn">通知を受け取る</button><button class="btn full" data-act="close">閉じる</button></div>`);
  }
  else if (a === "pushOn") {
    t.disabled = true;
    try {
      const r = await enablePush(async tok => {
        const cur = S.student.fcmTokens || [];
        if (cur.includes(tok)) return;
        const next = [...cur, tok].slice(-CFG.maxFcmTokens);
        await updateDoc(doc(db, "students", T), { fcmTokens: next });
        S.student.fcmTokens = next;
      });
      closeSheet(); toast(r.ok ? "通知を受け取れるようになりました" : pushReasonText(r.reason));
      if (S.tab === "set") render();
    } catch (err) { closeSheet(); toast(friendlyError(err)); }
  }
});

self.__boot && self.__boot.push("student");
load();
