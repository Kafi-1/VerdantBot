# Verdant — Fully Functional Telegram Mini App

Daily Task & Earning platform with **Firebase** backend.

## Features

| Feature | Status |
|---------|--------|
| Telegram WebApp SDK | ✅ |
| Firebase Auth (Anonymous) | ✅ |
| Firestore user profiles | ✅ |
| Real balance & transactions | ✅ |
| Task detail + How-to steps | ✅ |
| Task types (visit / join / watch / survey / quiz) | ✅ |
| Instant complete + Proof review flow | ✅ |
| Admin full task manager | ✅ |
| Admin proof submissions (approve / reject) | ✅ |
| Daily check-in reward | ✅ |
| Streak system | ✅ |
| Withdrawal requests | ✅ |
| Referral system | ✅ |
| Leaderboard (demo + real) | ✅ |
| Bottom nav (5 tabs) | ✅ |

## Pages
- `index.html` — Home / Dashboard
- `tasks.html` — Task list + filters
- `leaderboard.html` — Rankings (demo data included)
- `wallet.html` — Balance + transactions + withdraw
- `profile.html` — Profile + referral
- `admin/index.html` — Admin panel (login with Firebase Email/Password)

## Setup (Important)

### 1. Firebase Project
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project
3. Add a **Web App**
4. Copy the config

### 2. Enable Services
- **Authentication** → Sign-in method → **Anonymous** → Enable
- **Firestore Database** → Create database (start in test mode)

### 3. Put your config
Open `assets/js/firebase-config.js` and replace:

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 4. Firestore Rules (for testing)
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### 5. Host & BotFather
1. Upload the folder to any static host (Netlify / Cloudflare Pages / GitHub Pages / Vercel)
2. BotFather → `/newbot` → Mini App → set Web App URL to your `index.html`

## How it works
- User opens Mini App → Anonymous Auth + Telegram user data linked
- Tasks stored in `tasks` collection (auto-seeded on first run)
- Completing a task → balance increases + transaction logged
- Check-in once per day
- Withdrawal creates a request (admin can process later)
- Leaderboard shows top users by lifetime earnings (falls back to demo data)

## Collections Structure
```
users/{uid}
  - balance, pending, lifetime, withdrawn
  - streak, lastCheckin, tasksCompleted
  - referralCode, referrals, referralEarnings
  - completedTasks/{auto}
  - transactions/{auto}
  - withdrawals/{auto}

tasks/{taskId}
  - title, description, steps, type, category, link
  - reward, duration, level, icon, iconClass, order, active
  - proofRequired, proofHint

submissions/{id}
  - uid, taskId, taskTitle, reward, proof, status (pending|approved|rejected), date, createdAt
```

## Notes
- Without Firebase config the app runs in **offline/guest mode** (no real data save)
- Leaderboard has beautiful demo data so it never looks empty
- Change bot username in `app.js` → `renderProfile()` for real referral links

## Update: Proof screenshots, bonus, balance edit
- Set `window.IMGBB_API_KEY` in `assets/js/firebase-config.js` (key from https://api.imgbb.com/)
- Admin → Tasks → "Proof type": Text only / Screenshot only / Text + Screenshot
- User picks an image, it is compressed, uploaded to ImgBB, and the returned URL is saved in `submissions/{id}.proofImage`
- Admin → Proofs shows the screenshot (tap to open full size)
- Admin → Users → user: "Give bonus", "Edit main balance", "Adjust (+/−)". All are logged in the user's transactions
