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
let tasks = [];
let isReady = false;

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
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor("#f5f4ed");
      tg.setBackgroundColor("#f5f4ed");
    } catch (e) {}
    telegramUser = tg.initDataUnsafe?.user || null;
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
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser = user;
        await loadOrCreateUserDoc(user.uid);
        resolve(user);
      } else {
        try {
          const cred = await signInAnonymously(auth);
          currentUser = cred.user;
          await loadOrCreateUserDoc(cred.user.uid);
          resolve(cred.user);
        } catch (e) {
          console.error("Auth error:", e);
          resolve(null);
        }
      }
    });
  });
}

async function loadOrCreateUserDoc(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    userData = { id: uid, ...snap.data() };
  } else {
    const tg = telegramUser;
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
      referredBy: null,
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
    // Offline fallback tasks
    tasks = getDefaultTasks();
    return tasks;
  }
  try {
    const q = query(collection(db, "tasks"), where("active", "==", true), orderBy("order", "asc"));
    const snap = await getDocs(q);
    if (snap.empty) {
      // Seed default tasks once
      await seedDefaultTasks();
      const snap2 = await getDocs(q);
      tasks = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  } catch (e) {
    console.error("Load tasks error:", e);
    tasks = getDefaultTasks();
  }
  return tasks;
}

function getDefaultTasks() {
  return [
    { id: "t1", title: "Daily knowledge quiz", description: "Answer 5 quick questions about everyday topics.", category: "quick", reward: 0.15, duration: "5 min", level: "Beginner", icon: "✳", iconClass: "", order: 1, active: true },
    { id: "t2", title: "Explore a new topic", description: "Read a short introduction and answer one reflection question.", category: "learn", reward: 0.10, duration: "3 min", level: "Easy", icon: "◉", iconClass: "peach", order: 2, active: true },
    { id: "t3", title: "Quick feedback survey", description: "Share your honest opinion on a product concept.", category: "survey", reward: 0.25, duration: "4 min", level: "Easy", icon: "▣", iconClass: "gold", order: 3, active: true },
    { id: "t4", title: "Share to Telegram", description: "Share our bot with 2 friends and get rewarded.", category: "social", reward: 0.20, duration: "2 min", level: "Easy", icon: "↗", iconClass: "blue", order: 4, active: true },
    { id: "t5", title: "Watch a short video", description: "Watch a 30-second educational clip and confirm.", category: "quick", reward: 0.08, duration: "1 min", level: "Easy", icon: "▶", iconClass: "", order: 5, active: true },
    { id: "t6", title: "Complete a short lesson", description: "Finish a 4-minute micro-lesson on digital skills.", category: "learn", reward: 0.18, duration: "4 min", level: "Beginner", icon: "📘", iconClass: "peach", order: 6, active: true },
    { id: "t7", title: "Rate & review", description: "Leave a short honest review for a partner app.", category: "survey", reward: 0.30, duration: "3 min", level: "Easy", icon: "★", iconClass: "gold", order: 7, active: true },
    { id: "t8", title: "Join community group", description: "Join our official Telegram group.", category: "social", reward: 0.12, duration: "1 min", level: "Easy", icon: "💬", iconClass: "blue", order: 8, active: true }
  ];
}

