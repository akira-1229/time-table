// 本番（Firebase）とデモモード（見本データ）を切り替える窓口
// config.js の demo が true ならデモ用の仮データベース、false ならFirebaseを使う
// iPhoneのSafariで止まることがあるため、top-level await（読み込みを待つ書き方）は使わず、両方とも普通に読み込んで選ぶ
import * as demoMod from "./demo-db.js";
import * as appFb from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import * as fsFb from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as authFb from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import * as msgFb from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
export const DEMO = self.APP_CONFIG.demo === true;

const demo = DEMO ? demoMod : null;
const appMod = demo || appFb, fsMod = demo || fsFb, authMod = demo || authFb, msgMod = demo || msgFb;

export const { initializeApp } = appMod;
export const {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection, collectionGroup,
  query, where, orderBy, limit, serverTimestamp, writeBatch, Timestamp, onSnapshot, increment
} = fsMod;
export const { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } = authMod;
export const { getMessaging, getToken, isSupported, onMessage } = msgMod;
export const resetDemo = demo ? demo.resetDemo : () => { };
export const DEMO_USERS = demo ? demo.DEMO_USERS : {};
export const DEMO_STUDENTS = demo ? demo.DEMO_STUDENTS : [];
self.__boot && self.__boot.push("backend");
