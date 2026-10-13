// 画面が「読み込み中…」のまま止まった時の案内（古いブラウザでも動くように classic script・古い書き方で書く）
// 画面のプログラムが読み込めない／途中で止まった時に、理由と対処を表示する
(function () {
  var errs = [];
  window.addEventListener("error", function (e) {
    var t = e.target;
    errs.push(t && t !== window && (t.src || t.href) ? "読み込み失敗: " + (t.src || t.href) : (e.message || "エラー"));
  }, true);
  window.addEventListener("unhandledrejection", function (e) { errs.push(String(e.reason && e.reason.message || e.reason)); });
  setTimeout(function () {
    if (!document.getElementById("boot")) return;            // 画面が描けていれば何もしない
    var ua = navigator.userAgent, inApp = /Line\/|FBAN|FBAV|Instagram|MicroMessenger|KAKAOTALK|YJApp|; wv\)/i.test(ua);
    var ext = location.href + (location.search ? "&" : "?") + "openExternalBrowser=1";
    var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var h = '<section class="panel"><div class="body"><h2 style="margin-top:0">画面を開けませんでした</h2>'
      + (inApp ? '<p>アプリの中のブラウザ（LINEなど）で開いています。<b>Safari か Chrome で開き直して</b>ください。</p>'
        + '<p><a class="btn accent full" href="' + esc(ext) + '">ブラウザで開き直す</a></p>'
        : '<p>電波の良い所で「もう一度読み込む」を押してください。直らない時は、スマホのOS（iOS・Android）とブラウザを最新にしてください。</p>')
      + '<p><button class="btn full" onclick="location.reload()">もう一度読み込む</button></p>'
      + '<details><summary>くわしい情報（事務所に伝える用）</summary><pre style="white-space:pre-wrap;font-size:12px">'
      + esc((errs.length ? errs.join("\n") : "エラー表示なし（時間切れ）") + "\n" + ua) + '</pre></details></div></section>';
    var app = document.getElementById("app"); if (app) app.innerHTML = h;
  }, 15000);
})();
