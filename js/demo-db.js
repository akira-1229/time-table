// =============================================================
// デモモード用の仮のデータベース（Firebaseの代わり）
// ・見本データ入り。このブラウザの中だけに保存される（他の端末とは共有されない）
// ・config.js の demo を false にすると使われなくなる
// =============================================================
const KEY = "timetable_demo_db_v5";
const SKEY = "timetable_demo_user";

export class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  static now() { return new Timestamp(Date.now()); }
}

/* ---------- 保存と読み込み ---------- */
let DB = new Map();
const enc = v => v instanceof Timestamp ? { __ts: v.ms } : Array.isArray(v) ? v.map(enc) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;
const dec = v => v && typeof v === "object" && "__ts" in v ? new Timestamp(v.__ts) : Array.isArray(v) ? v.map(dec) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)])) : v;
function persist() { try { localStorage.setItem(KEY, JSON.stringify([...DB].map(([k, v]) => [k, enc(v)]))); } catch (e) { } }
function restore() {
  try { const raw = localStorage.getItem(KEY); if (raw) { DB = new Map(JSON.parse(raw).map(([k, v]) => [k, dec(v)])); return true; } } catch (e) { }
  return false;
}
export function resetDemo() { localStorage.removeItem(KEY); sessionStorage.removeItem(SKEY); DB = new Map(); seed(); persist(); }

/* ---------- 見本データ ---------- */
export const DEMO_USERS = {
  "admin@local": { uid: "DEMO_ADMIN", name: "管理者" },
  "kumazaki@local": { uid: "DEMO_T1", name: "熊崎" },
  "toyama@local": { uid: "DEMO_T2", name: "遠山" }
};
// 教習生4人：山田・高井は熊崎指導員、島田・飯田は遠山指導員の担当
export const DEMO_STUDENTS = [
  { tok: "t-yamada", name: "山田", kana: "ヤマダ", stage: 1, instructorUid: "DEMO_T1" },
  { tok: "t-takai", name: "高井", kana: "タカイ", stage: 2, instructorUid: "DEMO_T1" },
  { tok: "t-shimada", name: "島田", kana: "シマダ", stage: 1, instructorUid: "DEMO_T2" },
  { tok: "t-iida", name: "飯田", kana: "イイダ", stage: 2, instructorUid: "DEMO_T2" }
];
const pad = n => String(n).padStart(2, "0");
function seed() {
  let x = 20261001; const r = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  DB.set("admins/DEMO_ADMIN", { note: "管理者" });
  Object.values(DEMO_USERS).filter(u => u.uid !== "DEMO_ADMIN").forEach(u =>
    DB.set(`instructors/${u.uid}`, { name: u.name, email: Object.keys(DEMO_USERS).find(k => DEMO_USERS[k] === u) }));
  const now = new Date(); const months = [0, 1].map(i => new Date(now.getFullYear(), now.getMonth() + i, 1));
  DEMO_STUDENTS.forEach((st, i) => {
    const dl = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30 + i * 25);
    DB.set(`students/${st.tok}`, {
      studentNo: String(i + 1).padStart(4, "0"), name: st.name, nameKana: st.kana, stage: st.stage, instructorUid: st.instructorUid,
      deadline: `${dl.getFullYear()}-${pad(dl.getMonth() + 1)}-${pad(dl.getDate())}`, active: true
    });
    const evening = i % 2 === 1;           // 平日は夕方以降しか来られない人
    months.forEach((m, mi) => {
      if (mi === 1 && i === 3) return;     // 次月分がまだ未入力の人
      const slots = []; const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const w = new Date(m.getFullYear(), m.getMonth(), d).getDay(); const weekday = w >= 1 && w <= 5;
        for (let p = 1; p <= 10; p++) { const base = weekday && evening ? (p >= 7 ? 0.6 : 0.05) : 0.35; if (r() < base) slots.push(`${d}-${p}`); }
      }
      DB.set(`students/${st.tok}/months/${m.getFullYear()}-${pad(m.getMonth() + 1)}`, { slots, late: false });
    });
  });
}
if (self.APP_CONFIG.demo === true && !restore()) { seed(); persist(); }

