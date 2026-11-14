/* ============================================
   Verdant TG Mini App — Fully Functional
   Firebase + Telegram WebApp
   ============================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  addDoc,
  serverTimestamp,
  increment,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ---------- Config ----------
const firebaseConfig = window.FIREBASE_CONFIG;

// ---------- State ----------
let app, auth, db;
let currentUser = null;       // Firebase Auth user
let userData = null;          // Firestore user doc
let telegramUser = null;      // TG WebApp user
let pendingReferralCode = null; // from start_param (ref_XXXX)
let tasks = [];
let isReady = false;

// Referral reward given to referrer when new user completes first task
const REFERRAL_REWARD = 0.50;

// ---------- Session Cache (fast page switches) ----------
const CACHE_USER = "verdant_user_v1";
const CACHE_TASKS = "verdant_tasks_v1";
const CACHE_TTL_MS = 120000; // 2 minutes

function saveCache() {
  try {
    if (userData && !userData._offline) {
      const safe = { ...userData };
      // strip non-serializable Firestore timestamps for cache
      if (safe.createdAt && typeof safe.createdAt === "object") safe.createdAt = null;
      if (safe.updatedAt && typeof safe.updatedAt === "object") safe.updatedAt = null;
      sessionStorage.setItem(CACHE_USER, JSON.stringify({ t: Date.now(), data: safe }));
    }
    if (tasks && tasks.length) {
      sessionStorage.setItem(CACHE_TASKS, JSON.stringify({ t: Date.now(), data: tasks }));
    }
  } catch (e) {}
}

function loadCacheUser() {
  try {
    const raw = sessionStorage.getItem(CACHE_USER);
    if (!raw) return null;
    const { t, data } = JSON.parse(raw);
    if (!data || Date.now() - t > CACHE_TTL_MS) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function loadCacheTasks() {
  try {
    const raw = sessionStorage.getItem(CACHE_TASKS);
    if (!raw) return null;
    const { t, data } = JSON.parse(raw);
    if (!data || !Array.isArray(data) || Date.now() - t > CACHE_TTL_MS) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// ---------- Toast ----------
function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}
window.showToast = showToast;

// ---------- Helpers ----------
function formatMoney(n) {
  const num = Number(n) || 0;
  const parts = num.toFixed(2).split(".");
  return { whole: parts[0], decimal: parts[1] };
}

function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000 && now.getDate() === d.getDate()) {
    return "Today · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 172800000) {
    return "Yesterday · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) +
    " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function todayKey() {
  return new Date().toDateString();
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getInitials(name) {
  if (!name) return "?";
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

// ---------- Telegram ----------
function initTelegram() {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    try { tg.ready(); } catch (e) {}
    try { tg.expand(); } catch (e) {}
    try {
      tg.setHeaderColor("#f5f4ed");
      tg.setBackgroundColor("#f5f4ed");
    } catch (e) {}
    // Prefer initDataUnsafe.user (available inside Telegram)
    telegramUser = tg.initDataUnsafe?.user || null;
    if (!telegramUser && tg.initData) {
      // Fallback: sometimes only initData string is present
      try {
        const params = new URLSearchParams(tg.initData);
        const raw = params.get("user");
        if (raw) telegramUser = JSON.parse(raw);
      } catch (e) {}
    }

    // Capture referral start_param (e.g. "ref_ABC123")
    let startParam = tg.initDataUnsafe?.start_param || null;
    if (!startParam && tg.initData) {
      try {
        const params = new URLSearchParams(tg.initData);
        startParam = params.get("start_param");
      } catch (e) {}
    }
    if (startParam && typeof startParam === "string" && startParam.startsWith("ref_")) {
      pendingReferralCode = startParam.slice(4).trim().toUpperCase();
      console.log("[Verdant] Referral code from start:", pendingReferralCode);
    }

    if (telegramUser) {
      console.log("[Verdant] Telegram user:", telegramUser.id, telegramUser.first_name, telegramUser.username);
    } else {
      console.warn("[Verdant] No Telegram user data (open inside Telegram Mini App)");
    }
  }
  return telegramUser;
}

// ---------- Firebase Init ----------
async function initFirebase() {
  if (!firebaseConfig || firebaseConfig.apiKey === "YOUR_API_KEY") {
    console.warn("Firebase not configured. Using offline demo mode.");
    return false;
  }
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    return true;
  } catch (e) {
    console.error("Firebase init error:", e);
    return false;
  }
}

// ---------- User ----------
async function ensureUser() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    // Fast fail so first open does not hang on slow networks
    const timer = setTimeout(() => {
      console.error("Auth timeout");
      finish(null);
    }, 4000);

    onAuthStateChanged(auth, async (user) => {
      try {
        if (user) {
          currentUser = user;
          await loadOrCreateUserDoc(user.uid);
          clearTimeout(timer);
          finish(user);
        } else {
          try {
            const cred = await signInAnonymously(auth);
            currentUser = cred.user;
            await loadOrCreateUserDoc(cred.user.uid);
            clearTimeout(timer);
            finish(cred.user);
          } catch (e) {
            console.error("Auth error:", e?.code || e, e?.message || e);
            clearTimeout(timer);
            finish(null);
          }
        }
      } catch (e) {
        console.error("ensureUser error:", e);
        clearTimeout(timer);
        finish(null);
      }
    });
  });
}


function buildOfflineUser() {
  return {
    firstName: telegramUser?.first_name || "Guest",
    lastName: telegramUser?.last_name || "",
    username: telegramUser?.username || "",
    photoUrl: telegramUser?.photo_url || "",
    telegramId: telegramUser?.id || null,
    balance: 0,
    pending: 0,
    lifetime: 0,
    withdrawn: 0,
    tasksCompleted: 0,
    streak: 0,
    lastCheckin: null,
    referralCode: generateRefCode(),
    referrals: 0,
    referralEarnings: 0,
    _offline: true
  };
}

async function findUserByReferralCode(code) {
  if (!db || !code) return null;
  try {
    const q = query(collection(db, "users"), where("referralCode", "==", code), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  } catch (e) {
    console.error("findUserByReferralCode error:", e);
    return null;
  }
}

async function loadOrCreateUserDoc(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const tg = telegramUser;

  if (snap.exists()) {
    userData = { id: uid, ...snap.data() };

    // Always sync latest Telegram profile (name / username / photo)
    const patch = {};
    if (tg?.id) patch.telegramId = tg.id;
    if (tg?.first_name) patch.firstName = tg.first_name;
    if (tg?.last_name !== undefined && tg?.last_name !== null) patch.lastName = tg.last_name || "";
    if (tg?.username) patch.username = tg.username;
    if (tg?.photo_url) patch.photoUrl = tg.photo_url;
    if (!userData.referralCode || userData.referralCode === "------" || userData.referralCode === "GUEST1") {
      patch.referralCode = generateRefCode();
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = serverTimestamp();
      await updateDoc(ref, patch);
      userData = { ...userData, ...patch };
    }
  } else {
    // New user — try to apply referral
    let referredByUid = null;
    if (pendingReferralCode) {
      const referrer = await findUserByReferralCode(pendingReferralCode);
      if (referrer && referrer.id !== uid) {
        // Prevent self-referral
        referredByUid = referrer.id;
        console.log("[Verdant] New user referred by:", referrer.id, pendingReferralCode);
      } else {
        console.warn("[Verdant] Invalid or self referral code:", pendingReferralCode);
      }
    }

    const newUser = {
      uid,
      telegramId: tg?.id || null,
      firstName: tg?.first_name || "User",
      lastName: tg?.last_name || "",
      username: tg?.username || "",
      photoUrl: tg?.photo_url || "",
      balance: 0,
      pending: 0,
      lifetime: 0,
      withdrawn: 0,
      tasksCompleted: 0,
      streak: 0,
      lastCheckin: null,
      lastActiveDate: null,
      referralCode: generateRefCode(),
      referredBy: referredByUid,
      referralRewarded: false,   // becomes true after first-task reward is given
      referrals: 0,
      referralEarnings: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    await setDoc(ref, newUser);
    userData = { id: uid, ...newUser };
  }

  // Update streak logic
  await updateStreak();
  saveCache();
}

function generateRefCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function updateStreak() {
  if (!userData || !db) return;
  const today = todayKey();
  const last = userData.lastActiveDate;

  if (last === today) return; // already active today

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = yesterday.toDateString();

  let newStreak = 1;
  if (last === yKey) {
    newStreak = (userData.streak || 0) + 1;
  }

  await updateDoc(doc(db, "users", userData.id), {
    streak: newStreak,
    lastActiveDate: today,
    updatedAt: serverTimestamp()
  });
  userData.streak = newStreak;
  userData.lastActiveDate = today;
}

// ---------- Tasks ----------
async function loadTasks() {
  if (!db) {
    tasks = [];
    return tasks;
  }
  try {
    let snap;
    try {
      const q = query(collection(db, "tasks"), where("active", "==", true), orderBy("order", "asc"));
      snap = await getDocs(q);
    } catch (idxErr) {
      // Missing composite index — fallback without orderBy
      console.warn("Tasks index missing, loading without order:", idxErr.code);
      const q2 = query(collection(db, "tasks"), where("active", "==", true));
      snap = await getDocs(q2);
    }
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (e) {
    console.error("Load tasks error:", e);
    tasks = [];
  }
  saveCache();
  return tasks;
}

// No built-in demo tasks — admin creates real tasks from panel
function getDefaultTasks() {
  return [];
}

async function getCompletedTaskIds() {
  if (!db || !userData) return new Set();
  try {
    const q = query(
      collection(db, "users", userData.id, "completedTasks"),
      where("date", "==", todayKey())
    );
    const snap = await getDocs(q);
    return new Set(snap.docs.map(d => d.data().taskId));
  } catch (e) {
    return new Set();
  }
}

async function hasPendingSubmission(taskId) {
  if (!db || !userData) return false;
  try {
    const q = query(
      collection(db, "submissions"),
      where("uid", "==", userData.id),
      where("taskId", "==", taskId),
      where("status", "==", "pending")
    );
    const snap = await getDocs(q);
    return !snap.empty;
  } catch (e) {
    return false;
  }
}

async function giveReferralRewardIfNeeded() {
  // Called after a task is successfully completed.
  // Gives REFERRAL_REWARD to the referrer when this user finishes their first task.
  if (!db || !userData || userData._offline) return;
  if (!userData.referredBy) return;
  if (userData.referralRewarded) return;
  if ((userData.tasksCompleted || 0) !== 1) return; // only on the very first task

  try {
    const referrerRef = doc(db, "users", userData.referredBy);
    const referrerSnap = await getDoc(referrerRef);
    if (!referrerSnap.exists()) return;

    // Credit referrer
    await updateDoc(referrerRef, {
      balance: increment(REFERRAL_REWARD),
      lifetime: increment(REFERRAL_REWARD),
      referrals: increment(1),
      referralEarnings: increment(REFERRAL_REWARD),
      updatedAt: serverTimestamp()
    });

    await addDoc(collection(db, "users", userData.referredBy, "transactions"), {
      type: "earn",
      title: "Referral bonus",
      amount: REFERRAL_REWARD,
      icon: "🤝",
      createdAt: serverTimestamp()
    });

    // Mark this user as already rewarded so we never pay twice
    await updateDoc(doc(db, "users", userData.id), {
      referralRewarded: true,
      updatedAt: serverTimestamp()
    });
    userData.referralRewarded = true;

    console.log("[Verdant] Referral reward $", REFERRAL_REWARD, "sent to", userData.referredBy);
  } catch (e) {
    console.error("giveReferralRewardIfNeeded error:", e);
  }
}

async function completeTask(taskId) {
  if (!db || !userData || userData._offline) {
    showToast("Firebase Auth off — enable Anonymous login");
    return false;
  }

  const task = tasks.find(t => t.id === taskId);
  if (!task) return false;

  const completed = await getCompletedTaskIds();
  if (completed.has(taskId)) {
    showToast("Already completed today");
    return false;
  }

  try {
    await addDoc(collection(db, "users", userData.id, "completedTasks"), {
      taskId,
      title: task.title,
      reward: task.reward,
      date: todayKey(),
      completedAt: serverTimestamp()
    });

    await addDoc(collection(db, "users", userData.id, "transactions"), {
      type: "earn",
      title: task.title,
      amount: task.reward,
      icon: task.icon || "✳",
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, "users", userData.id), {
      balance: increment(task.reward),
      lifetime: increment(task.reward),
      tasksCompleted: increment(1),
      updatedAt: serverTimestamp()
    });

    userData.balance = (userData.balance || 0) + task.reward;
    userData.lifetime = (userData.lifetime || 0) + task.reward;
    userData.tasksCompleted = (userData.tasksCompleted || 0) + 1;
    saveCache();

    // Give referral reward to referrer on first completed task
    await giveReferralRewardIfNeeded();

    showToast(`+$${Number(task.reward).toFixed(2)} earned!`);
    return true;
  } catch (e) {
    console.error("Complete task error:", e);
    showToast("Error completing task");
    return false;
  }
}

function isAccountTask(task) {
  const t = (task?.type || "").toLowerCase();
  const c = (task?.category || "").toLowerCase();
  return t === "gmail" || t === "facebook" || t === "instagram" || c === "account";
}

function accountProofLabel(task) {
  const t = (task?.type || "").toLowerCase();
  if (t === "gmail") return { user: "Gmail address", userPh: "name@gmail.com" };
  if (t === "facebook") return { user: "Facebook username / email", userPh: "username or email" };
  if (t === "instagram") return { user: "Instagram username", userPh: "@username" };
  return { user: "Username / email", userPh: "username or email" };
}

async function submitProof(taskId, proofPayload) {
  if (!db || !userData || userData._offline) {
    showToast("Firebase Auth off — enable Anonymous login");
    return false;
  }
  const task = tasks.find(t => t.id === taskId);
  if (!task) return false;

  const completed = await getCompletedTaskIds();
  if (completed.has(taskId)) {
    showToast("Already completed today");
    return false;
  }
  if (await hasPendingSubmission(taskId)) {
    showToast("Already submitted — waiting for review");
    return false;
  }

  let proof = "";
  let proofData = null;

  if (proofPayload && typeof proofPayload === "object") {
    const firstName = (proofPayload.firstName || "").trim();
    const lastName = (proofPayload.lastName || "").trim();
    const username = (proofPayload.username || "").trim();
    const password = (proofPayload.password || "").trim();
    if (!firstName || !lastName || !username || !password) {
      showToast("Fill first name, last name, username/email & password");
      return false;
    }
    proofData = { firstName, lastName, username, password, platform: task.type || "account" };
    proof = `Name: ${firstName} ${lastName}\nUser: ${username}\nPass: ${password}`;
  } else {
    proof = String(proofPayload || "").trim();
    if (!proof) {
      showToast("Please enter proof");
      return false;
    }
  }

  try {
    const docData = {
      uid: userData.id,
      taskId,
      taskTitle: task.title,
      reward: task.reward,
      proof,
      status: "pending",
      date: todayKey(),
      createdAt: serverTimestamp(),
      userName: [userData.firstName, userData.lastName].filter(Boolean).join(" ") || userData.username || "User"
    };
    if (proofData) docData.proofData = proofData;
    await addDoc(collection(db, "submissions"), docData);
    showToast("Submitted — waiting for approval");
    return true;
  } catch (e) {
    console.error("Submit proof error:", e);
    showToast("Error submitting proof");
    return false;
  }
}

function ensureTaskModal() {
  if (document.getElementById("task-modal-overlay")) return;
  const div = document.createElement("div");
  div.id = "task-modal-overlay";
  div.className = "modal-overlay";
  div.innerHTML = `<div class="modal" id="task-modal"><div class="modal-handle"></div><div id="task-modal-body"></div></div>`;
  div.addEventListener("click", (e) => {
    if (e.target === div) closeTaskModal();
  });
  document.body.appendChild(div);
}

function closeTaskModal() {
  const el = document.getElementById("task-modal-overlay");
  if (el) el.classList.remove("open");
}

function openTaskModal(html) {
  ensureTaskModal();
  document.getElementById("task-modal-body").innerHTML = html;
  document.getElementById("task-modal-overlay").classList.add("open");
}

function stepsHTML(steps) {
  if (!steps || !String(steps).trim()) return "";
  const lines = String(steps).split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `<div class="task-steps"><h4>How to complete</h4><ol>${lines.map(l => `<li>${l.replace(/^\d+[\.\)]\s*/, "")}</li>`).join("")}</ol></div>`;
}

