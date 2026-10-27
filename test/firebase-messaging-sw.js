// プッシュ通知を受け取るための裏方（サービスワーカー）
// 通知の表示と、タップした時に画面を開く動きは、Firebaseが自動で行う
// ホーム画面に追加（Webアプリとしてインストール）できるようにする役目も兼ねる
importScripts("./js/config.js");
if (!self.APP_CONFIG.demo) {
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
  firebase.initializeApp(self.APP_CONFIG.firebase);
  firebase.messaging();
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
