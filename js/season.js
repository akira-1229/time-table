// 起動時の読み込み画面の季節の背景（回るロゴの後ろ）。日付で季節を選び、絵（img/season-*.svg）と動き（canvas）を重ねる
// 10〜11月：紅葉が散る＋お月見／12〜2月：雪＋クリスマス／3〜4月：桜が散る＋富士山／5〜6月：鯉のぼり＋新緑の山々／7〜9月：花火＋夕暮れの浜辺と入道雲
// 確認用に ?season=aki などで季節を指定できる。読み込み画面が消えたら動きも止める
(function () {
  var sp = document.getElementById("splash"); if (!sp) return;
  var q = /[?&]season=(aki|fuyu|haru|satsuki|natsu)\b/.exec(location.search), m = new Date().getMonth() + 1;
  var name = q ? q[1] : m >= 10 && m <= 11 ? "aki" : m === 12 || m <= 2 ? "fuyu" : m <= 4 ? "haru" : m <= 6 ? "satsuki" : "natsu";
  var src = "img/season-" + name + ".svg";
  var bg = document.createElement("img"); bg.className = "sp-bg"; bg.src = src; bg.alt = "";
  var sc = document.createElement("div"); sc.className = "sp-scene";
  var im = document.createElement("img"); im.src = src; im.alt = "";
  var cv = document.createElement("canvas");
  sc.appendChild(im); sc.appendChild(cv);
  sp.insertBefore(sc, sp.firstChild); sp.insertBefore(bg, sc);
  sp.className = (sp.className ? sp.className + " " : "") + "season";
  if (!cv.getContext) return;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rnd = (a, b) => a + Math.random() * (b - a);

  // 季節ごとの動き：絵と同じ 220×464 の座標で描く。init(w,h) で粒を作り、step(ctx,w,h,t) で1コマ描く
  const S = {
    aki() { // 紅葉が散る
      const cols = ["#d9452b", "#e8742a", "#f0a830", "#b8322a", "#c95a24"];
      const ps = []; const add = (w, h, top) => ps.push({ x: rnd(0, w), y: top ? rnd(-40, -10) : rnd(0, h), s: rnd(5, 9), r: rnd(0, 6.28), vr: rnd(-.04, .04), vy: rnd(.5, 1.1), ph: rnd(0, 6.28), c: cols[ps.length % cols.length] });
      return { init(w, h) { for (let i = 0; i < 26; i++) add(w, h); }, step(c, w, h, t) {
        ps.forEach(p => { p.y += p.vy; p.x += Math.sin(t / 900 + p.ph) * .6; p.r += p.vr; if (p.y > h + 20) { p.y = -20; p.x = rnd(0, w); }
          c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.scale(1, Math.abs(Math.cos(t / 700 + p.ph)) * .6 + .4); c.fillStyle = p.c; c.beginPath();
          for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5, b = a + Math.PI / 5; c.lineTo(Math.cos(a) * p.s, Math.sin(a) * p.s); c.lineTo(Math.cos(b) * p.s * .45, Math.sin(b) * p.s * .45); }
          c.closePath(); c.fill(); c.restore(); });
      } };
    },
    fuyu() { // 雪が降る
      const ps = [];
      return { init(w, h) { for (let i = 0; i < 70; i++) ps.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(.8, 2.6), vy: rnd(.3, .9), ph: rnd(0, 6.28) }); }, step(c, w, h, t) {
        c.fillStyle = "#fff"; ps.forEach(p => { p.y += p.vy; p.x += Math.sin(t / 1200 + p.ph) * .3; if (p.y > h + 4) { p.y = -4; p.x = rnd(0, w); }
          c.globalAlpha = .55 + p.r / 6; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.28); c.fill(); }); c.globalAlpha = 1;
      } };
    },
    haru() { // 桜が散る
      const ps = [];
      return { init(w, h) { for (let i = 0; i < 34; i++) ps.push({ x: rnd(0, w), y: rnd(0, h), s: rnd(3.5, 6), r: rnd(0, 6.28), vy: rnd(.4, .9), vx: rnd(.2, .6), ph: rnd(0, 6.28) }); }, step(c, w, h, t) {
        ps.forEach(p => { p.y += p.vy; p.x += p.vx + Math.sin(t / 800 + p.ph) * .5; p.r += .02; if (p.y > h + 10 || p.x > w + 10) { p.y = rnd(-30, -5); p.x = rnd(-30, w); }
          c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.scale(Math.abs(Math.cos(t / 600 + p.ph)) * .7 + .3, 1);
          c.fillStyle = "#f9c8d6"; c.beginPath(); c.moveTo(0, -p.s); c.quadraticCurveTo(p.s, -p.s * .2, 0, p.s); c.quadraticCurveTo(-p.s, -p.s * .2, 0, -p.s); c.fill();
          c.fillStyle = "#f1a3ba"; c.beginPath(); c.arc(0, p.s * .6, p.s * .22, 0, 6.28); c.fill(); c.restore(); });
      } };
    },
    satsuki() { // 鯉のぼりがなびく（竿は絵、魚と吹き流しを毎コマ描く）
      const fish = [{ c: "#2b2b33", b: "#4a4a55", len: 88, y: 58 }, { c: "#d8413a", b: "#f07a6a", len: 76, y: 88 }, { c: "#2f6fd0", b: "#6ea3f0", len: 64, y: 116 }];
      return { init() {}, step(c, w, h, t) {
        const sx = w * 38 / 220, k = w / 220;
        // 吹き流し
        ["#e94b3c", "#f4c542", "#3aa35b", "#2f6fd0", "#fff"].forEach((col, i) => {
          c.strokeStyle = col; c.lineWidth = 3 * k; c.beginPath();
          for (let x = 0; x <= 80; x += 4) { const yy = (38 + i * 3.2) * k + Math.sin(t / 260 - x / 14) * (x / 80) * 7 * k; x ? c.lineTo(sx + x * k, yy) : c.moveTo(sx, yy); } c.stroke(); });
        fish.forEach((f, n) => {
          const top = [], bot = [], L = f.len * k, H = 11 * k, y0 = f.y * k;
          for (let x = 0; x <= f.len; x += 3) { const a = x / f.len, wv = Math.sin(t / 240 - x / 16 + n) * a * 8 * k, hh = H * (1 - a * .35); top.push([sx + x * k, y0 + wv - hh]); bot.push([sx + x * k, y0 + wv + hh]); }
          c.fillStyle = f.c; c.beginPath(); top.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
          const [tx, ty] = top[top.length - 1], [bx, by] = bot[bot.length - 1], mx = (tx + bx) / 2, my = (ty + by) / 2;
          c.lineTo(tx + 10 * k, ty - 4 * k); c.lineTo(mx + 2 * k, my); c.lineTo(bx + 10 * k, by + 4 * k);
          bot.slice().reverse().forEach(([x, y]) => c.lineTo(x, y)); c.closePath(); c.fill();
          c.strokeStyle = f.b; c.lineWidth = 1.2 * k; // うろこ
          for (let x = 18; x < f.len - 10; x += 10) { const a = x / f.len, wv = Math.sin(t / 240 - x / 16 + n) * a * 8 * k; c.beginPath(); c.arc(sx + x * k, y0 + wv, H * .55 * (1 - a * .35), -1.2, 1.2); c.stroke(); }
          c.fillStyle = "#fff"; c.beginPath(); c.arc(sx + 7 * k, y0 - 3 * k, 4 * k, 0, 6.28); c.fill(); c.fillStyle = "#111"; c.beginPath(); c.arc(sx + 7 * k, y0 - 3 * k, 2 * k, 0, 6.28); c.fill();
        });
      } };
    },
    natsu() { // 花火が上がる
      const rockets = [], sparks = [], cols = ["#ff5a5a", "#ffd34d", "#6fd3ff", "#b88cff", "#7dff9a", "#ff9ad5"];
      let next = 0;
      return { init() {}, step(c, w, h, t) {
        if (t > next) { rockets.push({ x: rnd(w * .15, w * .85), y: h * .64, vy: -rnd(3.2, 4), ty: rnd(h * .08, h * .26), c: cols[Math.floor(rnd(0, cols.length))] }); next = t + rnd(700, 1400); }
        c.globalCompositeOperation = "lighter";
        for (let i = rockets.length - 1; i >= 0; i--) { const r = rockets[i]; r.y += r.vy; r.vy *= .99; c.fillStyle = "#fff4c8"; c.beginPath(); c.arc(r.x, r.y, 1.6, 0, 6.28); c.fill();
          if (r.y <= r.ty) { const n = 46; for (let k = 0; k < n; k++) { const a = k / n * 6.28, sp = rnd(1.2, 2.2); sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: r.c }); } rockets.splice(i, 1); } }
        for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.x += s.vx; s.y += s.vy; s.vx *= .98; s.vy = s.vy * .98 + .025; s.life -= .012;
          if (s.life <= 0) { sparks.splice(i, 1); continue; } c.globalAlpha = s.life; c.fillStyle = s.c; c.beginPath(); c.arc(s.x, s.y, 2, 0, 6.28); c.fill();
          }
        c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
      } };
    }
  };


  var ctx = cv.getContext("2d"), sim = S[name](), W = 220, H = 464;
  function size() {                                          // 絵（下そろえで画面いっぱい）と同じ位置・倍率にそろえる
    var w = sc.clientWidth, h = sc.clientHeight, d = Math.min(2, window.devicePixelRatio || 1), k = Math.max(w / W, h / H);
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    ctx.setTransform(d * k, 0, 0, d * k, d * (w - W * k) / 2, d * (h - H * k));
  }
  size(); sim.init(W, H); window.addEventListener("resize", size);
  var speed = reduce ? .35 : 1, t = 0, last = performance.now();
  (function loop(now) {
    if (!sp.parentNode) { window.removeEventListener("resize", size); return; }
    t += Math.min(50, now - last) * speed; last = now;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore();
    sim.step(ctx, W, H, t); requestAnimationFrame(loop);
  })(last);
})();