async function openTaskDetail(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  const completed = await getCompletedTaskIds();
  const isDone = completed.has(taskId);
  const pending = !isDone && task.proofRequired ? await hasPendingSubmission(taskId) : false;

  const typeLabel = {
    visit: "Visit link", join: "Join channel", watch: "Watch video",
    survey: "Survey", quiz: "Quiz", social: "Social",
    gmail: "Gmail", facebook: "Facebook", instagram: "Instagram",
    other: "Task"
  }[task.type] || task.category || "Task";

  const accountMode = isAccountTask(task);
  const labels = accountProofLabel(task);

  let actionArea = "";
  if (isDone) {
    actionArea = `<div class="task-done-banner">✓ Completed today</div>`;
  } else if (pending) {
    actionArea = `<div class="task-pending-banner">⏳ Submitted — waiting for admin review</div>`;
  } else if (task.proofRequired && accountMode) {
    actionArea = `
      <div class="account-proof">
        <p class="account-proof-hint">${task.proofHint || "Enter the account details you created."}</p>
        <div class="form-row-2">
          <div class="form-field">
            <label>First name</label>
            <input id="proof-first" type="text" autocomplete="off" placeholder="First name">
          </div>
          <div class="form-field">
            <label>Last name</label>
            <input id="proof-last" type="text" autocomplete="off" placeholder="Last name">
          </div>
        </div>
        <div class="form-field">
          <label>${labels.user}</label>
          <input id="proof-user" type="text" autocomplete="off" placeholder="${labels.userPh}">
        </div>
        <div class="form-field">
          <label>Password</label>
          <input id="proof-pass" type="text" autocomplete="off" placeholder="Account password">
        </div>
      </div>
      ${task.link ? `<a class="btn-primary" href="${task.link}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-bottom:10px;text-decoration:none">Open link →</a>` : ""}
      <button class="btn-primary" id="btn-submit-proof" style="width:100%">Submit for review</button>
      <button class="btn-secondary" id="btn-close-task" style="width:100%;margin-top:8px">Close</button>`;
  } else if (task.proofRequired) {
    actionArea = `
      <div class="form-field">
        <label>${task.proofHint || "Submit proof"}</label>
        <textarea id="proof-input" rows="3" placeholder="Enter proof text..." style="width:100%;padding:12px;border:1px solid var(--border);border-radius:12px;font:inherit;resize:vertical"></textarea>
      </div>
      ${task.link ? `<a class="btn-primary" href="${task.link}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-bottom:10px;text-decoration:none">Open link →</a>` : ""}
      <button class="btn-primary" id="btn-submit-proof" style="width:100%">Submit for review</button>
      <button class="btn-secondary" id="btn-close-task" style="width:100%;margin-top:8px">Close</button>`;
  } else {
    actionArea = `
      ${task.link ? `<a class="btn-primary" href="${task.link}" target="_blank" rel="noopener" id="btn-open-link" style="display:block;text-align:center;margin-bottom:10px;text-decoration:none">Open ${typeLabel} →</a>` : ""}
      <button class="btn-primary" id="btn-mark-done" style="width:100%">I completed this · +$${Number(task.reward).toFixed(2)}</button>
      <button class="btn-secondary" id="btn-close-task" style="width:100%;margin-top:8px">Close</button>`;
  }

  openTaskModal(`
    <div class="task-detail-icon ${task.iconClass || ""}">${task.icon || "✳"}</div>
    <h3>${task.title}</h3>
    <p>${task.description || ""}</p>
    <div class="task-detail-reward">+$${Number(task.reward).toFixed(2)}</div>
    <div class="task-detail-meta">
      <span>◷ ${task.duration || "—"}</span>
      <span>${task.level || "Easy"}</span>
      <span>${typeLabel}</span>
      ${task.proofRequired ? "<span>· Proof needed</span>" : ""}
    </div>
    ${stepsHTML(task.steps)}
    ${actionArea}
  `);

  document.getElementById("btn-close-task")?.addEventListener("click", closeTaskModal);

  document.getElementById("btn-mark-done")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-mark-done");
    btn.disabled = true;
    btn.textContent = "...";
    const ok = await completeTask(taskId);
    if (ok) {
      closeTaskModal();
      const page = (location.pathname.split("/").pop() || "index.html").split("?")[0];
      if (page === "tasks.html") await renderTasks();
      else await renderHome();
    } else {
      btn.disabled = false;
      btn.textContent = `I completed this · +$${Number(task.reward).toFixed(2)}`;
    }
  });

  document.getElementById("btn-submit-proof")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-submit-proof");
    btn.disabled = true;
    btn.textContent = "...";

    let payload;
    if (isAccountTask(task)) {
      payload = {
        firstName: document.getElementById("proof-first")?.value || "",
        lastName: document.getElementById("proof-last")?.value || "",
        username: document.getElementById("proof-user")?.value || "",
        password: document.getElementById("proof-pass")?.value || ""
      };
    } else {
      payload = document.getElementById("proof-input")?.value || "";
    }

    const ok = await submitProof(taskId, payload);
    if (ok) {
      closeTaskModal();
      const page = (location.pathname.split("/").pop() || "index.html").split("?")[0];
      if (page === "tasks.html") await renderTasks();
      else await renderHome();
    } else {
      btn.disabled = false;
      btn.textContent = "Submit for review";
    }
  });
}