async function seedDefaultTasks() {
  if (!db) return;
  const defaults = getDefaultTasks();
  for (const t of defaults) {
    const { id, ...data } = t;
    await setDoc(doc(db, "tasks", id), data);
  }
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

async function completeTask(taskId) {
  if (!db || !userData) {
    showToast("Firebase not connected");
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
    // Add to completed
    await addDoc(collection(db, "users", userData.id, "completedTasks"), {
      taskId,
      title: task.title,
      reward: task.reward,
      date: todayKey(),
      completedAt: serverTimestamp()
    });

    // Add transaction
    await addDoc(collection(db, "users", userData.id, "transactions"), {
      type: "earn",
      title: task.title,
      amount: task.reward,
      icon: task.icon || "✳",
      createdAt: serverTimestamp()
    });

    // Update user balance
    await updateDoc(doc(db, "users", userData.id), {
      balance: increment(task.reward),
      lifetime: increment(task.reward),
      tasksCompleted: increment(1),
      updatedAt: serverTimestamp()
    });

    userData.balance = (userData.balance || 0) + task.reward;
    userData.lifetime = (userData.lifetime || 0) + task.reward;
    userData.tasksCompleted = (userData.tasksCompleted || 0) + 1;

    showToast(`+$${task.reward.toFixed(2)} earned!`);
    return true;
  } catch (e) {
    console.error("Complete task error:", e);
    showToast("Error completing task");
    return false;
  }
}

// ---------- Check-in ----------
async function doCheckin() {
  if (!db || !userData) {
    showToast("Firebase not connected");
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

// ---------- Withdraw ----------
async function requestWithdraw(amount, method, account) {
  if (!db || !userData) {
    showToast("Firebase not connected");
    return false;
  }

  amount = parseFloat(amount);
  if (isNaN(amount) || amount < 2) {
    showToast("Minimum withdrawal is $2.00");
    return false;
  }
  if (amount > (userData.balance || 0)) {
    showToast("Insufficient balance");
    return false;
  }

  try {
    await addDoc(collection(db, "users", userData.id, "withdrawals"), {
      amount,
      method,
      account,
      status: "pending",
      createdAt: serverTimestamp()
    });

    await addDoc(collection(db, "users", userData.id, "transactions"), {
      type: "withdraw",
      title: `Withdrawal to ${method}`,
      amount: -amount,
      icon: "↗",
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, "users", userData.id), {
      balance: increment(-amount),
      pending: increment(amount),
      updatedAt: serverTimestamp()
    });

    userData.balance = (userData.balance || 0) - amount;
    userData.pending = (userData.pending || 0) + amount;

    showToast("Withdrawal request submitted!");
    return true;
  } catch (e) {
    console.error(e);
    showToast("Withdrawal failed");
    return false;
  }
}

// ---------- Leaderboard (Demo data + real if available) ----------
function getDemoLeaderboard() {
  return [
    { rank: 1, name: "Rahim Ahmed", score: 128.50, tasks: 342, avatar: "R" },
    { rank: 2, name: "Fatima Khan", score: 112.30, tasks: 298, avatar: "F" },
    { rank: 3, name: "Karim Hossain", score: 98.75, tasks: 267, avatar: "K" },
    { rank: 4, name: "Nusrat Jahan", score: 87.20, tasks: 241, avatar: "N" },
    { rank: 5, name: "Sakib Hasan", score: 76.40, tasks: 215, avatar: "S" },
    { rank: 6, name: "Mim Akter", score: 65.10, tasks: 189, avatar: "M" },
    { rank: 7, name: "Rafi Islam", score: 54.80, tasks: 162, avatar: "R" },
    { rank: 8, name: "Tania Rahman", score: 48.25, tasks: 148, avatar: "T" },
    { rank: 9, name: "Imran Ali", score: 41.60, tasks: 131, avatar: "I" },
    { rank: 10, name: "Sadia Begum", score: 36.90, tasks: 119, avatar: "S" }
  ];
}

async function loadLeaderboard() {
  // For now return demo. Later can query users ordered by lifetime.
  if (!db) return getDemoLeaderboard();
  try {
    const q = query(collection(db, "users"), orderBy("lifetime", "desc"), limit(20));
    const snap = await getDocs(q);
    if (snap.empty) return getDemoLeaderboard();

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
    return list.length ? list : getDemoLeaderboard();
  } catch (e) {
    return getDemoLeaderboard();
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
    list.innerHTML = recommended.map(t => taskCardHTML(t, completed.has(t.id))).join("");
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
  if (progText) progText.innerHTML = `<strong>${todayCount} / ${dailyGoal} tasks today</strong><small>${todayCount >= dailyGoal ? "Goal reached!" : "Keep going!"}</small>`;
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
  return `
    <div class="task-card ${isDone ? "completed" : ""}" data-task data-category="${t.category}" data-search="${t.title} ${t.description}" data-id="${t.id}">
      <div class="task-icon ${t.iconClass || ""}">${t.icon || "✳"}</div>
      <div class="task-body">
        <h3>${t.title}</h3>
        <p>${t.description}</p>
        <div class="task-meta"><span>◷ ${t.duration}</span><span>${t.level}</span></div>
      </div>
      <div class="task-reward">
        <span class="amount">+$${Number(t.reward).toFixed(2)}</span>
        <button class="btn-start" data-start-task ${isDone ? "disabled" : ""}>${isDone ? "Done ✓" : "Start"}</button>
      </div>
    </div>`;
}

function bindTaskButtons(container) {
  container.querySelectorAll("[data-start-task]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const card = btn.closest("[data-task]");
      const id = card?.dataset.id;
      if (!id) return;

      btn.disabled = true;
      btn.textContent = "...";
      const ok = await completeTask(id);
      if (ok) {
        card.classList.add("completed");
        btn.textContent = "Done ✓";
        // Refresh balance if on home
        renderBalance("[data-balance]", userData.balance);
        renderBalance("[data-wallet-balance]", userData.balance);
      } else {
        btn.disabled = false;
        btn.textContent = "Start";
      }
    });
  });
}

async function renderTasks() {
  const completed = await getCompletedTaskIds();
  const list = document.querySelector("[data-task-list]");
  if (!list) return;

  list.innerHTML = tasks.map(t => taskCardHTML(t, completed.has(t.id))).join("");
  bindTaskButtons(list);

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

  // Withdraw modal
  const modal = document.getElementById("withdraw-modal");
  document.querySelectorAll("[data-open-withdraw]").forEach(btn => {
    btn.onclick = () => modal?.classList.add("open");
  });
  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.onclick = () => modal?.classList.remove("open");
  });
  modal?.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

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
  const botUsername = "VerdantBot"; // change later
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

// ---------- Boot ----------
async function boot() {
  initTelegram();

  const hasFirebase = await initFirebase();

  if (hasFirebase) {
    await ensureUser();
    await loadTasks();
  } else {
    // Offline mode
    userData = {
      firstName: telegramUser?.first_name || "Guest",
      lastName: telegramUser?.last_name || "",
      username: telegramUser?.username || "",
      photoUrl: telegramUser?.photo_url || "",
      balance: 0,
      pending: 0,
      lifetime: 0,
      withdrawn: 0,
      tasksCompleted: 0,
      streak: 0,
      lastCheckin: null,
      referralCode: "GUEST1",
      referrals: 0,
      referralEarnings: 0
    };
    tasks = getDefaultTasks();
  }

  isReady = true;
  hideLoading();

  // Detect page and render
  const page = location.pathname.split("/").pop() || "index.html";

  if (page === "index.html" || page === "" || page === "/") {
    await renderHome();
  } else if (page === "tasks.html") {
    await renderTasks();
  } else if (page === "wallet.html") {
    await renderWallet();
  } else if (page === "profile.html") {
    await renderProfile();
  } else if (page === "leaderboard.html") {
    await renderLeaderboard();
  }

  // Bottom nav active
  document.querySelectorAll(".nav-item").forEach(item => {
    const href = item.getAttribute("href") || "";
    if (href === page || (page === "" && href === "index.html")) {
      item.classList.add("active");
    }
  });
}

// Start
boot().catch(err => {
  console.error("Boot error:", err);
  hideLoading();
  showToast("Something went wrong. Please refresh.");
});
