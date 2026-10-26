// =============================================================
// 設定ファイル（セットアップ時に書き換える）
// ここに書く値は「公開してよい値」だけ。
// サービスアカウントの秘密鍵は絶対にここへ書かないこと。
// =============================================================
self.APP_CONFIG = {
  // デモモード：true の間は見本データで動く（Firebaseの設定なしで画面を確認できる）
  // Firebaseの設定が終わったら false にする
  demo: false,

  // Firebaseコンソール → プロジェクトの設定 → マイアプリ → SDKの設定と構成（構成）
  firebase: {
    apiKey: "AIzaSyCHlQ2kd2iLn1OTVXDf4VQKijvyok-riNg",
    authDomain: "shotoku-timetable.firebaseapp.com",
    projectId: "shotoku-timetable",
    storageBucket: "shotoku-timetable.firebasestorage.app",
    messagingSenderId: "9594641929",
    appId: "1:9594641929:web:fd79545ceab9e6e65de2d8"
  },
  // Cloud Messaging → ウェブプッシュ証明書 → 鍵ペア
  vapidKey: "BCUuPbX8z6un7YiOnS_fKdbDJO3NqqKTa4VA5InvPkS-nriFiKw0unpIArsNVK46OA5PVTae9kG7sMCU-lnX7RY",

  // GitHub Pagesの公開URL（最後に / を付ける）例: https://ユーザー名.github.io/time-table/
  appUrl: "https://akira-1229.github.io/time-table/",
  // 通知をすぐ送るための Apps Script のウェブアプリのURL（SETUP.md 手順9-7）。空なら1分おきの定期送信だけ
  sendNowUrl: "https://script.google.com/macros/s/AKfycbwFxjvirZ5auDgS9GfBsixWenby-LwVCc9XfQ3uYlpFyleB8AQat30dUdM_7xy-p9AL/exec",

  schoolName: "聖徳自動車学園",
  schoolTel: "058-387-4171",        // キャンセル連絡用の電話番号

  // 時限（開始〜終了）
  periods: [
    null,
    ["9:50", "10:40"], ["10:50", "11:40"], ["11:50", "12:40"],
    ["13:30", "14:20"], ["14:30", "15:20"], ["15:40", "16:30"],
    ["16:40", "17:30"], ["17:40", "18:30"], ["18:50", "19:40"],
    ["19:50", "20:40"]
  ],

  openDays: [1, 2, 3, 4, 5, 6, 0],  // 予約を入れる曜日（0=日 1=月 … 6=土）。日曜も入れる（依頼者指定）
  deadlineDay: 20,                  // 次月分の入力締切（毎月この日まで）
                                    // 教習生ごとに締切を変えられる（指導員の「教習生の管理」→編集の「空き時間の入力締切」。students/{t}.inputDeadline）
                                    //   "p25"＝前の月の25日、"pe"＝前の月の末日、"c3"＝その月の3日（月初に予定が分かる人向け）。空＝上の deadlineDay
  noRemoveAfterDeadline: true,      // 締切を過ぎた月は、◯を付けることはできるが外すことはできない（外したい時は学園に電話）
  // 学科の受講確認：この段階のこの時限目の教習を予約する時に「学科の○番を受講していないと受けられません」と確認を出す（ボタンはOKだけ）
  gakkaCheck: [
    { stage: 2, no: 10, gakka: 15 },
    { stage: 2, no: 13, gakka: 16 }   // 高速教習（第2段階13時限目）
  ],
  dailyMax: { 1: 2, 2: 3 },         // 1日に入れられる時限の上限（第1段階・第2段階）

  // 連続3時限のルール（変更があればここを書き換える）
  noTripleStages: [2],              // この段階は、連続3時限を原則禁止（例：1・2・4はOK、1・2・3はNG）
  breakAfter: [3],                  // この時限の後は休み（昼休み）があるため、連続として数えない（2・3・4や3・4・5はOK）
  lessons: {                        // 最低教習時限（これを超えると延長料金）。危険予測は2時限使うが1時限として数える。単独高速は2時限
    1: { min: 12 },                 // 第1段階は教習生ごとに変えられる（教習生の編集画面「第1段階の最低教習時限」）
    2: { min: 19, kikenNo: 12, hwNo: 13 }   // 危険予測はちょうど12時限目。高速教習はちょうど13時限目から（単独高速なら13・14、3時限なら13〜15）
  },
  // 教習生の登録フォームの選択肢（入力欄に候補として出す。候補にないものも手入力できる。仮の候補）
  licenseTypes: ["普通車AT", "普通車MT", "準中型", "中型", "大型", "普通二輪AT", "普通二輪MT", "大型二輪", "大型特殊", "けん引"],
  heldLicenseTypes: ["なし", "原付", "小型特殊", "普通車AT", "普通車MT", "準中型", "中型", "大型", "普通二輪", "大型二輪"],
  karimenMonths: 6,                 // 仮免許の有効期間（交付日から6ヶ月。仮免期限日を自動で入れる）
  expiryWarnDays: 30,               // 教習期限・仮免期限が、この日数以内に迫った教習生を指導員画面に出す
  // 教習期限・仮免期限の通知（教習生本人と担当指導員へ、朝9時）は Apps Script のスクリプトプロパティ EXPIRY_ALERT で決める（省略時 2m,1m,2w＝2ヶ月前・1ヶ月前・2週間前）
  specialStages: [2],               // 高速教習・危険予測・単独高速がある段階（第1段階には無い）
  kiken: {                          // 危険予測（2時限連続の特別な教習）
    label: "危険予測",
    noPairAfter: [3, 5, 8],         // この時限の後に昼休み・20分休憩があるため、ここをまたぐ2時限連続は不可（3・4、5・6、8・9）
    capacity: 2                     // 同じ時限の危険予測に一緒に入れる人数（依頼者指定）
  },
  hwSolo: {                         // 単独高速（1人で高速教習を2時限連続。単独でも入れられる）
    label: "単独高速",
    noPairAfter: [3, 8]             // 3・4（昼休み）と 8・9（季節に関係なく）は不可。5・6 はOK
  },
  hw3: {                            // 高速教習（3時限連続）。入れられる組み合わせは下の highwaySets、日没が早い期間の警告は darkSeason.sets
    label: "高速教習",
    capacity: 3                     // 同じ時限の高速教習（3時限）に一緒に入れる人数（依頼者指定）
  },
  pairCombos: [                     // 危険予測のすぐ後に単独高速を入れてよい組み合わせ（この日だけ1日4時限・連続でもOK）
    { kiken: 4, hwSolo: 6 }         // 危険予測 4・5限 → 単独高速 6・7限（順番は危険予測→単独高速のみ）
  ],
  highwaySets: [                    // 高速教習（3時限）を入れてよい組み合わせ（連続3時限はこれだけ）
    [1, 2, 3], [4, 5, 6], [5, 6, 7], [6, 7, 8]
  ],
  darkSeason: {                     // 日没が早い期間は、この組み合わせを警告（強制で入れることは可能）
    from: "10-03", to: "02-15",     // 月-日（年をまたぐ指定もOK）
    sets: [[6, 7, 8]],
    hwSoloSets: [[7, 8]],           // 単独高速は 7・8 を警告（8・9 は季節に関係なく入れられない）
    hwSoloNo: [[9, 10]]             // 単独高速の 9・10 はこの期間は入れられない（強制も不可）
  },
  accessKeepDays: 90,               // アクセス記録を残す日数（表示用。実際に消すのは Apps Script のスクリプトプロパティ ACCESS_KEEP_DAYS。そろえておく）
  maxFcmTokens: 5
};