// ---------- Check-in ----------
async function doCheckin() {
  if (!db || !userData || userData._offline) {
    showToast("Firebase Auth off — enable Anonymous login");
    return false;
  }

  if (userData.lastCheckin === todayKey()) {
    showToast("Already claimed today");
    return false;
  }

  const reward = 0.05;
  try {
    await updateDoc(doc(db, "users", userData.id), {
      balance: increment(reward),
      lifetime: increment(reward),
      lastCheckin: todayKey(),
      updatedAt: serverTimestamp()
    });

    await addDoc(collection(db, "users", userData.id, "transactions"), {
      type: "earn",
      title: "Daily check-in",
      amount: reward,
      icon: "🎁",
      createdAt: serverTimestamp()
    });

    userData.balance = (userData.balance || 0) + reward;
    userData.lifetime = (userData.lifetime || 0) + reward;
    userData.lastCheckin = todayKey();
    saveCache();

    showToast(`Check-in +$${reward.toFixed(2)} claimed!`);
    return true;
  } catch (e) {
    console.error(e);
    showToast("Check-in failed");
    return false;
  }
}

// ---------- Transactions ----------
async function loadTransactions(limitCount = 20) {
  if (!db || !userData) return [];
  try {
    const q = query(
      collection(db, "users", userData.id, "transactions"),
      orderBy("createdAt", "desc"),
      limit(limitCount)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error(e);
    return [];
  }
}

// ---------- Convert / Withdraw ----------
const CONVERT_RATES = {
  BD: { code: "BDT", label: "Bangladesh (BDT)", rate: 120, symbol: "৳" },
  IN: { code: "INR", label: "India (INR)", rate: 84, symbol: "₹" },
  ID: { code: "IDR", label: "Indonesia (IDR)", rate: 15800, symbol: "Rp" },
  NP: { code: "NPR", label: "Nepal (NPR)", rate: 134, symbol: "रू" }
};
const CONVERT_FEE = 0.04; // 4%

function calcConvert(usd, country) {
  const info = CONVERT_RATES[country];
  if (!info || !usd || usd <= 0) return null;
  const fee = usd * CONVERT_FEE;
  const net = usd - fee;
  const local = net * info.rate;
  return { fee, net, local, info };
}

function updateConvertPreview() {
  const amountEl = document.getElementById("convert-amount");
  const countryEl = document.getElementById("convert-country");
  const preview = document.getElementById("convert-preview");
  if (!amountEl || !countryEl || !preview) return;

  const usd = parseFloat(amountEl.value) || 0;
  const country = countryEl.value;
  const result = calcConvert(usd, country);

  if (!result) {
    preview.hidden = true;
    return;
  }

  preview.hidden = false;
  const usdEl = preview.querySelector("[data-cv-usd]");
  const feeEl = preview.querySelector("[data-cv-fee]");
  const netEl = preview.querySelector("[data-cv-net]");
  const localEl = preview.querySelector("[data-cv-local]");
  const labelEl = preview.querySelector("[data-cv-label]");
  if (usdEl) usdEl.textContent = `$${usd.toFixed(2)}`;
  if (feeEl) feeEl.textContent = `−$${result.fee.toFixed(2)}`;
  if (netEl) netEl.textContent = `$${result.net.toFixed(2)}`;
  if (labelEl) labelEl.textContent = `You receive (${result.info.code})`;
  if (localEl) {
    const loc = result.local >= 1000
      ? result.local.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : result.local.toFixed(2);
    localEl.textContent = `${result.info.symbol}${loc}`;
  }
}

async function requestWithdraw(amount, method, account) {
  if (!db || !userData) {
    showToast("Firebase not connected");
    return false;
  }

  amount = parseFloat(amount);
  if (isNaN(amount) || amount < 2) {
    showToast("Minimum convert amount is $2.00");
    return false;
  }
  if (amount > (userData.balance || 0)) {
    showToast("Insufficient balance");
    return false;
  }

  const conv = calcConvert(amount, method);
  if (!conv) {
    showToast("Select a country / currency");
    return false;
  }

  const methodLabel = `Convert → ${conv.info.code}`;
  const localStr = conv.local >= 1000
    ? conv.local.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : conv.local.toFixed(2);

  try {
    await addDoc(collection(db, "users", userData.id, "withdrawals"), {
      amount,
      method: methodLabel,
      country: method,
      currency: conv.info.code,
      rate: conv.info.rate,
      feePercent: CONVERT_FEE * 100,
      feeUsd: conv.fee,
      netUsd: conv.net,
      localAmount: conv.local,
      account,
      status: "pending",
      createdAt: serverTimestamp()
    });

    await addDoc(collection(db, "users", userData.id, "transactions"), {
      type: "withdraw",
      title: `${methodLabel} (${conv.info.symbol}${localStr})`,
      amount: -amount,
      icon: "⇄",
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, "users", userData.id), {
      balance: increment(-amount),
      pending: increment(amount),
      updatedAt: serverTimestamp()
    });

    userData.balance = (userData.balance || 0) - amount;
    userData.pending = (userData.pending || 0) + amount;
    saveCache();

    showToast(`Convert submitted · ${conv.info.symbol}${localStr}`);
    return true;
  } catch (e) {
    console.error(e);
    showToast("Convert request failed");
    return false;
  }
}

// ---------- Leaderboard (real users only — no demo data) ----------
async function loadLeaderboard() {
  if (!db) return [];
  try {
    const q = query(collection(db, "users"), orderBy("lifetime", "desc"), limit(20));
    const snap = await getDocs(q);
    if (snap.empty) return [];

    const list = snap.docs.map((d, i) => {
      const u = d.data();
      return {
        rank: i + 1,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "User",
        score: u.lifetime || 0,
        tasks: u.tasksCompleted || 0,
        avatar: getInitials([u.firstName, u.lastName].filter(Boolean).join(" ") || "U"),
        isMe: d.id === userData?.id
      };
    });

    // Ensure current user appears
    if (userData && !list.find(x => x.isMe)) {
      list.push({
        rank: list.length + 1,
        name: [userData.firstName, userData.lastName].filter(Boolean).join(" ") || "You",
        score: userData.lifetime || 0,
        tasks: userData.tasksCompleted || 0,
        avatar: getInitials([userData.firstName, userData.lastName].filter(Boolean).join(" ") || "Y"),
        isMe: true
      });
    }
    return list;
  } catch (e) {
    console.error("Leaderboard error:", e);
    return [];
  }
}

// ---------- Render Helpers ----------
function hideLoading() {
  document.getElementById("loading")?.classList.add("hidden");
}

function renderBalance(selector, amount) {
  const el = document.querySelector(selector);
  if (!el) return;
  const { whole, decimal } = formatMoney(amount);
  el.innerHTML = `$${whole}<small>.${decimal}</small>`;
}

// ---------- Page Renderers ----------
async function renderHome() {
  if (!userData) return;

  // Greeting
  const name = userData.firstName || "there";
  const greetEl = document.querySelector("[data-greeting]");
  if (greetEl) greetEl.innerHTML = `${getGreeting()}, <span>${name}</span> ✳`;

  const dateEl = document.querySelector("[data-date]");
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long", day: "numeric", month: "short", year: "numeric"
    });
  }

  // Balance
  renderBalance("[data-balance]", userData.balance || 0);
  const pendingEl = document.querySelector("[data-pending]");
  if (pendingEl) pendingEl.textContent = `$${(userData.pending || 0).toFixed(2)}`;
  const streakEl = document.querySelector("[data-streak-val]");
  if (streakEl) streakEl.textContent = String(userData.streak || 0).padStart(2, "0");

  // Tasks completed
  const tasksEl = document.querySelector("[data-tasks-done]");
  if (tasksEl) tasksEl.innerHTML = `${userData.tasksCompleted || 0} <small>total</small>`;

  // Check-in button
  const checkBtn = document.querySelector("[data-checkin]");
  if (checkBtn) {
    if (userData.lastCheckin === todayKey()) {
      checkBtn.classList.add("done");
      checkBtn.textContent = "Claimed ✓";
    } else {
      checkBtn.classList.remove("done");
      checkBtn.textContent = "Claim +$0.05";
      checkBtn.onclick = async () => {
        const ok = await doCheckin();
        if (ok) {
          checkBtn.classList.add("done");
          checkBtn.textContent = "Claimed ✓";
          renderBalance("[data-balance]", userData.balance);
        }
      };
    }
  }

  // Streak days visual
  renderStreakDays();

  // Recommended tasks
  const completed = await getCompletedTaskIds();
  const list = document.querySelector("[data-home-tasks]");
  if (list) {
    const recommended = tasks.slice(0, 3);
    if (!recommended.length) {
      list.innerHTML = `
        <div class="empty-state compact">
          <div class="empty-icon">✳</div>
          <strong>No tasks yet</strong>
          <p>Admin will publish tasks soon.</p>
        </div>`;
    } else {
      list.innerHTML = recommended.map(t => taskCardHTML(t, completed.has(t.id))).join("");
      bindTaskButtons(list);
    }
  }

  // Progress
  const todayCount = completed.size;
  const dailyGoal = 5;
  const pct = Math.min(100, Math.round((todayCount / dailyGoal) * 100));
  const ring = document.querySelector("[data-progress-ring]");
  if (ring) {
    ring.style.setProperty("--progress", pct + "%");
    ring.querySelector("span").textContent = pct + "%";
  }
  const progText = document.querySelector("[data-progress-text]");
  if (progText) progText.innerHTML = `<strong>${todayCount} / ${dailyGoal} tasks today</strong><small>${todayCount >= dailyGoal ? "Goal reached!" : "Keep going!"}</small>`;

  // Translator (country / language)
  document.getElementById("btn-translator")?.addEventListener("click", openTranslator);
}