/* ---------- Firestoreのまね ---------- */
const P = s => s.join("/");
const rid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
function mkDoc(path) { const seg = path.split("/"); return { type: "doc", path, id: seg.at(-1), parent: { id: seg.at(-2), parent: { id: seg.at(-3) } } }; }
const clone = o => o == null ? o : JSON.parse(JSON.stringify(enc(o)), (k, v) => v);
const out = o => o == null ? o : dec(clone(o));
export const getFirestore = () => ({});
export function doc(first, ...segs) {
  if (first && first.type === "col" && segs.length === 0) return mkDoc(`${first.path}/${rid()}`);
  if (first && first.type === "col") return mkDoc(`${first.path}/${P(segs)}`);
  return mkDoc(P(segs));
}
export const collection = (db, ...segs) => ({ type: "col", path: P(segs) });
export const collectionGroup = (db, id) => ({ type: "group", id });
export const where = (f, op, v) => ({ f, op, v });
export const query = (c, ...w) => ({ ...c, w });
export const serverTimestamp = () => Timestamp.now();
export const arrayUnion = (...v) => ({ __union: v });
export const increment = n => ({ __inc: n });
const delay = () => new Promise(r => setTimeout(r, 60));
export async function getDoc(r) { await delay(); return { id: r.id, ref: r, exists: () => DB.has(r.path), data: () => out(DB.get(r.path)) }; }
export async function getDocs(q) { await delay(); return runQuery(q); }
function runQuery(q) {
  const res = [];
  for (const [p, d] of DB) {
    const seg = p.split("/");
    if (q.type === "col") { if (seg.slice(0, -1).join("/") !== q.path) continue; }
    else if (seg.at(-2) !== q.id || seg.length % 2) continue;
    if ((q.w || []).every(w => w.op === "==" ? (d[w.f] ?? null) === w.v : w.op === "in" ? w.v.includes(d[w.f]) : true))
      res.push({ id: seg.at(-1), ref: mkDoc(p), data: () => out(d) });
  }
  return { docs: res, size: res.length, empty: !res.length };
}
const merge = (cur, d) => { const n = { ...cur }; Object.entries(d).forEach(([k, v]) => { n[k] = v && v.__union ? [...new Set([...(cur[k] || []), ...v.__union])] : v && v.__inc !== undefined ? (cur[k] || 0) + v.__inc : v; }); return n; };
export async function setDoc(r, d) { DB.set(r.path, merge({}, d)); persist(); notify(); }
export async function updateDoc(r, d) { if (!DB.has(r.path)) throw Object.assign(new Error("not found"), { code: "not-found" }); DB.set(r.path, merge(DB.get(r.path), d)); persist(); notify(); }
export async function addDoc(c, d) { const r = mkDoc(`${c.path}/${rid()}`); DB.set(r.path, merge({}, d)); persist(); notify(); return r; }
export async function deleteDoc(r) { DB.delete(r.path); persist(); notify(); }
export function writeBatch() {
  const ops = [];
  return {
    set: (r, d) => ops.push(() => DB.set(r.path, merge({}, d))),
    update: (r, d) => ops.push(() => DB.set(r.path, merge(DB.get(r.path) || {}, d))),
    delete: r => ops.push(() => DB.delete(r.path)),
    commit: async () => { await delay(); ops.forEach(o => o()); persist(); notify(); }
  };
}

/* ---------- リアルタイム更新のまね（onSnapshot。ドキュメント1件と一覧の両方） ---------- */
// 同じタブでの書き込みに加えて、別のタブ（例：教習生の画面）での書き込みも storage イベントで拾う
const subs = new Set();
const snap = r => r.type === "doc" ? { id: r.id, ref: r, exists: () => DB.has(r.path), data: () => out(DB.get(r.path)) } : runQuery(r);
const state = r => r.type === "doc" ? JSON.stringify(enc(DB.get(r.path) ?? null))
  : JSON.stringify(runQuery(r).docs.map(d => [d.ref.path, enc(DB.get(d.ref.path))]));
function notify() {
  subs.forEach(x => {
    const v = state(x.r);
    if (v !== x.last) { x.last = v; setTimeout(() => subs.has(x) && x.cb(snap(x.r)), 0); }
  });
}
export function onSnapshot(r, cb) {
  const x = { r, cb, last: state(r) };
  subs.add(x); setTimeout(() => subs.has(x) && cb(snap(r)), 0);
  return () => subs.delete(x);
}
try { addEventListener("storage", e => { if (e.key === KEY && restore()) notify(); }); } catch (e) { }

/* ---------- ログインのまね ---------- */
let cbs = [];
const current = () => { try { const u = sessionStorage.getItem(SKEY); return u ? { uid: u } : null; } catch (e) { return null; } };
export const getAuth = () => ({});
export function onAuthStateChanged(auth, cb) { cbs.push(cb); setTimeout(() => cb(current()), 0); return () => { cbs = cbs.filter(x => x !== cb); }; }
export async function signInWithEmailAndPassword(auth, email) {
  const u = DEMO_USERS[String(email).trim().toLowerCase()];
  if (!u) throw Object.assign(new Error("user-not-found"), { code: "auth/user-not-found" });
  sessionStorage.setItem(SKEY, u.uid); cbs.forEach(cb => cb({ uid: u.uid }));
}
export async function signOut() { sessionStorage.removeItem(SKEY); cbs.forEach(cb => cb(null)); }

/* ---------- その他 ---------- */
export const initializeApp = () => ({});
export const getMessaging = () => ({});
export const getToken = async () => null;
export const isSupported = async () => false;
export const onMessage = () => () => { };