function openTranslator() {
  ensureTaskModal();
  const saved = localStorage.getItem("verdant_lang") || "en";
  const langs = [
    { id: "en", flag: "🇬🇧", name: "English", region: "International" },
    { id: "bn", flag: "🇧🇩", name: "বাংলা", region: "Bangladesh" },
    { id: "hi", flag: "🇮🇳", name: "हिन्दी", region: "India" },
    { id: "id", flag: "🇮🇩", name: "Bahasa Indonesia", region: "Indonesia" },
    { id: "ne", flag: "🇳🇵", name: "नेपाली", region: "Nepal" }
  ];
  openTaskModal(`
    <h3 style="margin:0 0 6px">Translator</h3>
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">Choose language / country preference</p>
    <div class="lang-list">
      ${langs.map(l => `
        <button type="button" class="lang-item ${saved === l.id ? "active" : ""}" data-lang="${l.id}">
          <span class="lang-flag">${l.flag}</span>
          <span class="lang-meta"><strong>${l.name}</strong><small>${l.region}</small></span>
          ${saved === l.id ? '<span class="lang-check">✓</span>' : ""}
        </button>
      `).join("")}
    </div>
    <button class="btn-secondary" id="btn-close-task" style="width:100%;margin-top:14px">Close</button>
  `);
  document.getElementById("btn-close-task")?.addEventListener("click", closeTaskModal);
  document.querySelectorAll("[data-lang]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.lang;
      localStorage.setItem("verdant_lang", id);
      showToast("Language preference saved");
      closeTaskModal();
    });
  });
}

function renderStreakDays() {
  const container = document.querySelector("[data-streak-days]");
  if (!container) return;
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  const today = new Date().getDay();
  const streak = userData?.streak || 0;

  container.innerHTML = days.map((d, i) => {
    let cls = "";
    if (i === today) cls = "today";
    else if (i < today && (today - i) <= streak) cls = "done";
    else if (i > today && streak >= 7) cls = "done";
    return `<span class="${cls}">${d}</span>`;
  }).join("");
}

function taskCardHTML(t, isDone) {
  const badge = t.proofRequired ? "Review" : "Instant";
  return `
    <div class="task-card ${isDone ? "completed" : ""}" data-task data-category="${t.category}" data-search="${t.title} ${t.description}" data-id="${t.id}">
      <div class="task-icon ${t.iconClass || ""}">${t.icon || "✳"}</div>
      <div class="task-body">
        <h3>${t.title}</h3>
        <p>${t.description || ""}</p>
        <div class="task-meta"><span>◷ ${t.duration || "—"}</span><span>${t.level || "Easy"}</span><span>${badge}</span></div>
      </div>
      <div class="task-reward">
        <span class="amount">+$${Number(t.reward).toFixed(2)}</span>
        <button class="btn-start" data-open-task ${isDone ? "disabled" : ""}>${isDone ? "Done ✓" : "View"}</button>
      </div>
    </div>`;
}

function bindTaskButtons(container) {
  container.querySelectorAll("[data-task]").forEach(card => {
    card.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = card.dataset.id;
      if (!id) return;
      await openTaskDetail(id);
    });
  });
}

async function renderTasks() {
  const completed = await getCompletedTaskIds();
  const list = document.querySelector("[data-task-list]");
  if (!list) return;

  if (!tasks.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✳</div>
        <strong>No tasks available</strong>
        <p>Check back later — new tasks will appear here.</p>
      </div>`;
  } else {
    list.innerHTML = tasks.map(t => taskCardHTML(t, completed.has(t.id))).join("");
    bindTaskButtons(list);
  }

  // Progress
  const todayCount = completed.size;
  const dailyGoal = 5;
  const pct = Math.min(100, Math.round((todayCount / dailyGoal) * 100));
  const ring = document.querySelector("[data-progress-ring]");
  if (ring) {
    ring.style.setProperty("--progress", pct + "%");
    ring.querySelector("span").textContent = pct + "%";
  }
  const progText = document.querySelector("[data-progress-text]");
  if (progText) {
    progText.innerHTML = `<strong>${todayCount} / ${dailyGoal} tasks today</strong><small>${todayCount >= dailyGoal ? "Goal reached! 🎉" : "Keep going — almost there!"}</small>`;
  }

  // Filters
  const filterTabs = document.querySelectorAll("[data-filter]");
  const searchInput = document.querySelector("[data-search]");
  let activeFilter = "all";

  function applyFilter() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    list.querySelectorAll("[data-task]").forEach(card => {
      const cat = card.dataset.category || "";
      const text = (card.dataset.search || "").toLowerCase();
      const matchCat = activeFilter === "all" || cat === activeFilter;
      const matchSearch = !q || text.includes(q);
      card.classList.toggle("hidden", !(matchCat && matchSearch));
    });
  }

  filterTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      filterTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      activeFilter = tab.dataset.filter;
      applyFilter();
    });
  });
  searchInput?.addEventListener("input", applyFilter);
}

async function renderWallet() {
  if (!userData) return;

  renderBalance("[data-wallet-balance]", userData.balance || 0);
  const pendingEl = document.querySelector("[data-wallet-pending]");
  if (pendingEl) pendingEl.textContent = `$${(userData.pending || 0).toFixed(2)}`;
  const lifeEl = document.querySelector("[data-wallet-lifetime]");
  if (lifeEl) lifeEl.textContent = `$${(userData.lifetime || 0).toFixed(2)}`;
  const withEl = document.querySelector("[data-wallet-withdrawn]");
  if (withEl) withEl.textContent = `$${(userData.withdrawn || 0).toFixed(2)}`;

  // Transactions
  const txs = await loadTransactions(15);
  const list = document.querySelector("[data-tx-list]");
  if (list) {
    if (!txs.length) {
      list.innerHTML = `<div class="empty-state"><div class="emoji">📭</div><p>No transactions yet.<br>Complete tasks to start earning!</p></div>`;
    } else {
      list.innerHTML = txs.map(tx => {
        const isOut = tx.amount < 0 || tx.type === "withdraw";
        return `
          <div class="tx-item">
            <div class="tx-icon ${isOut ? "out" : ""}">${tx.icon || (isOut ? "↗" : "✳")}</div>
            <div class="tx-body">
              <strong>${tx.title}</strong>
              <small>${formatDate(tx.createdAt)}</small>
            </div>
            <div class="tx-amount ${isOut ? "out" : ""}">${isOut ? "" : "+"}$${Math.abs(tx.amount).toFixed(2)}</div>
          </div>`;
      }).join("");
    }
  }

  // Convert modal
  const modal = document.getElementById("withdraw-modal");
  document.querySelectorAll("[data-open-withdraw]").forEach(btn => {
    btn.onclick = () => {
      modal?.classList.add("open");
      updateConvertPreview();
    };
  });
  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.onclick = () => modal?.classList.remove("open");
  });
  modal?.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

  document.getElementById("convert-amount")?.addEventListener("input", updateConvertPreview);
  document.getElementById("convert-country")?.addEventListener("change", updateConvertPreview);

  const form = document.querySelector("[data-withdraw-form]");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = form.querySelector("[name=amount]")?.value;
    const method = form.querySelector("[name=method]")?.value;
    const account = form.querySelector("[name=account]")?.value;
    const ok = await requestWithdraw(amount, method, account);
    if (ok) {
      modal?.classList.remove("open");
      form.reset();
      const preview = document.getElementById("convert-preview");
      if (preview) preview.hidden = true;
      renderWallet();
    }
  });
}

async function renderProfile() {
  if (!userData) return;

  const name = [userData.firstName, userData.lastName].filter(Boolean).join(" ") || "User";
  const nameEl = document.querySelector("[data-profile-name]");
  if (nameEl) nameEl.textContent = name;

  const userEl = document.querySelector("[data-profile-user]");
  if (userEl) {
    const uname = userData.username ? `@${userData.username}` : "";
    userEl.textContent = uname || "Telegram User";
  }

  const avatarEl = document.querySelector("[data-profile-avatar]");
  if (avatarEl) {
    if (userData.photoUrl) {
      avatarEl.innerHTML = `<img src="${userData.photoUrl}" alt="">`;
    } else {
      avatarEl.textContent = getInitials(name);
    }
  }

  // Referral
  const refCode = userData.referralCode || "------";
  const botUsername = "VerdantBot_bot"; // real bot username
  const refLink = `t.me/${botUsername}?start=ref_${refCode}`;
  const linkEl = document.querySelector("[data-ref-link]");
  if (linkEl) linkEl.textContent = refLink;

  const refCount = document.querySelector("[data-ref-count]");
  if (refCount) refCount.textContent = userData.referrals || 0;
  const refEarn = document.querySelector("[data-ref-earn]");
  if (refEarn) refEarn.textContent = `$${(userData.referralEarnings || 0).toFixed(2)}`;

  document.querySelectorAll("[data-copy-ref]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText("https://" + refLink);
        showToast("Referral link copied!");
      } catch {
        showToast(refLink);
      }
    };
  });

  // Stats tags
  const streakTag = document.querySelector("[data-profile-streak]");
  if (streakTag) streakTag.textContent = `◷ ${userData.streak || 0} day streak`;
}

async function renderLeaderboard() {
  const list = await loadLeaderboard();
  const container = document.querySelector("[data-lb-list]");
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏆</div>
        <strong>No rankings yet</strong>
        <p>Complete tasks to appear on the leaderboard.</p>
      </div>`;
    return;
  }

  container.innerHTML = list.map(item => {
    let rankCls = "";
    if (item.rank === 1) rankCls = "gold";
    else if (item.rank === 2) rankCls = "silver";
    else if (item.rank === 3) rankCls = "bronze";

    return `
      <div class="lb-item ${item.isMe ? "me" : ""}">
        <div class="lb-rank ${rankCls}">${item.rank}</div>
        <div class="lb-avatar">${item.avatar}</div>
        <div class="lb-info">
          <strong>${item.name}${item.isMe ? " (You)" : ""}</strong>
          <small>${item.tasks} tasks completed</small>
        </div>
        <div class="lb-score">$${Number(item.score).toFixed(2)}</div>
      </div>`;
  }).join("");
}

// ---------- Notifications (real context only — no demo feed) ----------
async function renderNotifications() {
  const list = document.querySelector("[data-notif-list]");
  if (!list) return;

  const items = [];

  // Only show live, user-relevant notices
  if (userData && userData.lastCheckin !== todayKey()) {
    items.push({
      icon: "🎁",
      title: "Daily check-in available",
      body: "Claim your daily reward before it resets.",
      time: "Today",
      unread: true
    });
  }
  if (userData && (userData.streak || 0) > 0) {
    items.push({
      icon: "🔥",
      title: `${userData.streak}-day streak`,
      body: "Keep your streak alive with today’s activity.",
      time: "Today",
      unread: false
    });
  }
  if (tasks && tasks.length) {
    items.push({
      icon: "✳",
      title: `${tasks.length} active task${tasks.length > 1 ? "s" : ""}`,
      body: "Open Tasks to start earning.",
      time: "Now",
      unread: false
    });
  }

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔔</div>
        <strong>No notifications</strong>
        <p>You’re all caught up. Check back later.</p>
      </div>`;
    return;
  }

  list.innerHTML = items.map(n => `
    <div class="notif-item ${n.unread ? "unread" : ""}">
      <div class="notif-icon">${n.icon}</div>
      <div class="notif-body">
        <strong>${n.title}</strong>
        <p>${n.body}</p>
        <small>${n.time}</small>
      </div>
    </div>
  `).join("");
}

// ---------- Boot ----------
function getPageName() {
  return (location.pathname.split("/").pop() || "index.html").split("?")[0];
}

async function renderCurrentPage() {
  const page = getPageName();

  if (page === "index.html" || page === "" || page === "/" || page === "VerdantBot") {
    await renderHome();
  } else if (page === "tasks.html") {
    await renderTasks();
  } else if (page === "wallet.html") {
    await renderWallet();
  } else if (page === "profile.html") {
    await renderProfile();
  } else if (page === "leaderboard.html") {
    await renderLeaderboard();
  } else if (page === "notifications.html") {
    await renderNotifications();
  } else if (page === "privacy.html" || page === "terms.html") {
    // static content pages — nothing dynamic
  } else {
    await renderHome();
  }

  // Bottom nav active
  document.querySelectorAll(".nav-item").forEach(item => {
    const href = item.getAttribute("href") || "";
    if (href === page || (page === "" && href === "index.html")) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

function applyTelegramProfile() {
  if (!userData || !telegramUser) return;
  if (telegramUser.first_name) userData.firstName = telegramUser.first_name;
  if (telegramUser.last_name !== undefined) userData.lastName = telegramUser.last_name || "";
  if (telegramUser.username) userData.username = telegramUser.username;
  if (telegramUser.photo_url) userData.photoUrl = telegramUser.photo_url;
  if (telegramUser.id) userData.telegramId = telegramUser.id;
}

async function boot() {
  initTelegram();

  const page = getPageName();
  const isStaticPage = page === "privacy.html" || page === "terms.html";

  // Static legal pages: no Firebase needed — show instantly
  if (isStaticPage) {
    isReady = true;
    hideLoading();
    return;
  }

  // --- Fast path: session cache ---
  const cachedUser = loadCacheUser();
  const cachedTasks = loadCacheTasks();
  let usedCache = false;

  if (cachedUser) {
    userData = cachedUser;
    usedCache = true;
  }
  if (cachedTasks) tasks = cachedTasks;

  if (usedCache) {
    applyTelegramProfile();
    isReady = true;
    hideLoading();
    await renderCurrentPage();
  }

  // --- Network path ---
  const hasFirebase = await initFirebase();

  if (hasFirebase) {
    // Run auth + tasks in parallel after auth resolves user doc
    const userPromise = ensureUser();
    const user = await userPromise;

    if (!user || !userData) {
      console.warn("Firebase auth failed — offline mode.");
      if (!userData) {
        userData = buildOfflineUser();
        tasks = [];
      }
      if (!usedCache) {
        setTimeout(() => showToast("Enable Anonymous Auth in Firebase"), 400);
      }
    } else {
      // Load tasks without blocking first paint if cache already shown
      if (usedCache) {
        loadTasks().then(() => renderCurrentPage()).catch(() => {});
      } else {
        await loadTasks();
      }
    }
  } else if (!userData) {
    userData = buildOfflineUser();
    tasks = [];
  }

  applyTelegramProfile();
  saveCache();
  isReady = true;

  if (!usedCache) {
    hideLoading();
    await renderCurrentPage();
  }
}

// Start
boot().catch(err => {
  console.error("Boot error:", err);
  hideLoading();
  showToast("Something went wrong. Please refresh.");
});
