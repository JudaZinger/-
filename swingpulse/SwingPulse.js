// lib/trades.js
var TRADE_TYPES = ["BUY", "SELL_PARTIAL", "SELL_ALL"];
var TRADE_HE = { BUY: "קנייה", SELL_PARTIAL: "מכירה חלקית", SELL_ALL: "מכירת כל הפוזיציה" };
var r2 = (x) => Math.round(x * 100) / 100;
var r4 = (x) => Math.round(x * 1e4) / 1e4;
var n = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
var T = (t) => String(t || "").trim().toUpperCase();
function findPos(portfolio, ticker) {
  return (portfolio && portfolio.positions || []).find((p) => T(p.ticker) === T(ticker)) || null;
}
function recomputePortfolio(portfolio) {
  const cash = n(portfolio.cashBalance) || 0;
  const positions = (portfolio.positions || []).filter((p) => (n(p.shares) || 0) > 1e-9).map((p) => {
    const shares = n(p.shares) || 0, avg = n(p.avgPrice), px = n(p.currentPrice) ?? avg;
    const mv = px != null ? r2(shares * px) : n(p.marketValue);
    return {
      ...p,
      shares: r4(shares),
      currentPrice: px,
      marketValue: mv,
      unrealizedPnl: px != null && avg != null ? r2(shares * (px - avg)) : n(p.unrealizedPnl),
      unrealizedPnlPct: px != null && avg ? r2((px / avg - 1) * 100) : n(p.unrealizedPnlPct)
    };
  });
  const equity = positions.reduce((s, p) => s + (p.marketValue || 0), 0);
  const total = equity + cash;
  positions.forEach((p) => {
    p.allocationPct = total ? r2((p.marketValue || 0) / total * 100) : null;
  });
  positions.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  return { ...portfolio, positions, cashBalance: r2(cash), totalPortfolioValue: r2(total) };
}
function previewTrade(portfolio, raw) {
  const type = TRADE_TYPES.includes(raw && raw.type) ? raw.type : null;
  const ticker = T(raw && raw.ticker);
  const price = n(raw && raw.price);
  const pos = findPos(portfolio, ticker);
  const cashBefore = n(portfolio && portfolio.cashBalance) || 0;
  const fail = (error) => ({ ok: false, error, trade: { type, ticker, shares: n(raw && raw.shares), price } });
  if (!type) return fail("סוג הפעולה לא ברור (קנייה או מכירה).");
  if (!ticker) return fail("לא ברור על איזו מניה מדובר.");
  if (!(price > 0)) return fail(`חסר מחיר עבור ${ticker}.`);
  if (type === "BUY") {
    const shares2 = n(raw.shares);
    if (!(shares2 > 0)) return fail(`חסרה כמות לקנייה של ${ticker}.`);
    const beforeShares = pos ? n(pos.shares) || 0 : 0, beforeAvg = pos ? n(pos.avgPrice) : null;
    const afterShares = beforeShares + shares2;
    const afterAvg = beforeShares && beforeAvg != null ? (beforeShares * beforeAvg + shares2 * price) / afterShares : price;
    const amount2 = r2(shares2 * price);
    const cashAfter = r2(cashBefore - amount2);
    return {
      ok: true,
      warning: cashAfter < 0 ? "הקנייה גדולה מהמזומן שרשום בתיק." : null,
      trade: { type, ticker, shares: r4(shares2), price },
      before: { shares: beforeShares, avgPrice: beforeAvg },
      after: { shares: r4(afterShares), avgPrice: r4(afterAvg) },
      amount: amount2,
      cashBefore: r2(cashBefore),
      cashAfter,
      realized: 0,
      isNew: !pos,
      closes: false
    };
  }
  if (!pos) return fail(`${ticker} לא נמצאת בתיק, אז אין מה למכור.`);
  const have = n(pos.shares) || 0, avg = n(pos.avgPrice);
  const shares = type === "SELL_ALL" ? have : n(raw.shares);
  if (!(shares > 0)) return fail(`חסרה כמות למכירה של ${ticker}.`);
  if (shares > have + 1e-9) return fail(`בתיק יש ${r4(have)} מניות ${ticker}, אי אפשר למכור ${r4(shares)}.`);
  const closes = Math.abs(have - shares) < 1e-9;
  const amount = r2(shares * price);
  return {
    ok: true,
    warning: avg == null ? "אין מחיר קנייה ממוצע, אז הרווח הממומש לא חושב." : null,
    trade: { type: closes ? "SELL_ALL" : type, ticker, shares: r4(shares), price },
    before: { shares: have, avgPrice: avg },
    after: { shares: closes ? 0 : r4(have - shares), avgPrice: closes ? null : avg },
    amount,
    cashBefore: r2(cashBefore),
    cashAfter: r2(cashBefore + amount),
    realized: avg != null ? r2(shares * (price - avg)) : 0,
    isNew: false,
    closes
  };
}
function applyTrades(portfolio, trades, { at = (/* @__PURE__ */ new Date()).toISOString(), source = "chat" } = {}) {
  let pf = { ...portfolio, positions: (portfolio.positions || []).map((p) => ({ ...p })) };
  const results = [], log = [];
  for (const raw of trades || []) {
    const pv = previewTrade(pf, raw);
    results.push(pv);
    if (!pv.ok) continue;
    const t = pv.trade;
    let pos = findPos(pf, t.ticker);
    if (t.type === "BUY") {
      if (!pos) {
        pos = { ticker: t.ticker, companyName: raw.companyName || t.ticker, shares: 0, avgPrice: t.price, currentPrice: t.price };
        pf.positions.push(pos);
      }
      pos.shares = pv.after.shares;
      pos.avgPrice = pv.after.avgPrice;
      if (n(pos.currentPrice) == null) pos.currentPrice = t.price;
    } else {
      pos.shares = pv.after.shares;
    }
    pf.cashBalance = pv.cashAfter;
    pf.realizedPnl = r2((n(pf.realizedPnl) || 0) + pv.realized);
    log.push({ at, source, type: t.type, ticker: t.ticker, shares: t.shares, price: t.price, amount: pv.amount, realized: pv.realized, note: raw.note || "" });
    pf = recomputePortfolio(pf);
  }
  pf.tradedAt = log.length ? at : pf.tradedAt || null;
  return { portfolio: recomputePortfolio(pf), results, log };
}

// SwingPulse.jsx
import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var APP_VERSION = "6.1.0";
var APP_ENGINE = "Gemini Core";
function resolveApiBase() {
  if (typeof window === "undefined" || !window.location) return "http://localhost:5001";
  try {
    const o = window.localStorage && window.localStorage.getItem("swingpulse.apiBase");
    if (o) return o.replace(/\/$/, "");
  } catch {
  }
  if (/^https?:$/.test(window.location.protocol) && (window.location.port === "5001" || /^\/app(\/|$)/.test(window.location.pathname))) return "";
  return "http://localhost:5001";
}
var API_BASE = resolveApiBase();
var EXTRACT_URL = `${API_BASE}/api/v1/blink/extract`;
var DIGEST_URL = `${API_BASE}/api/v1/analysis/swing-digest`;
var HEALTH_URL = `${API_BASE}/api/v1/health`;
var QUOTES_URL = `${API_BASE}/api/v1/quotes`;
var STATE_URL = `${API_BASE}/api/v1/state`;
var LOGIN_URL = `${API_BASE}/api/v1/login`;
var LOGOUT_URL = `${API_BASE}/api/v1/logout`;
var TELEGRAM_TEST_URL = `${API_BASE}/api/v1/telegram/test`;
var TZ = "Asia/Jerusalem";
var LS_DATA = "swingpulse.data.v2";
var LS_SETTINGS = "swingpulse.settings.v2";
var LS_ALERTS = "swingpulse.alerts.v2";
var LS_THEME = "swingpulse.theme";
var MAX_ALERTS = 150;
var FREQUENCIES = [
  { id: "off", label: "ידני בלבד", ms: null },
  { id: "15m", label: "כל 15 דק׳", ms: 15 * 60 * 1e3 },
  { id: "30m", label: "כל 30 דק׳", ms: 30 * 60 * 1e3 },
  { id: "1h", label: "כל שעה", ms: 60 * 60 * 1e3 },
  { id: "eod", label: "סוף יום מסחר", ms: null }
];
var DEFAULT_SETTINGS = {
  frequency: "eod",
  marketHoursOnly: true,
  alertTypes: { sell: true, trim: true, buy: true, change: true },
  minAllocationPct: 0,
  browserNotifications: false
};
var ACTIONS = {
  ADD: { badge: "קנה עוד", detail: "חיזוק פוזיציה", tone: "green", rank: 3, kind: "buy" },
  BUY: { badge: "קנייה", detail: "כניסה חדשה", tone: "green", rank: 3, kind: "buy" },
  HOLD: { badge: "החזק", detail: "לפי הסטופ", tone: "blue", rank: 5, kind: "hold" },
  TRIM: { badge: "מכירה חלקית", detail: "מימוש", tone: "yellow", rank: 2, kind: "trim" },
  TAKE_PROFIT: { badge: "מכור", detail: "מימוש רווח", tone: "red", rank: 1, kind: "sell" },
  CUT_LOSS: { badge: "מכור", detail: "חיתוך הפסד", tone: "red", rank: 0, kind: "sell" }
};
var TONE_CLASSES = {
  green: "text-[color:var(--up)] bg-[color:var(--up-bg)]",
  blue: "text-[color:var(--accent)] bg-[color:var(--accent-bg)]",
  yellow: "text-[color:var(--warn)] bg-[color:var(--warn-bg)]",
  red: "text-[color:var(--down)] bg-[color:var(--down-bg)]",
  gray: "text-[color:var(--fg-3)] bg-[color:var(--tint)]"
};
var EDGE_CLASSES = {
  green: "border-r-[#30d158]",
  blue: "border-r-[#0a84ff]",
  yellow: "border-r-[#ffd60a]",
  red: "border-r-[#ff453a]",
  gray: "border-r-[color:var(--line)]"
};
function extractPortfolio(files, { onUpload } = {}) {
  if (GAS) return gasExtract(files, { onUpload });
  if (REMOTE) return remoteExtract(files, { onUpload });
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    files.forEach((f, i) => fd.append("images", f, f.name || `shot-${i + 1}.jpg`));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", EXTRACT_URL);
    xhr.responseType = "json";
    xhr.timeout = 15 * 60 * 1e3;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUpload) onUpload(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300 && Array.isArray(body.positions)) resolve(body);
      else reject(Object.assign(new Error(body.message || `HTTP ${xhr.status}`), { code: body.error || `http_${xhr.status}` }));
    };
    xhr.onerror = () => reject(Object.assign(new Error("network"), { code: "unreachable" }));
    xhr.ontimeout = () => reject(Object.assign(new Error("timeout"), { code: "timeout" }));
    xhr.send(fd);
  });
}
async function fetchSwingDigest(portfolio, { signal, save = false, trigger } = {}) {
  if (GAS) return gasJSON("apiDigest", JSON.stringify(portfolio), { save, trigger });
  if (REMOTE) return rpc("digest", portfolio, { save, trigger });
  const r = await fetch(DIGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ portfolio, save, trigger }),
    signal
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error || `http_${r.status}` });
  return j;
}
var GAS = typeof google !== "undefined" && !!(google.script && google.script.run);
var safeUrl = (u) => {
  try {
    const x = new URL(String(u || ""));
    return x.protocol === "https:" ? x.href : void 0;
  } catch {
    return void 0;
  }
};
var LS_API = "swingpulse.api";
var LS_SANDBOX = "swingpulse.sandbox";
var LS_SANDBOX_DB = "swingpulse.sandbox.db";
var lsGet = (k) => {
  try {
    return localStorage.getItem(k) || "";
  } catch {
    return "";
  }
};
var DEFAULT_API = typeof window !== "undefined" && window.SP_API ? String(window.SP_API) : "";
var GAS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
var REMOTE_API = GAS_URL_RE.test(lsGet(LS_API)) ? lsGet(LS_API) : DEFAULT_API;
var SANDBOX = !GAS && lsGet(LS_SANDBOX) === "1";
var SB = (() => {
  const c = typeof window !== "undefined" ? window.SP_SUPABASE : null;
  return c && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(String(c.url || "")) && typeof c.anonKey === "string" ? { url: c.url, anonKey: c.anonKey } : null;
})();
var LS_CLOUD = "swingpulse.cloud";
var LS_PKCE = "swingpulse.pkce";
var CLOUD_FN = SB ? `${SB.url}/functions/v1/sp` : "";
var cloudSession = () => {
  try {
    const j = JSON.parse(localStorage.getItem(LS_CLOUD) || "null");
    return j && j.refresh_token ? j : null;
  } catch {
    return null;
  }
};
var setCloudSession = (v) => {
  try {
    if (v) localStorage.setItem(LS_CLOUD, JSON.stringify(v));
    else localStorage.removeItem(LS_CLOUD);
  } catch {
  }
};
var PENDING_CODE = (() => {
  if (!SB || typeof location === "undefined") return "";
  const q = new URLSearchParams(location.search);
  return q.get("code") && lsGet(LS_PKCE) ? q.get("code") : "";
})();
var CLOUD_ERROR = (() => {
  if (!SB || typeof location === "undefined") return "";
  const q = new URLSearchParams(location.search + "&" + location.hash.slice(1));
  const err = q.get("error") || q.get("error_code") || "";
  const orphan = q.get("code") && !lsGet(LS_PKCE);
  if (err || orphan || q.get("code")) {
    try {
      history.replaceState(null, "", location.pathname + (PENDING_CODE ? `?code=${encodeURIComponent(PENDING_CODE)}` : ""));
    } catch {
    }
  }
  if (err) return err === "access_denied" ? "ההתחברות בוטלה." : "ההתחברות עם Google לא הצליחה. נסו שוב.";
  if (orphan) return "ההתחברות הושלמה בחלון אחר. חזרו לאפליקציה ולחצו שוב על התחברות עם Google.";
  return "";
})();
var isCloud = () => !GAS && !SANDBOX && !!SB && !!(cloudSession() || PENDING_CODE_LEFT());
var b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function startGoogleLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  clearLocalCopy();
  try {
    localStorage.setItem(LS_PKCE, verifier);
    localStorage.removeItem(LS_SANDBOX);
    localStorage.setItem("swingpulse.mode", "live");
  } catch {
  }
  const back = new URL("./", location.href).href;
  location.href = `${SB.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}&code_challenge=${challenge}&code_challenge_method=s256`;
}
async function authToken(body, grant) {
  let r;
  try {
    r = await fetch(`${SB.url}/auth/v1/token?grant_type=${grant}`, { method: "POST", headers: { apikey: SB.anonKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("אין חיבור לאינטרנט"), { code: "unreachable" });
  }
  if (r.status >= 500) throw Object.assign(new Error("שרת ההתחברות לא זמין כרגע"), { code: "unreachable" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error(j.error_description || j.msg || "ההתחברות נכשלה"), { code: "login_required" });
  const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1e3, email: j.user?.email || "" };
  setCloudSession(s);
  return s;
}
var cloudAuthBusy = null;
function cloudToken() {
  if (cloudAuthBusy) return cloudAuthBusy;
  const s = cloudSession();
  if (s && !PENDING_CODE_LEFT() && s.expires_at - Date.now() > 6e4) return Promise.resolve(s.access_token);
  cloudAuthBusy = (async () => {
    try {
      if (PENDING_CODE_LEFT()) {
        const verifier = lsGet(LS_PKCE);
        try {
          localStorage.removeItem(LS_PKCE);
        } catch {
        }
        codeUsed = true;
        try {
          history.replaceState(null, "", location.pathname);
        } catch {
        }
        try {
          return (await authToken({ auth_code: PENDING_CODE, code_verifier: verifier }, "pkce")).access_token;
        } catch (e) {
          CLOUD_ERROR = e.code === "unreachable" ? "אין חיבור לאינטרנט. נסו להתחבר שוב." : "ההתחברות עם Google לא הושלמה. נסו שוב.";
          throw e;
        }
      }
      if (!s) throw Object.assign(new Error("צריך להתחבר"), { code: "login_required" });
      try {
        return (await authToken({ refresh_token: s.refresh_token }, "refresh_token")).access_token;
      } catch (e) {
        if (e.code === "login_required" && cloudSession()?.refresh_token === s.refresh_token) setCloudSession(null);
        throw e;
      }
    } finally {
      cloudAuthBusy = null;
    }
  })();
  return cloudAuthBusy;
}
var codeUsed = false;
var PENDING_CODE_LEFT = () => !!PENDING_CODE && !codeUsed;
async function cloudRpc(fn, args) {
  const token = await cloudToken();
  let r;
  try {
    r = await fetch(CLOUD_FN, { method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: SB.anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ fn, args }), cache: "no-store" });
  } catch {
    throw Object.assign(new Error("אין חיבור לשרת"), { code: "unreachable" });
  }
  const j = await r.json().catch(() => null);
  if (r.status === 401) {
    setCloudSession(null);
    throw Object.assign(new Error("צריך להתחבר מחדש"), { code: "login_required", status: 401 });
  }
  if (!j) throw Object.assign(new Error(`HTTP ${r.status}`), { code: `http_${r.status}` });
  if (!j.ok) throw Object.assign(new Error(j.error?.message || "שגיאה"), { code: j.error?.code || "server_error", status: 500 });
  return j.result;
}
var REMOTE = !GAS && (!!REMOTE_API || SANDBOX || !!SB);
var TOKEN_KEY = "swingpulse.token";
var getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
};
var setToken = (t) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
  }
};
var signedIn = () => isCloud() ? true : !!getToken();
async function rpc(fn, ...args) {
  if (SANDBOX) return sandboxRpc(fn, args);
  if (isCloud()) return cloudRpc(fn, args);
  let r;
  try {
    r = await fetch(REMOTE_API, { method: "POST", body: JSON.stringify({ t: getToken(), fn, args }), redirect: "follow", cache: "no-store" });
  } catch {
    throw Object.assign(new Error("אין חיבור לשרת"), { code: "unreachable" });
  }
  const j = await r.json().catch(() => null);
  if (!j) throw Object.assign(new Error(`HTTP ${r.status}`), { code: `http_${r.status}` });
  if (!j.ok) throw Object.assign(new Error(j.error?.message || "שגיאה"), { code: j.error?.code || "server_error", status: j.error?.code === "login_required" ? 401 : 500 });
  return j.result;
}
var SANDBOX_NO_AI = "בדמו המקומי אין שרת ו-AI. כדי לקבל המלצות וניתוח, חברו חשבון אישי.";
function sandboxSeed() {
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const pos = (ticker, companyName, shares, avgPrice, currentPrice) => ({ ticker, companyName, shares, avgPrice, currentPrice });
  const portfolio = recomputePortfolio({ currency: "USD", cashBalance: 2500, importedAt: at, sample: true, positions: [
    pos("AAPL", "Apple", 15, 185, 228),
    pos("MSFT", "Microsoft", 8, 380, 425),
    pos("NVDA", "NVIDIA", 25, 95, 138),
    pos("AMZN", "Amazon", 12, 160, 198),
    pos("GOOGL", "Alphabet", 14, 140, 172)
  ] });
  const v = (ticker, action, verdict, trailingStop, target) => ({ ticker, action, verdict, bullets: ["דוגמה בלבד, לא המלצה אמיתית."], trailingStop, target, confidence: "medium", dataNote: "" });
  const digest = {
    marketSummary: { tone: "yellow", title: "דוגמה", text: "זה תיק לדוגמה עם מחירים קבועים. כדי לקבל ניתוח אמיתי, חברו חשבון אישי." },
    positions: [
      v("AAPL", "HOLD", "החזק, המגמה יציבה", 210, 245),
      v("MSFT", "ADD", "אפשר לחזק בירידה", 400, 460),
      v("NVDA", "TAKE_PROFIT", "רווח גדול, לממש חלק", 125, 150),
      v("AMZN", "HOLD", "החזק", 182, 215),
      v("GOOGL", "TRIM", "להקטין חשיפה", 160, 185)
    ],
    portfolioNotes: [],
    meta: { at, model: "דוגמה", liveData: false, sample: true }
  };
  return { state: { portfolio, digest, settings: null, alerts: [], meta: {}, orders: [], updatedAt: at }, demo: { portfolio: null, zero: null, digest: null, orders: [], history: [], updatedAt: null } };
}
function sandboxResetDemo(db) {
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const pf = recomputePortfolio({ ...JSON.parse(JSON.stringify(db.state.portfolio)), realizedPnl: 0 });
  const zero = {
    at,
    total: pf.totalPortfolioValue,
    cash: pf.cashBalance,
    realTotal: pf.totalPortfolioValue,
    positions: pf.positions.map((p) => ({ ticker: p.ticker, shares: p.shares, avgPrice: p.avgPrice, price: p.currentPrice }))
  };
  db.demo = {
    portfolio: pf,
    zero,
    digest: db.state.digest,
    orders: [],
    updatedAt: at,
    history: [{ at, action: "נקודת אפס", ticker: "", shares: "", price: "", amount: zero.total, realized: "", source: "system", note: "תיק לדוגמה" }]
  };
  return db;
}
var sandboxDB = () => loadJSON(LS_SANDBOX_DB, null) || sandboxResetDemo(sandboxSeed());
var sandboxFail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
async function sandboxRpc(fn, args) {
  const db = sandboxDB();
  const save = () => {
    saveJSON(LS_SANDBOX_DB, db);
    return db;
  };
  const view = () => ({ ...db.demo });
  const trade = (trades, source) => {
    const res = applyTrades(db.demo.portfolio, trades, { source });
    if (!res.log.length) sandboxFail("trade_failed", res.results.map((x) => x.error).filter(Boolean).join(" ") || "הפעולה נכשלה");
    db.demo.portfolio = res.portfolio;
    db.demo.history = res.log.map((e) => ({ at: e.at, action: TRADE_HE[e.type] || e.type, ticker: e.ticker, shares: e.shares, price: e.price, amount: e.amount, realized: e.realized, source: e.source, note: e.note || "" })).reverse().concat(db.demo.history || []).slice(0, 60);
    db.demo.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    save();
    return { mode: "demo", results: res.results, log: res.log, demo: view(), orders: db.demo.orders || [] };
  };
  switch (fn) {
    case "health":
      return { ok: true, auth: true, authed: true, storage: true, keySet: true, sandbox: true, platform: "sandbox", version: APP_VERSION, telegram: false, agent: false, pushSubs: 0 };
    case "getState":
      return { ...db.state };
    case "putState": {
      const p = args[0] || {};
      ["settings", "alerts"].forEach((k) => {
        if (k in p) db.state[k] = p[k];
      });
      save();
      return { ...db.state };
    }
    case "quotes":
      return { quotes: {}, failed: [], at: (/* @__PURE__ */ new Date()).toISOString() };
    case "getDemo":
      return view();
    case "demoReset":
      sandboxResetDemo(db);
      save();
      return view();
    case "putDemo": {
      const p = args[0] || {};
      if (p.portfolio) db.demo.portfolio = p.portfolio;
      if ("digest" in p) db.demo.digest = p.digest;
      save();
      return view();
    }
    case "applyTrades":
      if (args[1] !== "demo") sandboxFail("bad_mode", "בדמו המקומי אין תיק אמיתי.");
      return trade(args[0] || [], args[2] || "chat");
    case "placeOrder": {
      if (args[1] !== "demo") sandboxFail("bad_mode", "בדמו המקומי אין תיק אמיתי.");
      const o = args[0] || {};
      if (o.orderType === "LIMIT") sandboxFail("sandbox", "פקודת לימיט צריכה מחירים חיים. זמינה בחשבון אישי.");
      return trade([{ type: o.type, ticker: o.ticker, shares: o.shares, price: o.price }], "ידני");
    }
    case "cancelOrder":
    case "fillOrder":
      return { mode: "demo", orders: db.demo.orders || [] };
    case "latestAlerts":
      return [];
    default:
      return sandboxFail("sandbox", SANDBOX_NO_AI);
  }
}
var LS_OWNER = "swingpulse.owner";
function clearLocalCopy() {
  try {
    for (const k of ["swingpulse.data.v2", "swingpulse.alerts.v2", LS_OWNER, "swingpulse.alertsSeenAt", "swingpulse.analysts"]) localStorage.removeItem(k);
  } catch {
  }
}
async function forgetDevice() {
  try {
    const reg = typeof navigator !== "undefined" && navigator.serviceWorker && await navigator.serviceWorker.getRegistration("./sw.js");
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      try {
        await rpc("removePushSub", sub.endpoint);
      } catch {
      }
      await sub.unsubscribe();
    }
  } catch {
  }
  try {
    if (typeof caches !== "undefined") await caches.delete("sp-config");
  } catch {
  }
}
function enterSandbox() {
  clearLocalCopy();
  try {
    localStorage.setItem(LS_SANDBOX, "1");
    localStorage.setItem("swingpulse.mode", "demo");
    if (!localStorage.getItem(LS_SANDBOX_DB)) saveJSON(LS_SANDBOX_DB, sandboxResetDemo(sandboxSeed()));
  } catch {
  }
  window.location.reload();
}
function leaveSandbox() {
  clearLocalCopy();
  try {
    localStorage.removeItem(LS_SANDBOX);
    localStorage.setItem("swingpulse.mode", "live");
  } catch {
  }
  window.location.reload();
}
async function remoteExtract(files, { onUpload } = {}) {
  const CHUNK = 6, PARALLEL = 2;
  const chunks = [];
  for (let i = 0; i < files.length; i += CHUNK) chunks.push(files.slice(i, i + CHUNK));
  const results = new Array(chunks.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const start = i * CHUNK;
      const images = [];
      for (const f of chunks[i]) images.push({ mimeType: f.type || "image/jpeg", data: await toBase64(f) });
      try {
        results[i] = { ok: true, json: await rpc("extractChunk", images, start, files.length) };
      } catch (e) {
        results[i] = { ok: false, error: e, screenshots: [start + 1, start + chunks[i].length] };
      }
      done++;
      if (onUpload) onUpload(Math.min(0.99, done / chunks.length));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
  const ok = results.filter((r) => r.ok);
  if (!ok.length) throw results[0].error;
  const merged = await rpc("mergeExtraction", ok.map((r) => r.json), {
    screenshots: files.length,
    chunks: chunks.length,
    ms: Date.now() - t0,
    unreadable: [],
    failedChunks: results.filter((r) => !r.ok).map((r) => ({ screenshots: r.screenshots, error: r.error.message }))
  });
  if (onUpload) onUpload(1);
  return merged;
}
var urlB64ToBytes = (s) => {
  const b = atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
var pushSupported = () => REMOTE && !SANDBOX && typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
async function swReady() {
  const reg = await navigator.serviceWorker.register("./sw.js");
  await navigator.serviceWorker.ready;
  if (!isCloud()) {
    const cache = await caches.open("sp-config");
    await cache.put("./sp-config.json", new Response(JSON.stringify({ api: REMOTE_API, t: getToken() })));
  }
  return reg;
}
async function enablePush(vapidPublicKey) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw Object.assign(new Error("ההרשאה להתראות לא ניתנה בדפדפן"), { code: "denied" });
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapidPublicKey) });
  const ua = navigator.userAgent;
  const device = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "Windows" : "Device";
  const r = await rpc("savePushSub", { endpoint: sub.endpoint, device });
  if (r && r.pk && isCloud()) await (await caches.open("sp-config")).put("./sp-config.json", new Response(JSON.stringify({ api: CLOUD_FN, pk: r.pk })));
  return r;
}
async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("./sw.js");
  const sub = reg && await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}
function gasCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler((err) => {
      const raw = String(err && err.message || err || "");
      let info = null;
      try {
        info = JSON.parse(raw.slice(raw.indexOf("{")));
      } catch {
      }
      reject(Object.assign(new Error(info ? info.message : raw), { code: info ? info.code : /timed out|exceeded maximum/i.test(raw) ? "timeout" : "server_error" }));
    })[fn](...args);
  });
}
var gasJSON = (fn, ...args) => gasCall(fn, ...args).then((t) => typeof t === "string" ? JSON.parse(t) : t);
var toBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] || "");
  r.onerror = () => rej(r.error);
  r.readAsDataURL(file);
});
async function gasExtract(files, { onUpload } = {}) {
  const CHUNK = 6, PARALLEL = 2;
  const chunks = [];
  for (let i = 0; i < files.length; i += CHUNK) chunks.push(files.slice(i, i + CHUNK));
  const results = new Array(chunks.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const start = i * CHUNK;
      const images = [];
      for (const f of chunks[i]) images.push({ mimeType: f.type || "image/jpeg", data: await toBase64(f) });
      try {
        results[i] = { ok: true, json: await gasCall("apiExtractChunk", images, start, files.length) };
      } catch (e) {
        results[i] = { ok: false, error: e, screenshots: [start + 1, start + chunks[i].length] };
      }
      done++;
      if (onUpload) onUpload(Math.min(0.99, done / chunks.length));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
  const ok = results.filter((r) => r.ok);
  if (!ok.length) throw results[0].error;
  const merged = await gasJSON("apiMergeExtraction", ok.map((r) => r.json), {
    screenshots: files.length,
    chunks: chunks.length,
    ms: Date.now() - t0,
    unreadable: [],
    failedChunks: results.filter((r) => !r.ok).map((r) => ({ screenshots: r.screenshots, error: r.error.message }))
  });
  if (onUpload) onUpload(1);
  return merged;
}
var saveSecrets = (s) => REMOTE ? rpc("saveSecrets", s) : gasCall("apiSaveSecrets", s);
async function apiJSON(url, opts = {}) {
  const r = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...opts,
    headers: { ...opts.body ? { "Content-Type": "application/json" } : {}, ...opts.headers || {} }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error || `http_${r.status}`, status: r.status });
  return j;
}
var fetchState = () => REMOTE ? rpc("getState") : GAS ? gasJSON("apiGetState") : apiJSON(STATE_URL);
var putState = (patch) => REMOTE ? rpc("putState", patch) : GAS ? gasJSON("apiPutState", JSON.stringify(patch)) : apiJSON(STATE_URL, { method: "PUT", body: JSON.stringify(patch) });
var login = async (password, apiUrl) => {
  if (!REMOTE) return apiJSON(LOGIN_URL, { method: "POST", body: JSON.stringify({ password }) });
  const url = String(apiUrl || REMOTE_API).trim();
  if (url !== DEFAULT_API && !GAS_URL_RE.test(url)) throw Object.assign(new Error("כתובת לא תקינה. מדביקים את כתובת ה-Web App שמסתיימת ב-/exec"), { code: "bad_url" });
  const prev = getToken(), prevApi = REMOTE_API;
  setToken(password.trim());
  REMOTE_API = url;
  try {
    const h = await rpc("health");
    try {
      if (url === DEFAULT_API) localStorage.removeItem(LS_API);
      else localStorage.setItem(LS_API, url);
    } catch {
    }
    if (lsGet(LS_OWNER) !== `gas:${url}`) clearLocalCopy();
    if (cloudSession()) setCloudSession(null);
    return h;
  } catch (e) {
    setToken(prev);
    REMOTE_API = prevApi;
    throw e.code === "login_required" ? Object.assign(new Error("קוד גישה שגוי"), { code: e.code }) : e.code === "unreachable" || e.code?.startsWith("http_") ? Object.assign(new Error('לא הצלחתי להתחבר לשרת. בדקו את הכתובת ושהגישה היא "כולם".'), { code: e.code }) : e;
  }
};
var logout = async () => {
  await forgetDevice();
  clearLocalCopy();
  if (isCloud()) {
    const s = cloudSession();
    if (s) {
      try {
        await fetch(`${SB.url}/auth/v1/logout`, { method: "POST", headers: { apikey: SB.anonKey, Authorization: `Bearer ${s.access_token}` } });
      } catch {
      }
    }
    setCloudSession(null);
    return { ok: true };
  }
  if (REMOTE) {
    setToken("");
    return { ok: true };
  }
  return apiJSON(LOGOUT_URL, { method: "POST" });
};
var testTelegram = () => REMOTE ? rpc("testTelegram") : GAS ? gasCall("apiTestTelegram") : apiJSON(TELEGRAM_TEST_URL, { method: "POST" });
var testPush = () => rpc("testPush");
async function fetchCandles(ticker, range = "1y") {
  if (REMOTE) return rpc("candles", ticker, range);
  if (GAS) return gasJSON("apiCandles", ticker, range);
  const r = await fetch(`${API_BASE}/api/v1/candles?symbol=${encodeURIComponent(ticker)}&range=${range}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error || `http_${r.status}` });
  return j;
}
async function fetchQuotes(tickers) {
  if (GAS) return gasJSON("apiQuotes", tickers);
  if (REMOTE) return rpc("quotes", tickers);
  const r = await fetch(`${QUOTES_URL}?symbols=${encodeURIComponent(tickers.join(","))}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error || `http_${r.status}` });
  return j;
}
function applyLiveQuotes(portfolio, quotes, at) {
  let hits = 0;
  const positions = (portfolio.positions || []).map((p) => {
    const q = quotes[String(p.ticker).toUpperCase()];
    const cur = p.currency || portfolio.currency;
    if (!q || !(q.price > 0) || cur && q.currency && String(cur).toUpperCase() !== String(q.currency).toUpperCase()) return p;
    hits++;
    const shares = Number(p.shares) || 0, avg = Number(p.avgPrice) || 0;
    return {
      ...p,
      currentPrice: q.price,
      marketValue: shares ? Math.round(shares * q.price * 100) / 100 : p.marketValue,
      unrealizedPnlPct: avg ? Math.round((q.price / avg - 1) * 1e4) / 100 : p.unrealizedPnlPct,
      live: q
    };
  });
  const invested = positions.reduce((a, p) => a + (Number(p.marketValue) || 0), 0);
  const total = invested + (Number(portfolio.cashBalance) || 0);
  positions.forEach((p) => {
    p.allocationPct = total ? Math.round((Number(p.marketValue) || 0) / total * 1e4) / 100 : p.allocationPct;
  });
  positions.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  return {
    ...portfolio,
    positions,
    totalPortfolioValue: hits ? Math.round(total * 100) / 100 : portfolio.totalPortfolioValue,
    blinkReportedTotal: portfolio.blinkReportedTotal ?? portfolio.totalPortfolioValue ?? null,
    liveAt: hits ? at : portfolio.liveAt,
    liveCount: hits
  };
}
async function fetchHealth() {
  if (GAS) return gasCall("apiHealth").catch(() => null);
  if (SANDBOX) return rpc("health");
  if (REMOTE) {
    if (!signedIn()) return { ok: true, auth: true, authed: false };
    return rpc("health").catch((e) => e.code === "login_required" ? { ok: true, auth: true, authed: false } : null);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3e3);
  try {
    const r = await fetch(HEALTH_URL, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
var fmt = (x, d = 2) => x == null || Number.isNaN(Number(x)) ? "—" : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
var currencySymbol = (c) => c === "ILS" ? "₪" : "$";
var money = (x, c, d = 0) => x == null ? "—" : `${x < 0 ? "−" : ""}${currencySymbol(c)}${fmt(Math.abs(x), d)}`;
var signedMoney = (x, c, d = 0) => x == null ? "—" : `${x >= 0 ? "+" : "−"}${currencySymbol(c)}${fmt(Math.abs(x), d)}`;
var signedPct = (x, d = 1) => x == null ? "—" : `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x), d)}%`;
var qty = (x) => x == null ? "—" : fmt(x, Number(x) % 1 ? 4 : 0);
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}
var validDate = (d) => d != null && !Number.isNaN(new Date(d).getTime());
var timeFmt = (d) => validDate(d) ? new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(d)) : "—";
var dateTimeFmt = (d) => validDate(d) ? new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d)) : "—";
function isUsMarketOpen(now = /* @__PURE__ */ new Date()) {
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const o = {};
  ny.forEach((p) => {
    o[p.type] = p.value;
  });
  if (o.weekday === "Sat" || o.weekday === "Sun") return false;
  const mins = +o.hour % 24 * 60 + +o.minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
function nextEndOfDay(from = /* @__PURE__ */ new Date()) {
  for (let i = 0; i < 8; i++) {
    const probe = new Date(from.getTime() + i * 864e5);
    const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(probe);
    const o = {};
    ny.forEach((p) => {
      o[p.type] = p.value;
    });
    if (o.weekday === "Sat" || o.weekday === "Sun") continue;
    const guess = new Date(Date.UTC(+o.year, +o.month - 1, +o.day, 16, 15));
    const back = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(guess);
    const b = {};
    back.forEach((p) => {
      b[p.type] = p.value;
    });
    const shown = Date.UTC(+b.year, +b.month - 1, +b.day, +b.hour % 24, +b.minute);
    const run = new Date(guess.getTime() - (shown - guess.getTime()));
    if (run > from) return run;
  }
  return null;
}
function computeNextRun(settings, from = /* @__PURE__ */ new Date()) {
  const f = FREQUENCIES.find((x) => x.id === settings.frequency);
  if (!f || f.id === "off") return null;
  if (f.id === "eod") return nextEndOfDay(from);
  return new Date(from.getTime() + f.ms);
}
function countdown(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor(ms / 1e3));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob ? new File([blob], (file.name || "shot").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}
function validStop(v, price) {
  if (!v || v.trailingStop == null) return null;
  if (price != null && v.trailingStop >= price && !["TAKE_PROFIT", "CUT_LOSS"].includes(v.action)) return null;
  return v.trailingStop;
}
function stopRoom(price, stop) {
  return price != null && stop != null && price > 0 ? (price - stop) / price * 100 : null;
}
function enrichPosition(p) {
  const shares = p.shares ?? null;
  const value = p.marketValue ?? (shares != null && p.currentPrice != null ? shares * p.currentPrice : null);
  const cost = shares != null && p.avgPrice != null ? shares * p.avgPrice : null;
  const pnl = value != null && cost != null ? value - cost : null;
  const pnlPct = p.unrealizedPnlPct ?? (cost ? (value / cost - 1) * 100 : null);
  return { ...p, value, cost, pnl, pnlPct };
}
function mergePortfolios(base, add) {
  const map = new Map((base.positions || []).map((p) => [p.ticker, p]));
  for (const p of add.positions || []) map.set(p.ticker, { ...map.get(p.ticker) || {}, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)) });
  const positions = [...map.values()];
  const cash = add.cashBalance ?? base.cashBalance ?? null;
  const reported = add.totalPortfolioValue ?? null;
  const equity = positions.reduce((s, p) => s + (p.marketValue ?? (p.shares != null && p.currentPrice != null ? p.shares * p.currentPrice : 0)), 0);
  const total = reported ?? equity + (cash || 0);
  positions.forEach((p) => {
    const v = p.marketValue ?? (p.shares != null && p.currentPrice != null ? p.shares * p.currentPrice : null);
    p.allocationPct = total && v != null ? Math.round(v / total * 1e4) / 100 : null;
  });
  positions.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  return {
    ...base,
    currency: add.currency || base.currency,
    cashBalance: cash,
    totalPortfolioValue: reported,
    positions,
    meta: {
      ...add.meta || {},
      screenshots: (base.meta?.screenshots || 0) + (add.meta?.screenshots || 0),
      conflicts: add.meta?.conflicts || [],
      warnings: [...add.meta?.warnings || [], "מוזג עם הייבוא הקודם — בדקו שאין פוזיציה שנסגרה מאז"]
    }
  };
}
function buildAlerts(prevDigest, nextDigest, portfolio, settings, trigger) {
  const prev = new Map((prevDigest?.positions || []).map((v) => [v.ticker, v.action]));
  const alloc = new Map((portfolio?.positions || []).map((p) => [p.ticker, p.allocationPct ?? 0]));
  const out = [];
  const at = (/* @__PURE__ */ new Date()).toISOString();
  for (const v of nextDigest?.positions || []) {
    const a = ACTIONS[v.action];
    if (!a) continue;
    if ((alloc.get(v.ticker) ?? 0) < settings.minAllocationPct) continue;
    const before = prev.get(v.ticker);
    const changed = before != null && before !== v.action;
    const typeOn = settings.alertTypes[a.kind] === true;
    const changeOn = settings.alertTypes.change && changed;
    if (!(typeOn || changeOn)) continue;
    if (prevDigest && !changed && a.kind !== "sell") continue;
    out.push({
      id: `${at}-${v.ticker}`,
      at,
      ticker: v.ticker,
      action: v.action,
      from: changed ? before : null,
      text: v.verdict,
      stop: v.trailingStop ?? null,
      trigger
    });
  }
  return out;
}
var ICON_PATHS = {
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5",
  x: "M18 6 6 18M6 6l12 12",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01",
  brain: "M12 5a3 3 0 1 0-5.9.8A4 4 0 0 0 4 12a4 4 0 0 0 3 6 3 3 0 0 0 5 1V5Zm0 0a3 3 0 1 1 5.9.8A4 4 0 0 1 20 12a4 4 0 0 1-3 6 3 3 0 0 1-5 1",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  dash: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  table: "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14",
  sliders: "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  sort: "m7 15 5 5 5-5M7 9l5-5 5 5",
  chevron: "m6 9 6 6 6-6",
  sun: "M12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  sheet: "M4 3h16v18H4zM4 9h16M4 15h16M10 3v18",
  key: "M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7Zm1.5 1.5h.01",
  send: "M3 12h13M10 5l-7 7 7 7"
};
function Icon({ name, className = "h-4 w-4", spin = false }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: `${className} flex-none ${spin ? "animate-spin" : ""}`,
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx("path", { d: ICON_PATHS[name] })
    }
  );
}
function Pill({ tone = "gray", children, title }) {
  return /* @__PURE__ */ jsxs("span", { title, className: `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASSES[tone]}`, children: [
    /* @__PURE__ */ jsx("span", { className: "h-1.5 w-1.5 rounded-full bg-current" }),
    children
  ] });
}
function ActionBadge({ action, waiting = false, showDetail = false }) {
  const a = ACTIONS[action];
  if (!a) return /* @__PURE__ */ jsx(Pill, { tone: "gray", children: waiting ? "ממתין…" : "אין המלצה" });
  return /* @__PURE__ */ jsxs(Pill, { tone: a.tone, title: a.detail, children: [
    a.badge,
    showDetail && /* @__PURE__ */ jsxs("span", { className: "font-normal opacity-80", children: [
      "· ",
      a.detail
    ] })
  ] });
}
function Toggle({ on, onChange, label }) {
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": on,
      "aria-label": label,
      onClick: () => onChange(!on),
      className: `relative h-[26px] w-11 flex-none rounded-full transition-colors ${on ? "bg-[#30d158]" : "bg-[color:var(--toggle-off)]"}`,
      children: /* @__PURE__ */ jsx("span", { className: `absolute top-[3px] h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[3px]" : "left-[21px]"}` })
    }
  );
}
function Kpi({ label, value, sub, big = false }) {
  return /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
    /* @__PURE__ */ jsx("div", { className: "mb-1 text-xs text-[color:var(--fg-3)]", children: label }),
    /* @__PURE__ */ jsx("div", { className: `${big ? "text-3xl" : "text-2xl"} truncate font-bold tabular-nums`, children: value }),
    sub != null && sub !== "" && /* @__PURE__ */ jsx("div", { className: "mt-0.5 text-xs text-[color:var(--fg-3)]", children: sub })
  ] });
}
function Cell({ label, value }) {
  return /* @__PURE__ */ jsxs("div", { className: "rounded-xl bg-[color:var(--inset)] px-2 py-2 text-center", children: [
    /* @__PURE__ */ jsx("div", { className: "text-[11px] text-[color:var(--fg-3)]", children: label }),
    /* @__PURE__ */ jsx("div", { className: "text-sm font-semibold tabular-nums", children: value })
  ] });
}
function Num({ children, className = "" }) {
  return /* @__PURE__ */ jsx("span", { dir: "ltr", className: `inline-block tabular-nums ${className}`, children });
}
var THEME_TOKENS = {
  dark: {
    bg: "#0A0D12",
    sheet: "#0D1118",
    card: "#121721",
    "card-hover": "#171D29",
    inset: "#0D1118",
    input: "#0A0D12",
    tint: "rgba(255,255,255,0.05)",
    "tint-2": "rgba(255,255,255,0.09)",
    line: "rgba(255,255,255,0.08)",
    "line-2": "rgba(255,255,255,0.14)",
    "line-soft": "rgba(255,255,255,0.05)",
    fg: "#F3F4F6",
    "fg-2": "rgba(243,244,246,0.74)",
    "fg-3": "rgba(243,244,246,0.52)",
    "fg-4": "rgba(243,244,246,0.46)",
    header: "rgba(10,13,18,0.72)",
    nav: "rgba(18,23,33,0.97)",
    "toggle-off": "#2A3140",
    "hero-from": "#151B27",
    "hero-to": "#10141D",
    overlay: "rgba(3,5,8,0.62)",
    inverse: "#F3F4F6",
    "inverse-fg": "#0A0D12",
    up: "#32D74B",
    down: "#FF5A4E",
    warn: "#FFD60A",
    accent: "#3B9BFF",
    "up-bg": "rgba(50,215,75,0.14)",
    "down-bg": "rgba(255,90,78,0.14)",
    "warn-bg": "rgba(255,214,10,0.12)",
    "accent-bg": "rgba(59,155,255,0.15)",
    "warn-line": "rgba(255,214,10,0.30)",
    "accent-line": "rgba(59,155,255,0.40)",
    "up-line": "rgba(50,215,75,0.30)",
    "down-line": "rgba(255,90,78,0.32)",
    shadow: "none",
    "seg-pill": "rgba(255,255,255,0.10)",
    "seg-shadow": "none"
  },
  light: {
    bg: "#F8FAFC",
    sheet: "#F8FAFC",
    card: "#FFFFFF",
    "card-hover": "#FBFCFE",
    inset: "#F1F5F9",
    input: "#FFFFFF",
    tint: "rgba(15,23,42,0.04)",
    "tint-2": "rgba(15,23,42,0.07)",
    line: "#E2E8F0",
    "line-2": "#CBD5E1",
    "line-soft": "#EEF2F6",
    fg: "#0F172A",
    "fg-2": "#334155",
    "fg-3": "#64748B",
    "fg-4": "#7C8BA1",
    header: "rgba(248,250,252,0.82)",
    nav: "rgba(255,255,255,0.97)",
    "toggle-off": "#CBD5E1",
    "hero-from": "#FFFFFF",
    "hero-to": "#F8FAFC",
    overlay: "rgba(15,23,42,0.36)",
    inverse: "#0F172A",
    "inverse-fg": "#FFFFFF",
    up: "#15803D",
    down: "#DC2626",
    warn: "#B45309",
    accent: "#2563EB",
    "up-bg": "rgba(22,163,74,0.12)",
    "down-bg": "rgba(220,38,38,0.10)",
    "warn-bg": "rgba(217,119,6,0.12)",
    "accent-bg": "rgba(37,99,235,0.10)",
    "warn-line": "rgba(217,119,6,0.35)",
    "accent-line": "rgba(37,99,235,0.35)",
    "up-line": "rgba(22,163,74,0.30)",
    "down-line": "rgba(220,38,38,0.30)",
    shadow: "0 2px 10px rgba(15,23,42,0.05)",
    "seg-pill": "#FFFFFF",
    "seg-shadow": "0 1px 3px rgba(15,23,42,0.12), 0 0 0 1px rgba(15,23,42,0.04)"
  }
};
var tokenBlock = (t) => Object.entries(THEME_TOKENS[t]).map(([k, v]) => `--${k}:${v};`).join("");
var STAGGER = Array.from({ length: 24 }, (_, i) => `.sp-stagger>*:nth-child(${i + 1}){animation-delay:${i * 40}ms}`).join("");
var GLOBAL_CSS = `
:root,[data-theme=dark]{${tokenBlock("dark")}color-scheme:dark}
[data-theme=light]{${tokenBlock("light")}color-scheme:light}
:root{--spring:cubic-bezier(0.22,1,0.36,1);--ease-sheet:cubic-bezier(0.16,1,0.3,1)}
html,body{background:var(--bg);color:var(--fg);transition:background-color .3s ease,color .3s ease}
[data-theme=light] [class*="bg-[color:var(--card)]"]{box-shadow:var(--shadow)}
.sp-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
:root{--chart-h:360px}
@media (min-width:640px){:root{--chart-h:480px}}
.sp-chart{position:relative;width:100%;height:var(--chart-h);min-height:var(--chart-h);overflow:hidden;border-radius:14px;background:var(--card);border:1px solid var(--line)}
.sp-chart.tradingview-widget-container,
.sp-chart .tradingview-widget-container__widget,
.sp-chart .tradingview-widget-container__widget>div,
.sp-chart iframe{width:100%!important;height:var(--chart-h)!important;min-height:var(--chart-h)!important;display:block!important;border:0}
.sp-chart-msg{position:absolute;inset:0;display:grid;place-items:center;font-size:.875rem;color:var(--fg-3)}

/* metric cards: label on top, value right under it, both on the right edge (RTL start) */
.sp-metric{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:.3rem;text-align:right;min-width:0}
.sp-metric-label{font-size:.78rem;font-weight:500;line-height:1.2;color:var(--fg-3)}
.sp-metric-value{align-self:flex-start;direction:ltr;unicode-bidi:isolate;text-align:right;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:15px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}

/* tactile press feedback */
button,[role=button],[role=tab],summary,a,.sp-press{-webkit-tap-highlight-color:transparent;transition-property:transform,background-color,border-color,color,box-shadow,opacity;transition-duration:.32s;transition-timing-function:var(--spring)}
button:not(:disabled):active,[role=button]:active,[role=tab]:active,summary:active,a:active,.sp-press:active{transform:scale(0.96)!important;transition-duration:.09s}
.sp-press-soft:not(:disabled):active{transform:scale(0.985)!important}

/* modal / bottom sheet */
@keyframes sp-fade{from{opacity:0}to{opacity:1}}
@keyframes sp-fade-out{from{opacity:1}to{opacity:0}}
@keyframes sp-sheet-in{from{transform:translateY(32px)}to{transform:none}}
@keyframes sp-sheet-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(28px)}}
.sp-fade{animation:sp-fade .25s ease both}
.sp-overlay{background:var(--overlay);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);animation:sp-fade .32s var(--ease-sheet) both}
.sp-overlay[data-closing]{animation:sp-fade-out .22s ease both}
.sp-sheet{animation:sp-sheet-in .32s var(--ease-sheet) both}
.sp-sheet[data-closing]{animation:sp-sheet-out .22s cubic-bezier(0.4,0,1,1) both}

/* staggered entrance */
@keyframes sp-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.sp-stagger>*{animation:sp-rise .46s var(--spring) backwards}
.sp-tab{animation:sp-rise .4s var(--spring) backwards}
${STAGGER}

/* sliding segmented control */
.sp-seg-pill{position:absolute;left:0;top:0;border-radius:.6rem;background:var(--seg-pill);box-shadow:var(--seg-shadow);pointer-events:none;
  transition:transform .42s var(--spring),width .42s var(--spring),height .42s var(--spring)}
.sp-seg-pill[data-instant]{transition:none}
.sp-seg-pill.sp-accent{background:var(--accent-bg);box-shadow:none}

/* accordion */
.sp-acc{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .36s var(--spring),opacity .28s ease}
.sp-acc[data-open=true]{grid-template-rows:1fr;opacity:1}
.sp-acc>div{min-height:0;overflow:hidden}

/* RTL lists with custom markers */
.sp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.45rem}
.sp-list>li{position:relative;padding-inline-start:1rem;line-height:1.55;text-align:right}
.sp-list>li::before{content:"";position:absolute;inset-inline-start:0;top:.62em;width:.38rem;height:.38rem;border-radius:999px;background:var(--marker,var(--fg-4))}

/* popover */
@keyframes sp-pop{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}
.sp-pop{animation:sp-pop .26s var(--spring) both;transform-origin:top left}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-delay:0ms!important;transition-duration:.01ms!important}}
`;
if (typeof document !== "undefined" && !document.getElementById("sp-css")) {
  const el = document.createElement("style");
  el.id = "sp-css";
  el.textContent = GLOBAL_CSS;
  document.head.appendChild(el);
  document.addEventListener("touchstart", () => {
  }, { passive: true });
}
var ThemeCtx = createContext("dark");
var useTheme = () => useContext(ThemeCtx);
function initialTheme() {
  try {
    const t = localStorage.getItem(LS_THEME);
    if (t === "light" || t === "dark") return t;
  } catch {
  }
  return "dark";
}
function useThemeState() {
  const [theme, setTheme] = useState(initialTheme);
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_TOKENS[theme].bg);
    try {
      localStorage.setItem(LS_THEME, theme);
    } catch {
    }
  }, [theme]);
  return [theme, () => setTheme((t) => t === "dark" ? "light" : "dark")];
}
function ThemeToggle({ theme, onToggle }) {
  const dark = theme === "dark";
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick: onToggle,
      "aria-label": dark ? "מעבר למצב בהיר" : "מעבר למצב כהה",
      title: dark ? "מצב בהיר" : "מצב כהה",
      className: "relative grid h-10 w-10 flex-none place-items-center overflow-hidden rounded-xl border border-[color:var(--line-2)] hover:bg-[color:var(--tint)]",
      children: [
        /* @__PURE__ */ jsx("span", { className: `absolute transition-all duration-500 ${dark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0"}`, children: /* @__PURE__ */ jsx(Icon, { name: "moon" }) }),
        /* @__PURE__ */ jsx("span", { className: `absolute transition-all duration-500 ${dark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"}`, children: /* @__PURE__ */ jsx(Icon, { name: "sun" }) })
      ]
    }
  );
}
function Segmented({ options, value, onChange, ariaLabel, className = "", itemClass = "px-3 py-1.5", pillClass = "", activeClass = "text-[color:var(--fg)]", idleClass = "text-[color:var(--fg-3)] hover:text-[color:var(--fg)]", render }) {
  const wrap = useRef(null);
  const [ind, setInd] = useState(null);
  const moved = useRef(false);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return void 0;
    const measure = () => {
      const b = el.querySelector('[data-active="true"]');
      if (b) setInd({ x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    return () => {
      if (ro) ro.disconnect();
    };
  }, [value, options.length]);
  useEffect(() => {
    if (ind) moved.current = true;
  }, [ind]);
  return /* @__PURE__ */ jsxs("div", { ref: wrap, role: "tablist", "aria-label": ariaLabel, className: `relative flex ${className}`, children: [
    ind && /* @__PURE__ */ jsx(
      "span",
      {
        "aria-hidden": "true",
        "data-instant": moved.current ? void 0 : "",
        className: `sp-seg-pill ${pillClass}`,
        style: { transform: `translate(${ind.x}px, ${ind.y}px)`, width: ind.w, height: ind.h }
      }
    ),
    options.map((o) => {
      const on = o.id === value;
      return /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": on,
          "data-active": on,
          onClick: () => onChange(o.id),
          className: `relative z-[1] ${itemClass} ${on ? activeClass : idleClass}`,
          children: render ? render(o, on) : o.label
        },
        String(o.id)
      );
    })
  ] });
}
function Accordion({ title, defaultOpen = false, tone = "warn", children }) {
  const [open, setOpen] = useState(defaultOpen);
  return /* @__PURE__ */ jsxs("section", { className: "rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] text-sm", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        "aria-expanded": open,
        onClick: () => setOpen((o) => !o),
        className: "sp-press-soft flex w-full items-center gap-2 rounded-2xl px-4 py-3.5 text-start",
        children: [
          /* @__PURE__ */ jsx("span", { className: "font-semibold", style: { color: `var(--${tone})` }, children: title }),
          /* @__PURE__ */ jsx("span", { className: `ms-auto text-[color:var(--fg-3)] transition-transform duration-300 ${open ? "rotate-180" : ""}`, children: /* @__PURE__ */ jsx(Icon, { name: "chevron" }) })
        ]
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "sp-acc", "data-open": open, children: /* @__PURE__ */ jsx("div", { inert: open ? void 0 : "", children: /* @__PURE__ */ jsx("div", { className: "px-4 pb-4", children }) }) })
  ] });
}
var NOTE_HEBREW = /[֐-׿]/;
var NOTE_BOILERPLATE = [
  /not (explicitly )?(displayed|shown|stated|visible|provided|available)/i,
  /(is|are) (missing|absent|not present)/i,
  /(company names?|current (share )?price|cash balance|total (portfolio )?value).{0,40}(not|n't)/i,
  /(לא|אינו|אינם|אינה)\s+(מוצג|מופיע|נראה|מצוין|זמין)\S*.{0,30}(מחיר נוכחי|שער נוכחי|יתרה|מזומן|שם החברה|שמות החברות|שווי כולל)/,
  /(מחיר נוכחי|שער נוכחי|יתרה|מזומן|שם החברה|שמות החברות|שווי כולל).{0,40}(לא|אינו|אינם|אינה)\s+(מוצג|מופיע|נראה|מצוין|זמין)/
];
var NOTE_LEGACY = [
  [/^(\S+): (shares|avgPrice) differs between screenshots \(([^)]+) vs ([^)]+)\).*$/, (m, t, k, a, b) => `${t}: ${k === "shares" ? "הכמות" : "שער הקנייה"} שונה בין הצילומים (${a} מול ${b}). נשמר הערך הראשון.`],
  [/^Reported total (\S+) vs positions\+cash (\S+) \(gap (\S+)\).*$/, (m, a, b, g) => `סך התיק בבלינק (${a}) שונה מסכום הפוזיציות והמזומן (${b}), פער של ${g}. ייתכן שפוזיציה חסרה או נקראה לא נכון.`],
  [/^(\S+): stop (\S+) ≥ price (\S+).*$/, (m, t, s, p) => `${t}: הסטופ שהוצע (${s}) לא מתחת למחיר (${p}), ולכן הוסר.`],
  [/^(\S+): target (\S+) ≤ price (\S+).*$/, (m, t, s, p) => `${t}: היעד שהוצע (${s}) לא מעל המחיר (${p}), ולכן הוסר.`],
  [/^(\S+): no verdict returned$/, (m, t) => `${t}: Gemini לא החזיר המלצה למניה הזו.`]
];
function cleanNotes(list) {
  const out = [], seen = /* @__PURE__ */ new Set();
  for (const raw of list || []) {
    let t = String(raw || "").replace(/\s+/g, " ").trim();
    for (const [re, fn] of NOTE_LEGACY) if (re.test(t)) {
      t = t.replace(re, fn);
      break;
    }
    if (!t || NOTE_BOILERPLATE.some((re) => re.test(t))) continue;
    if (!NOTE_HEBREW.test(t)) t = "Gemini דיווח על פרט לא ברור באחד הצילומים. כדאי להשוות את המספרים לבלינק.";
    if (!/[.!?:)]$/.test(t)) t += ".";
    const key = t.replace(/[.!\s]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
function useDialog(open = true) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open || typeof document === "undefined") return void 0;
    const back = document.activeElement;
    const y = window.scrollY;
    const b = document.body.style;
    const prev = { position: b.position, top: b.top, width: b.width, overflow: b.overflow };
    Object.assign(b, { position: "fixed", top: `-${y}px`, width: "100%", overflow: "hidden" });
    const focusables = () => [...ref.current?.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') || []].filter((el) => !el.disabled && el.offsetParent !== null);
    const t = setTimeout(() => {
      const f = focusables();
      (f[0] || ref.current)?.focus?.({ preventScroll: true });
    }, 30);
    const onKey = (e) => {
      if (e.key !== "Tab" || !ref.current) return;
      const f = focusables();
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === f.at(-1)) {
        e.preventDefault();
        f[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      Object.assign(b, prev);
      window.scrollTo(0, y);
      try {
        back?.focus?.({ preventScroll: true });
      } catch {
      }
    };
  }, [open]);
  return ref;
}
function ImportModal({ open, onClose, onExtracted, serverOk, hasPortfolio, fromDemo }) {
  const dialogRef = useDialog(open);
  const [files, setFiles] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const busy = phase !== "idle";
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  useEffect(() => {
    if (!open) {
      setFiles([]);
      setPhase("idle");
      setProgress(0);
      setElapsed(0);
      setError("");
      setMergeMode(false);
    }
  }, [open]);
  useEffect(() => {
    if (phase !== "reading") return void 0;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1e3)), 1e3);
    return () => clearInterval(id);
  }, [phase]);
  useEffect(() => {
    if (!open) return void 0;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);
  const addFiles = (list) => {
    const images = Array.from(list || []).filter((f) => !f.type || f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name || ""));
    if (images.length) setFiles((prev) => [...prev, ...images]);
  };
  async function decode() {
    setError("");
    try {
      setPhase("preparing");
      const small = [];
      for (const f of files) small.push(await shrinkImage(f));
      setPhase("uploading");
      setProgress(0);
      const json = await extractPortfolio(small, {
        onUpload: (p) => {
          setProgress(p);
          if (p >= 1) setPhase("reading");
        }
      });
      onExtracted(json, { merge: mergeMode && hasPortfolio });
      onClose();
    } catch (e) {
      setPhase("idle");
      if (e.code === "unreachable") setError(REMOTE || GAS ? "אין חיבור לשרת. בדקו את האינטרנט ונסו שוב." : "השרת המקומי לא עונה. הפעילו את start.bat ופתחו את הדף מ-http://localhost:5001/app.");
      else if (e.code === "gemini_auth") setError(GAS || REMOTE ? "Gemini דחה את המפתח. הזינו מפתח תקין בהגדרות." : "Gemini דחה את המפתח — בדקו את GEMINI_API_KEY בקובץ .env של השרת.");
      else if (e.code === "gemini_no_key") setError("חסר מפתח Gemini. הזינו אותו בלשונית ההגדרות.");
      else if (e.code === "timeout") setError("הפענוח לקח יותר מ-15 דקות. נסו שוב.");
      else if (e.code === "LIMIT_FILE_COUNT") setError("יותר מדי קבצים לשרת — העלו את MAX_FILES בקובץ .env.");
      else if (e.code === "LIMIT_FILE_SIZE" || e.code === "http_413") setError("אחד הקבצים גדול מדי. שלחו צילומי מסך רגילים (PNG/JPEG).");
      else if (e.code === "bad_image") setError("אף צילום לא נקרא. שלחו צילומי מסך PNG/JPEG (קבצי HEIC לא נתמכים במחשב).");
      else if (e.code === "gemini_failed") setError("Gemini לא החזיר תשובה (עומס או מגבלת שימוש). נסו שוב בעוד דקה.");
      else if (e.code === "gemini_busy") setError("כל מודלי Gemini עמוסים כרגע (עומס אצל Google). נסו שוב בעוד כמה דקות.");
      else setError(`הפענוח נכשל: ${e.message}`);
    }
  }
  if (!open) return null;
  return /* @__PURE__ */ jsx(
    "div",
    {
      dir: "rtl",
      className: "fixed inset-0 z-50 flex items-end justify-center sp-overlay sm:items-center sm:p-5",
      onClick: (e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      },
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "import-title",
          ref: dialogRef,
          tabIndex: -1,
          className: "sp-sheet flex max-h-[92vh] max-h-[92dvh] w-full max-w-xl flex-col rounded-t-[28px] pb-[env(safe-area-inset-bottom)] outline-none border border-[color:var(--line)] bg-[color:var(--card)] text-[color:var(--fg)] sm:rounded-2xl",
          children: [
            /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 border-b border-[color:var(--line)] px-5 py-4", children: [
              /* @__PURE__ */ jsx("h2", { id: "import-title", className: "font-semibold", children: "ייבוא מבלינק" }),
              /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-3)]", children: "מנוע Gemini" }),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: onClose,
                  disabled: busy,
                  "aria-label": "סגירה",
                  className: "ms-auto grid h-10 w-10 place-items-center rounded-xl border border-[color:var(--line-2)] hover:bg-[color:var(--tint)] disabled:opacity-40",
                  children: /* @__PURE__ */ jsx(Icon, { name: "x" })
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-4 overflow-y-auto px-5 py-4", children: [
              !serverOk && /* @__PURE__ */ jsxs("div", { className: "flex gap-2 rounded-xl border border-[color:var(--warn-line)] bg-[color:var(--warn-bg)] p-3 text-sm text-[color:var(--warn)]", children: [
                /* @__PURE__ */ jsx(Icon, { name: "alert", className: "mt-0.5 h-4 w-4" }),
                /* @__PURE__ */ jsx("span", { children: REMOTE || GAS ? "אין חיבור לשרת כרגע. בדקו את האינטרנט. הנתונים יתעדכנו כשהחיבור יחזור." : "השרת המקומי לא נגיש מכאן. הפעילו start.bat ופתחו את SwingPulse מ-http://localhost:5001/app." })
              ] }),
              busy ? /* @__PURE__ */ jsxs("div", { className: "flex flex-col items-center gap-2 py-10 text-center", children: [
                /* @__PURE__ */ jsx(Icon, { name: "refresh", className: "h-7 w-7 text-[color:var(--accent)]", spin: true }),
                /* @__PURE__ */ jsxs("b", { children: [
                  phase === "preparing" && "מכין צילומים…",
                  phase === "uploading" && `מעלה ${files.length} צילומים… ${Math.round(progress * 100)}%`,
                  phase === "reading" && `Gemini מפענח ${files.length} צילומים…`
                ] }),
                phase === "reading" && /* @__PURE__ */ jsxs("span", { className: "text-sm tabular-nums text-[color:var(--fg-3)]", children: [
                  elapsed,
                  " שניות · תיק של 38 צילומים לוקח בדרך כלל 1–3 דקות"
                ] }),
                /* @__PURE__ */ jsx("div", { className: "mt-2 h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-[color:var(--tint-2)]", children: /* @__PURE__ */ jsx(
                  "div",
                  {
                    className: "h-full bg-[#0a84ff] transition-[width] duration-300",
                    style: { width: phase === "uploading" ? `${progress * 100}%` : phase === "reading" ? "100%" : "8%" }
                  }
                ) })
              ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsxs(
                  "label",
                  {
                    htmlFor: "blink-files",
                    onDragOver: (e) => {
                      e.preventDefault();
                      setDragging(true);
                    },
                    onDragLeave: () => setDragging(false),
                    onDrop: (e) => {
                      e.preventDefault();
                      setDragging(false);
                      addFiles(e.dataTransfer.files);
                    },
                    className: `relative flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-[1.5px] border-dashed px-4 py-10 text-center [touch-action:manipulation] ${dragging ? "border-[#0a84ff] bg-[color:var(--accent-bg)]" : "border-[color:var(--line-2)] bg-[color:var(--inset)] hover:border-[#0a84ff]"}`,
                    children: [
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          id: "blink-files",
                          type: "file",
                          multiple: true,
                          accept: "image/*",
                          "aria-label": "בחירת צילומי מסך",
                          className: "absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0",
                          onChange: (e) => {
                            addFiles(e.target.files);
                            e.target.value = "";
                          }
                        }
                      ),
                      /* @__PURE__ */ jsx(Icon, { name: "upload", className: "h-7 w-7 text-[color:var(--accent)]" }),
                      /* @__PURE__ */ jsx("b", { className: "text-base", children: "בחר את כל צילומי המסך של בלינק" }),
                      /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-3)]", children: "אפשר לסמן את כולם יחד בגלריה · במחשב גם לגרור לכאן" })
                    ]
                  }
                ),
                /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 text-sm", children: [
                  /* @__PURE__ */ jsxs("b", { children: [
                    "נבחרו: ",
                    /* @__PURE__ */ jsx(Num, { children: files.length }),
                    " צילומים"
                  ] }),
                  files.length > 0 && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setFiles([]), className: "ms-auto text-xs text-[color:var(--fg-3)] hover:text-[color:var(--fg)]", children: "ניקוי" })
                ] }),
                files.length > 0 && /* @__PURE__ */ jsx("div", { className: "grid grid-cols-6 gap-1.5 sm:grid-cols-8", children: previews.map((u, i) => /* @__PURE__ */ jsxs("div", { className: "relative aspect-[9/16] overflow-hidden rounded-md border border-[color:var(--line)] bg-[#000]", children: [
                  /* @__PURE__ */ jsx("img", { src: u, alt: `צילום ${i + 1}`, loading: "lazy", className: "h-full w-full object-cover" }),
                  /* @__PURE__ */ jsx("span", { className: "absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums", children: i + 1 }),
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      "aria-label": `הסרת צילום ${i + 1}`,
                      onClick: () => setFiles((prev) => prev.filter((_, j) => j !== i)),
                      className: "absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white",
                      children: /* @__PURE__ */ jsx(Icon, { name: "x", className: "h-3 w-3" })
                    }
                  )
                ] }, u)) }),
                hasPortfolio && /* @__PURE__ */ jsxs("label", { className: "flex cursor-pointer items-center gap-3 rounded-xl border border-[color:var(--line)] bg-[color:var(--inset)] px-3 py-2.5 text-sm", children: [
                  /* @__PURE__ */ jsx("input", { type: "checkbox", checked: mergeMode, onChange: (e) => setMergeMode(e.target.checked), className: "h-5 w-5 accent-[#0a84ff]" }),
                  /* @__PURE__ */ jsxs("span", { children: [
                    /* @__PURE__ */ jsx("b", { children: "הוסף לתיק הקיים" }),
                    /* @__PURE__ */ jsx("span", { className: "block text-xs text-[color:var(--fg-3)]", children: "לצילומים שלא פוענחו בפעם הקודמת. כבוי = התיק מוחלף בתוצאה החדשה." })
                  ] })
                ] }),
                error && /* @__PURE__ */ jsxs("div", { className: "flex gap-2 text-sm text-[color:var(--down)]", children: [
                  /* @__PURE__ */ jsx(Icon, { name: "alert", className: "mt-0.5 h-4 w-4" }),
                  error
                ] }),
                fromDemo && /* @__PURE__ */ jsx(ModeNotice, { mode: "live" }),
                /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: decode,
                    disabled: !files.length,
                    className: "flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[color:var(--inverse)] px-4 font-semibold text-[color:var(--inverse-fg)] disabled:opacity-40",
                    children: [
                      /* @__PURE__ */ jsx(Icon, { name: "brain" }),
                      " פענח תיק מלא (מנוע גוגל Gemini)"
                    ]
                  }
                )
              ] })
            ] })
          ]
        }
      )
    }
  );
}
var LS_DONE = "swingpulse.done.v1";
var PLAN_KINDS = {
  stop: { verb: "מכירה עכשיו", tone: "down", rank: 0 },
  sell: { verb: "מכירת כל הפוזיציה", tone: "down", rank: 1 },
  trim: { verb: "מכירה חלקית", tone: "warn", rank: 2 },
  add: { verb: "אפשר להוסיף", tone: "up", rank: 3 },
  watch: { verb: "לעקוב מקרוב", tone: "accent", rank: 4 }
};
function buildPlan(rows, verdictOf) {
  const steps = [], holds = [];
  for (const p of rows) {
    const v = verdictOf(p.ticker);
    if (!v) continue;
    const px = p.currentPrice;
    const rawStop = v.trailingStop;
    const room = stopRoom(px, rawStop);
    const base = { ticker: p.ticker, verdict: v.verdict || "", price: px, stop: rawStop, target: v.target ?? null, shares: p.shares };
    if (rawStop > 0 && px != null && px <= rawStop) {
      steps.push({ ...base, kind: "stop", why: `המחיר (${fmt(px)}) ירד אל מתחת לסטופ (${fmt(rawStop)}).` });
    } else if (v.action === "CUT_LOSS" || v.action === "TAKE_PROFIT") {
      steps.push({ ...base, kind: "sell", why: v.action === "CUT_LOSS" ? "קיטוע הפסד." : "מימוש רווח." });
    } else if (v.action === "TRIM") {
      steps.push({ ...base, kind: "trim", why: "להקטין את הפוזיציה ולהשאיר את השאר עם סטופ." });
    } else if (v.action === "ADD") {
      steps.push({ ...base, kind: "add", why: "רק אם יש מזומן פנוי, ועם סטופ מוגדר." });
    } else if (room != null && room < 3) {
      steps.push({ ...base, kind: "watch", why: `נשארו ${fmt(room, 1)}% עד הסטופ (${fmt(rawStop)}).` });
    } else {
      holds.push({ ticker: p.ticker, stop: validStop(v, px) });
    }
  }
  steps.sort((a, b) => PLAN_KINDS[a.kind].rank - PLAN_KINDS[b.kind].rank);
  return { steps, holds };
}
var PLAN_HOW = {
  stop: "המחיר ירד אל מתחת לסטופ. לפי התוכנית: למכור את כל הכמות בבלינק, היום.",
  sell: "Gemini ממליץ לצאת מהפוזיציה. למכור את כל הכמות; אפשר בפקודת לימיט קרובה למחיר הנוכחי.",
  trim: "Gemini ממליץ להקטין. למכור חלק מהכמות ולהשאיר את השאר עם הסטופ שמופיע.",
  add: "Gemini רואה מקום להוסיף. רק אם יש מזומן פנוי, ולהגדיר סטופ מיד אחרי הקנייה.",
  watch: "אין פעולה עכשיו. לוודא שהסטופ מוגדר בבלינק ולעקוב, כי המחיר קרוב אליו.",
  hold: "לא לעשות כלום. רק לעדכן בבלינק את הסטופ הנגרר לערך שמופיע ליד כל מניה."
};
function PlanStep({ s, index, isDone, onToggle, onOpen }) {
  const k = PLAN_KINDS[s.kind];
  return /* @__PURE__ */ jsxs("li", { className: `flex items-stretch gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--inset)] p-3 transition-opacity ${isDone ? "opacity-50" : ""}`, children: [
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: onToggle,
        "aria-pressed": isDone,
        "aria-label": isDone ? `סמן ${s.ticker} כלא בוצע` : `סמן ${s.ticker} כבוצע`,
        className: "grid h-9 w-9 flex-none place-items-center self-center rounded-full border-2 text-sm font-bold",
        style: isDone ? { background: "var(--up)", borderColor: "var(--up)", color: "#fff" } : { borderColor: `var(--${k.tone})`, color: `var(--${k.tone})` },
        children: isDone ? "✓" : index + 1
      }
    ),
    /* @__PURE__ */ jsxs(
      "div",
      {
        role: "button",
        tabIndex: 0,
        onClick: () => onOpen?.(s.ticker),
        onKeyDown: (e) => {
          if (e.key === "Enter") onOpen?.(s.ticker);
        },
        className: "sp-press-soft flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-right",
        children: [
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-x-2 gap-y-1", children: [
            /* @__PURE__ */ jsx("b", { dir: "ltr", className: `text-base ${isDone ? "line-through" : ""}`, children: s.ticker }),
            s.shares != null && /* @__PURE__ */ jsxs("span", { className: "text-xs text-[color:var(--fg-3)]", children: [
              /* @__PURE__ */ jsx(Num, { children: qty(s.shares) }),
              " יח׳"
            ] })
          ] }),
          /* @__PURE__ */ jsxs("p", { className: "text-sm text-[color:var(--fg-2)]", children: [
            s.why,
            s.verdict && s.kind !== "stop" ? ` ${s.verdict}` : ""
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-x-4 text-xs text-[color:var(--fg-3)]", children: [
            s.price != null && /* @__PURE__ */ jsxs("span", { children: [
              "מחיר ",
              /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(s.price) }) })
            ] }),
            s.stop > 0 && /* @__PURE__ */ jsxs("span", { children: [
              "סטופ ",
              /* @__PURE__ */ jsx("b", { className: "text-[color:var(--down)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(s.stop) }) })
            ] }),
            s.target > 0 && /* @__PURE__ */ jsxs("span", { children: [
              "יעד ",
              /* @__PURE__ */ jsx("b", { className: "text-[color:var(--up)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(s.target) }) })
            ] })
          ] })
        ]
      }
    ),
    /* @__PURE__ */ jsx("span", { className: "self-center text-[color:var(--fg-4)]", style: { transform: "rotate(90deg)" }, children: /* @__PURE__ */ jsx(Icon, { name: "chevron" }) })
  ] });
}
function PlanSheet({ group, doneNow, onToggle, onOpen, onClose }) {
  const dialogRef = useDialog(true);
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 220);
  }, [onClose]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);
  const k = group.kind === "hold" ? { verb: "להחזיק", tone: "accent" } : PLAN_KINDS[group.kind];
  const done = group.items.filter((s) => doneNow[s.ticker]).length;
  return /* @__PURE__ */ jsx(
    "div",
    {
      dir: "rtl",
      "data-closing": closing ? "" : void 0,
      className: "sp-overlay fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      },
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": k.verb,
          "data-closing": closing ? "" : void 0,
          ref: dialogRef,
          tabIndex: -1,
          className: "sp-sheet flex max-h-[88dvh] pb-[env(safe-area-inset-bottom)] outline-none w-full max-w-xl flex-col overflow-hidden rounded-t-[28px] border border-[color:var(--line)] bg-[color:var(--sheet)] text-[color:var(--fg)] shadow-2xl sm:rounded-3xl",
          children: [
            /* @__PURE__ */ jsx("div", { className: "mx-auto mt-2 h-1 w-10 flex-none rounded-full bg-[color:var(--line-2)] sm:hidden", "aria-hidden": "true" }),
            /* @__PURE__ */ jsxs("header", { className: "flex flex-none items-start gap-3 border-b border-[color:var(--line)] px-5 pb-4 pt-3", children: [
              /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
                /* @__PURE__ */ jsx("h2", { className: "text-xl font-bold", style: { color: `var(--${k.tone})` }, children: k.verb }),
                /* @__PURE__ */ jsx("p", { className: "mt-1 text-sm leading-relaxed text-[color:var(--fg-2)]", children: PLAN_HOW[group.kind] }),
                group.kind !== "hold" && /* @__PURE__ */ jsxs("p", { className: "mt-1 text-xs text-[color:var(--fg-3)]", children: [
                  group.items.length,
                  " מניות · ",
                  done,
                  " בוצעו"
                ] })
              ] }),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: close,
                  "aria-label": "סגירה",
                  className: "ms-auto grid h-10 w-10 flex-none place-items-center rounded-full border border-[color:var(--line-2)] bg-[color:var(--tint)]",
                  children: /* @__PURE__ */ jsx(Icon, { name: "x" })
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "overflow-y-auto overscroll-contain p-4", children: [
              group.kind === "hold" ? /* @__PURE__ */ jsx("ul", { className: "sp-stagger flex flex-col gap-2", children: group.items.map((h) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  onClick: () => onOpen?.(h.ticker),
                  className: "sp-press-soft flex w-full items-center gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--inset)] px-4 py-3 text-right",
                  children: [
                    /* @__PURE__ */ jsx("b", { dir: "ltr", children: h.ticker }),
                    /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-3)]", children: h.stop != null ? /* @__PURE__ */ jsxs(Fragment, { children: [
                      "סטופ נגרר ",
                      /* @__PURE__ */ jsx("b", { className: "text-[color:var(--down)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(h.stop) }) })
                    ] }) : "אין סטופ מ־Gemini" }),
                    /* @__PURE__ */ jsx("span", { className: "ms-auto text-[color:var(--fg-4)]", style: { transform: "rotate(90deg)" }, children: /* @__PURE__ */ jsx(Icon, { name: "chevron" }) })
                  ]
                }
              ) }, h.ticker)) }) : /* @__PURE__ */ jsx("ol", { className: "sp-stagger flex flex-col gap-2.5", children: group.items.map((s, i) => /* @__PURE__ */ jsx(PlanStep, { s, index: i, isDone: !!doneNow[s.ticker], onToggle: () => onToggle(s.ticker), onOpen }, s.ticker)) }),
              /* @__PURE__ */ jsx("p", { className: "mt-4 text-center text-[11px] text-[color:var(--fg-4)]", children: "לחיצה על מניה פותחת את הגרף. כלי עזר להחלטה, לא ייעוץ השקעות." })
            ] })
          ]
        }
      )
    }
  );
}
function TodayPlan({ rows, digest, digestState, verdictOf, onOpen, onRun, canRun }) {
  const plan = useMemo(() => buildPlan(rows, verdictOf), [rows, verdictOf]);
  const scanAt = digest?.meta?.at || null;
  const key = scanAt || "none";
  const [done, setDone] = useState(() => loadJSON(LS_DONE, {}));
  const [openKind, setOpenKind] = useState(null);
  const doneNow = done[key] || {};
  const toggle = (t) => setDone((cur) => {
    const next = { [key]: { ...cur[key] || {}, [t]: !(cur[key] || {})[t] } };
    saveJSON(LS_DONE, next);
    return next;
  });
  const ageH = scanAt ? (Date.now() - new Date(scanAt).getTime()) / 36e5 : null;
  const stale = ageH != null && ageH > 24;
  const groups = useMemo(() => {
    const out = Object.keys(PLAN_KINDS).map((kind) => ({ kind, items: plan.steps.filter((s) => s.kind === kind) })).filter((g) => g.items.length);
    if (plan.holds.length) out.push({ kind: "hold", items: plan.holds });
    return out;
  }, [plan]);
  const openGroup = groups.find((g) => g.kind === openKind) || null;
  const actionCount = plan.steps.length;
  const doneCount = plan.steps.filter((s) => doneNow[s.ticker]).length;
  const runBtn = (label) => /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick: onRun,
      disabled: !canRun || digestState.busy,
      className: "flex min-h-10 items-center gap-1.5 rounded-xl bg-[color:var(--inverse)] px-4 text-sm font-semibold text-[color:var(--inverse-fg)] disabled:opacity-40",
      children: [
        /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: digestState.busy, className: "h-4 w-4" }),
        digestState.busy ? "סורק…" : label
      ]
    }
  );
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-end gap-x-3 gap-y-1", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
        /* @__PURE__ */ jsx("h2", { className: "text-lg font-bold", children: "מה עושים היום" }),
        /* @__PURE__ */ jsx("p", { className: "text-xs text-[color:var(--fg-3)]", children: scanAt ? /* @__PURE__ */ jsxs(Fragment, { children: [
          "לפי סריקת Gemini מ־",
          dateTimeFmt(scanAt),
          actionCount ? ` · ${doneCount}/${actionCount} בוצעו` : ""
        ] }) : "עוד לא נעשתה סריקה" })
      ] }),
      digest?.marketSummary && /* @__PURE__ */ jsx("span", { className: "ms-auto", children: /* @__PURE__ */ jsxs(Pill, { tone: digest.marketSummary.tone || "gray", children: [
        "שוק: ",
        digest.marketSummary.title
      ] }) })
    ] }),
    !digest ? /* @__PURE__ */ jsxs("div", { className: "flex flex-col items-start gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-4 text-sm", children: [
      /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-2)]", children: digestState.error || "צריך סריקה כדי לדעת מה לעשות. הסריקה בודקת כל מניה בתיק ומחזירה פעולה." }),
      runBtn("לסרוק עכשיו")
    ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      stale && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--warn-line)] bg-[color:var(--warn-bg)] px-4 py-3 text-sm", children: [
        /* @__PURE__ */ jsx(Icon, { name: "alert", className: "h-4 w-4 text-[color:var(--warn)]" }),
        /* @__PURE__ */ jsx("span", { children: "הסריקה בת יותר מיום. כדאי לסרוק מחדש לפני שפועלים." }),
        /* @__PURE__ */ jsx("span", { className: "ms-auto", children: runBtn("לסרוק מחדש") })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "sp-stagger grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6", children: [
        actionCount === 0 && /* @__PURE__ */ jsxs("div", { className: "col-span-2 flex aspect-[2/1] flex-col justify-between rounded-3xl p-4 sm:col-span-3 lg:aspect-auto lg:col-span-3", style: { background: "var(--up-bg)" }, children: [
          /* @__PURE__ */ jsx("span", { className: "grid h-9 w-9 place-items-center rounded-full text-white", style: { background: "var(--up)" }, children: "✓" }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("b", { className: "text-lg", children: "אין מה לעשות היום" }),
            /* @__PURE__ */ jsx("div", { className: "text-sm text-[color:var(--fg-2)]", children: "להחזיק ולתת לסטופים לעבוד." })
          ] })
        ] }),
        groups.map((g) => {
          const k = g.kind === "hold" ? { verb: "להחזיק", tone: "accent" } : PLAN_KINDS[g.kind];
          const left = g.kind === "hold" ? g.items.length : g.items.filter((s) => !doneNow[s.ticker]).length;
          const allDone = g.kind !== "hold" && left === 0;
          const urgent = g.kind === "stop" || g.kind === "sell";
          return /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: () => setOpenKind(g.kind),
              className: `relative flex aspect-square flex-col justify-between overflow-hidden rounded-3xl border p-4 text-right ${allDone ? "opacity-55" : ""}`,
              style: { borderColor: `var(--${k.tone === "accent" ? "accent-line" : k.tone === "warn" ? "warn-line" : k.tone + "-line"})`, background: `var(--${k.tone}-bg)` },
              children: [
                urgent && !allDone && /* @__PURE__ */ jsx("span", { className: "absolute left-3 top-3 h-2.5 w-2.5 animate-pulse rounded-full", style: { background: `var(--${k.tone})` } }),
                /* @__PURE__ */ jsx("span", { className: "text-4xl font-bold leading-none tabular-nums", style: { color: `var(--${k.tone})` }, children: allDone ? "✓" : left }),
                /* @__PURE__ */ jsxs("span", { className: "flex flex-col gap-1", children: [
                  /* @__PURE__ */ jsx("b", { className: "text-[15px] leading-tight", children: k.verb }),
                  /* @__PURE__ */ jsxs("span", { dir: "ltr", className: "truncate text-right text-xs text-[color:var(--fg-3)]", children: [
                    g.items.slice(0, 3).map((s) => s.ticker).join(" · "),
                    g.items.length > 3 ? " …" : ""
                  ] })
                ] })
              ]
            },
            g.kind
          );
        })
      ] }),
      digest.portfolioNotes?.length > 0 && /* @__PURE__ */ jsx("ul", { dir: "rtl", className: "sp-list rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] !p-4 text-sm text-[color:var(--fg-2)]", style: { "--marker": "var(--accent)" }, children: digest.portfolioNotes.map((t, i) => /* @__PURE__ */ jsx("li", { children: t }, i)) })
    ] }),
    openGroup && /* @__PURE__ */ jsx(PlanSheet, { group: openGroup, doneNow, onToggle: toggle, onOpen, onClose: () => setOpenKind(null) })
  ] });
}
function DashboardTab({ portfolio, rows, stats, digest, digestState, verdictOf, full, setFull, onImport, onOpen, onRun, canRun, isDemo = false }) {
  const cur = portfolio.currency || "USD";
  const notes = cleanNotes([
    ...(portfolio.meta?.failedChunks || []).map((f) => `צילומים ${f.screenshots?.[0]}–${f.screenshots?.[1]} לא פוענחו — העלו אותם שוב עם "הוסף לתיק הקיים"`),
    ...(portfolio.meta?.unreadable || []).map((u) => `צילום ${u.index} (${u.name}) לא נקרא: ${u.reason}`),
    ...portfolio.meta?.conflicts || [],
    ...portfolio.meta?.warnings || [],
    ...digest?.warnings || []
  ]);
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-6", children: [
    /* @__PURE__ */ jsxs("section", { className: "rounded-3xl border border-[color:var(--line)] bg-gradient-to-b from-[color:var(--hero-from)] to-[color:var(--hero-to)] p-5 sm:p-6", children: [
      /* @__PURE__ */ jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-2", children: [
        /* @__PURE__ */ jsx("h2", { className: "text-sm font-semibold text-[color:var(--fg-2)]", children: "תמונת מצב יומית" }),
        /* @__PURE__ */ jsxs("span", { className: "rounded-full border border-[color:var(--line)] px-2.5 py-0.5 text-xs text-[color:var(--fg-3)]", children: [
          isDemo ? "תיק דמו" : /* @__PURE__ */ jsxs(Fragment, { children: [
            "ייבוא ",
            dateTimeFmt(portfolio.importedAt),
            portfolio.meta?.screenshots ? ` · ${portfolio.meta.screenshots} צילומים` : ""
          ] }),
          !isDemo && portfolio.tradedAt ? ` · עודכן ידנית ${dateTimeFmt(portfolio.tradedAt)}` : ""
        ] }),
        !isDemo && /* @__PURE__ */ jsx("button", { type: "button", onClick: onImport, className: "ms-auto text-xs text-[color:var(--accent)] hover:underline", children: "ייבוא מחדש" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-2 gap-5 lg:grid-cols-4", children: [
        /* @__PURE__ */ jsx(
          Kpi,
          {
            big: true,
            label: isDemo ? "שווי תיק הדמו" : "שווי תיק",
            value: /* @__PURE__ */ jsx(Num, { children: money(stats.total, cur) }),
            sub: isDemo ? "מניות + מזומן בדמו" : portfolio.liveAt || portfolio.tradedAt ? "מניות + מזומן, לפי מחירים חיים" : portfolio.totalPortfolioValue == null ? "מחושב: מניות + מזומן" : "כפי שמופיע בבלינק"
          }
        ),
        /* @__PURE__ */ jsx(
          Kpi,
          {
            label: "רווח/הפסד לא ממומש",
            value: /* @__PURE__ */ jsx(Num, { className: stats.pnl >= 0 ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedMoney(stats.pnl, cur) }),
            sub: /* @__PURE__ */ jsx(Num, { className: stats.pnl >= 0 ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedPct(stats.pnlPct, 2) })
          }
        ),
        /* @__PURE__ */ jsx(
          Kpi,
          {
            label: "מזומן",
            value: stats.cash == null ? "לא נמצא" : /* @__PURE__ */ jsx(Num, { children: money(stats.cash, cur) }),
            sub: stats.exposure == null ? "" : `${fmt((1 - stats.exposure) * 100, 0)}% מהתיק`
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
          /* @__PURE__ */ jsx("div", { className: "mb-1 text-xs text-[color:var(--fg-3)]", children: "חשיפה למניות" }),
          /* @__PURE__ */ jsx("div", { className: "text-2xl font-bold tabular-nums", children: stats.exposure == null ? "—" : `${fmt(stats.exposure * 100, 0)}%` }),
          /* @__PURE__ */ jsx("div", { className: "mt-2 flex h-1.5 overflow-hidden rounded-full bg-[color:var(--tint-2)]", children: /* @__PURE__ */ jsx("div", { className: "bg-[#0a84ff]", style: { width: `${Math.min(100, (stats.exposure || 0) * 100)}%` } }) }),
          /* @__PURE__ */ jsxs("div", { className: "mt-1 text-xs text-[color:var(--fg-3)]", children: [
            rows.length,
            " פוזיציות"
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--inset)] px-4 py-3 text-sm", children: digestState.busy ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: true, className: "h-4 w-4 text-[color:var(--accent)]" }),
        /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-2)]", children: "Gemini מכין המלצות סווינג…" })
      ] }) : digest ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(Pill, { tone: digest.marketSummary?.tone || "gray", children: "נטיית שוק" }),
        /* @__PURE__ */ jsxs("span", { children: [
          /* @__PURE__ */ jsx("b", { children: digest.marketSummary?.title }),
          " — ",
          digest.marketSummary?.text
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "ms-auto text-xs text-[color:var(--fg-3)]", children: [
          "עודכן ",
          timeFmt(digest.meta?.at || Date.now())
        ] })
      ] }) : /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: digestState.error || 'עוד אין המלצות. לחצו "המלצות Gemini" בסרגל העליון.' }) }),
      digestState.error && digest && /* @__PURE__ */ jsx("div", { className: "mt-2 text-xs text-[color:var(--down)]", children: digestState.error })
    ] }),
    /* @__PURE__ */ jsx(TodayPlan, { rows, digest, digestState, verdictOf, onOpen, onRun, canRun }),
    /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3", children: [
        /* @__PURE__ */ jsx("h2", { className: "text-lg font-bold", children: "תיק השקעות פעיל" }),
        /* @__PURE__ */ jsx(
          Segmented,
          {
            ariaLabel: "רמת פירוט",
            value: full,
            onChange: setFull,
            className: "ms-auto rounded-xl border border-[color:var(--line)] bg-[color:var(--inset)] p-1 text-sm",
            itemClass: "rounded-lg px-3 py-1",
            options: [{ id: false, label: "שורה תחתונה" }, { id: true, label: "ניתוח מפורט" }]
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "sp-stagger grid grid-cols-1 gap-3 md:grid-cols-2", children: rows.map((p) => {
        const v = verdictOf(p.ticker);
        const tone = v ? ACTIONS[v.action]?.tone || "gray" : "gray";
        return /* @__PURE__ */ jsxs(
          "article",
          {
            role: "button",
            tabIndex: 0,
            onClick: () => onOpen?.(p.ticker),
            onKeyDown: (e) => {
              if (e.key === "Enter") onOpen?.(p.ticker);
            },
            className: `flex min-w-0 cursor-pointer flex-col gap-3 rounded-2xl border border-[color:var(--line)] border-r-4 bg-[color:var(--card)] p-4 transition hover:-translate-y-0.5 hover:bg-[color:var(--card-hover)] ${EDGE_CLASSES[tone]}`,
            children: [
              /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2", children: [
                /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
                  /* @__PURE__ */ jsx("b", { dir: "ltr", className: "text-xl", children: p.ticker }),
                  /* @__PURE__ */ jsxs("div", { className: "truncate text-xs text-[color:var(--fg-3)]", children: [
                    p.companyName,
                    " · ",
                    /* @__PURE__ */ jsx(Num, { children: qty(p.shares) }),
                    " יח׳"
                  ] })
                ] }),
                /* @__PURE__ */ jsx("span", { className: "ms-auto", children: /* @__PURE__ */ jsx(ActionBadge, { action: v?.action, waiting: digestState.busy }) })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-3 gap-2", children: [
                /* @__PURE__ */ jsx(Cell, { label: "רווח/הפסד", value: /* @__PURE__ */ jsx(Num, { className: (p.pnlPct ?? 0) >= 0 ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedPct(p.pnlPct) }) }),
                /* @__PURE__ */ jsx(Cell, { label: "שווי", value: /* @__PURE__ */ jsx(Num, { children: money(p.value, cur) }) }),
                /* @__PURE__ */ jsx(Cell, { label: "הקצאה", value: /* @__PURE__ */ jsx(Num, { children: p.allocationPct == null ? "—" : `${fmt(p.allocationPct, 1)}%` }) })
              ] }),
              v && /* @__PURE__ */ jsxs("p", { className: "text-sm", children: [
                /* @__PURE__ */ jsx("b", { children: "שורה תחתונה:" }),
                " ",
                v.verdict
              ] }),
              full && /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--fg-3)]", children: [
                  /* @__PURE__ */ jsxs("span", { children: [
                    "שער קנייה ",
                    /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(p.avgPrice) }) })
                  ] }),
                  /* @__PURE__ */ jsxs("span", { children: [
                    "שער נוכחי ",
                    /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(p.currentPrice) }) })
                  ] }),
                  v && /* @__PURE__ */ jsxs("span", { children: [
                    "סטופ נגרר ",
                    /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(validStop(v, p.currentPrice)) }) }),
                    stopRoom(p.currentPrice, validStop(v, p.currentPrice)) != null && /* @__PURE__ */ jsxs(Num, { className: "ms-1 text-[color:var(--fg-3)]", children: [
                      "(−",
                      fmt(stopRoom(p.currentPrice, validStop(v, p.currentPrice)), 1),
                      "%)"
                    ] })
                  ] }),
                  v && /* @__PURE__ */ jsxs("span", { children: [
                    "יעד ",
                    /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: /* @__PURE__ */ jsx(Num, { children: fmt(v.target) }) })
                  ] }),
                  v && /* @__PURE__ */ jsxs("span", { children: [
                    "ביטחון ",
                    /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: { low: "נמוך", medium: "בינוני", high: "גבוה" }[v.confidence] || "—" })
                  ] })
                ] }),
                v?.bullets?.length > 0 && /* @__PURE__ */ jsx("ul", { dir: "rtl", className: "sp-list text-sm text-[color:var(--fg-2)]", children: v.bullets.map((b, i) => /* @__PURE__ */ jsx("li", { children: b }, i)) }),
                v?.dataNote && /* @__PURE__ */ jsx("p", { className: "text-xs text-[color:var(--fg-3)]", children: v.dataNote })
              ] })
            ]
          },
          p.ticker
        );
      }) })
    ] }),
    notes.length > 0 && /* @__PURE__ */ jsx(Accordion, { title: `הערות פענוח (${notes.length})`, defaultOpen: (portfolio.meta?.failedChunks?.length || 0) + (portfolio.meta?.unreadable?.length || 0) > 0, children: /* @__PURE__ */ jsx("ul", { dir: "rtl", className: "sp-list text-[color:var(--fg-2)]", style: { "--marker": "var(--warn)" }, children: notes.map((t, i) => /* @__PURE__ */ jsx("li", { dir: "rtl", children: t }, i)) }) }),
    digest?.sources?.length > 0 && /* @__PURE__ */ jsxs("section", { className: "rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-4 text-sm", children: [
      /* @__PURE__ */ jsx("h3", { className: "mb-2 font-semibold", children: "מקורות ש-Gemini השתמש בהם" }),
      /* @__PURE__ */ jsx("ul", { className: "flex flex-col gap-1", children: digest.sources.map((s) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs("a", { href: safeUrl(s.url), target: "_blank", rel: "noreferrer", className: "inline-flex items-center gap-1.5 text-[color:var(--accent)] hover:underline", children: [
        /* @__PURE__ */ jsx(Icon, { name: "link", className: "h-3.5 w-3.5" }),
        s.title
      ] }) }, s.url)) })
    ] })
  ] });
}
var TABLE_COLUMNS = [
  { key: "ticker", label: "טיקר" },
  { key: "companyName", label: "חברה" },
  { key: "shares", label: "כמות", num: true },
  { key: "avgPrice", label: "שער קנייה", num: true },
  { key: "currentPrice", label: "שער נוכחי", num: true },
  { key: "value", label: "שווי", num: true },
  { key: "pnl", label: "רווח/הפסד", num: true },
  { key: "pnlPct", label: "תשואה", num: true },
  { key: "allocationPct", label: "הקצאה", num: true },
  { key: "stop", label: "סטופ נגרר", num: true },
  { key: "target", label: "יעד", num: true },
  { key: "action", label: "פעולה" }
];
var TV_EXCHANGE = { NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ", NYQ: "NYSE", NYS: "NYSE", PCX: "AMEX", ASE: "AMEX", BTS: "CBOE", TLV: "TASE" };
function tvSymbol(ticker, exchange) {
  const t = String(ticker || "").toUpperCase().replace(/\./g, "-").replace(/-CVR$/, "");
  const ex = TV_EXCHANGE[exchange];
  return ex ? `${ex}:${t.replace(/-/g, ".")}` : t.replace(/-/g, ".");
}
function TradingViewChart({ symbol }) {
  const ref = useRef(null);
  const theme = useTheme();
  const [state, setState] = useState("waiting");
  useEffect(() => {
    const el = ref.current;
    if (!el) return void 0;
    let alive = true, raf = 0;
    setState("waiting");
    el.innerHTML = "";
    const mount = () => {
      if (!alive || !el.isConnected) return;
      const height = Math.round(el.clientHeight) || 360;
      const t = THEME_TOKENS[theme];
      const box = document.createElement("div");
      box.className = "tradingview-widget-container__widget";
      el.appendChild(box);
      const sc = document.createElement("script");
      sc.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
      sc.async = true;
      sc.onerror = () => {
        if (alive) setState("failed");
      };
      sc.onload = () => {
        if (alive) setState("ready");
      };
      sc.textContent = JSON.stringify({
        symbol,
        width: "100%",
        height,
        autosize: false,
        interval: "D",
        range: "6M",
        timezone: "Asia/Jerusalem",
        theme,
        style: "1",
        locale: "he_IL",
        backgroundColor: t.card,
        gridColor: theme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.06)",
        hide_side_toolbar: true,
        hide_top_toolbar: false,
        hide_legend: false,
        hide_volume: true,
        withdateranges: false,
        save_image: false,
        details: false,
        hotlist: false,
        calendar: false,
        allow_symbol_change: false,
        studies: [],
        support_host: "https://www.tradingview.com"
      });
      el.appendChild(sc);
      setState("loading");
    };
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(() => requestAnimationFrame(mount));
    }, 360);
    return () => {
      alive = false;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      el.innerHTML = "";
    };
  }, [symbol, theme]);
  return /* @__PURE__ */ jsxs("div", { className: "relative", children: [
    /* @__PURE__ */ jsx("div", { ref, dir: "ltr", className: "sp-chart tradingview-widget-container" }),
    state === "waiting" || state === "loading" ? /* @__PURE__ */ jsx("div", { className: "sp-chart-msg pointer-events-none", children: "טוען גרף…" }) : null,
    state === "failed" && /* @__PURE__ */ jsx("div", { className: "sp-chart-msg", children: 'TradingView לא נטען. אפשר לעבור ל"הרמות שלי".' })
  ] });
}
var sma = (vals, n2) => vals.map((_, i) => i + 1 >= n2 ? vals.slice(i + 1 - n2, i + 1).reduce((a, b) => a + b, 0) / n2 : null);
function LevelsChart({ ticker, avgPrice, stop, target }) {
  const ref = useRef(null);
  const theme = useTheme();
  const [range, setRange] = useState("6mo");
  const [state, setState] = useState({ loading: true, error: "" });
  useEffect(() => {
    let chart = null, alive = true, ro = null;
    setState({ loading: true, error: "" });
    const t2 = THEME_TOKENS[theme];
    const dark = theme === "dark";
    (async () => {
      try {
        const [lib, data] = await Promise.all([import("https://esm.sh/lightweight-charts@4.2.0"), fetchCandles(ticker, range)]);
        if (!alive || !ref.current) return;
        const el = ref.current;
        el.innerHTML = "";
        const faint = dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.06)";
        const axis = dark ? "rgba(255,255,255,0.10)" : "#E2E8F0";
        chart = lib.createChart(el, {
          width: el.clientWidth,
          height: el.clientHeight,
          layout: { background: { type: "solid", color: t2.card }, textColor: t2["fg-3"], fontFamily: "Heebo, -apple-system, sans-serif" },
          grid: { vertLines: { color: faint }, horzLines: { color: faint } },
          rightPriceScale: { borderColor: axis },
          timeScale: { borderColor: axis, timeVisible: false },
          crosshair: { mode: 0 }
        });
        const candles = data.candles.map((c) => ({ time: c.t + (data.gmtoffset || 0), open: c.o, high: c.h, low: c.l, close: c.c }));
        const series = chart.addCandlestickSeries({ upColor: t2.up, downColor: t2.down, borderVisible: false, wickUpColor: t2.up, wickDownColor: t2.down });
        series.setData(candles);
        const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
        vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(data.candles.map((c, i) => ({ time: candles[i].time, value: c.v || 0, color: c.c >= c.o ? t2["up-bg"] : t2["down-bg"] })));
        const closes = data.candles.map((c) => c.c);
        [[20, dark ? "#FFD60A" : "#D97706"], [50, dark ? "#BF5AF2" : "#9333EA"]].forEach(([n2, color]) => {
          const line = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          line.setData(sma(closes, n2).map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean));
        });
        const level = (price, color, title, style = 2) => price > 0 && series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
        level(avgPrice, t2.accent, "כניסה", 0);
        level(stop, t2.down, "סטופ");
        level(target, t2.up, "יעד");
        chart.timeScale().fitContent();
        ro = new ResizeObserver(() => chart && chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
        ro.observe(el);
        setState({ loading: false, error: "" });
      } catch (e) {
        if (alive) setState({ loading: false, error: "הגרף לא נטען כרגע" });
      }
    })();
    return () => {
      alive = false;
      if (ro) ro.disconnect();
      if (chart) chart.remove();
    };
  }, [ticker, range, avgPrice, stop, target, theme]);
  const legend = (color, label) => /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
    /* @__PURE__ */ jsx("i", { className: "inline-block h-0.5 w-3 rounded-full", style: { background: color } }),
    label
  ] });
  const t = THEME_TOKENS[theme];
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2 text-xs", children: [
      /* @__PURE__ */ jsx(
        Segmented,
        {
          ariaLabel: "טווח זמן",
          value: range,
          onChange: setRange,
          className: "rounded-lg border border-[color:var(--line)] bg-[color:var(--inset)] p-0.5",
          itemClass: "rounded-md px-2.5 py-1",
          options: [["3mo", "3ח׳"], ["6mo", "6ח׳"], ["1y", "שנה"], ["2y", "שנתיים"], ["5y", "5ש׳"]].map(([id, label]) => ({ id, label }))
        }
      ),
      /* @__PURE__ */ jsxs("span", { className: "ms-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[color:var(--fg-3)]", children: [
        legend(t.accent, "כניסה"),
        stop > 0 && legend(t.down, "סטופ"),
        target > 0 && legend(t.up, "יעד"),
        legend(theme === "dark" ? "#FFD60A" : "#D97706", "MA20"),
        legend(theme === "dark" ? "#BF5AF2" : "#9333EA", "MA50")
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "relative", children: [
      /* @__PURE__ */ jsx("div", { ref, dir: "ltr", className: "sp-chart" }),
      (state.loading || state.error) && /* @__PURE__ */ jsx("div", { className: "absolute inset-0 grid place-items-center text-sm text-[color:var(--fg-3)]", children: state.loading ? "טוען נרות…" : state.error })
    ] })
  ] });
}
function Metric({ label, value, tone }) {
  return /* @__PURE__ */ jsxs("div", { dir: "rtl", className: "sp-metric rounded-xl border border-[color:var(--line-soft)] bg-[color:var(--inset)] px-3 py-2.5", children: [
    /* @__PURE__ */ jsx("span", { className: "sp-metric-label", children: label }),
    /* @__PURE__ */ jsx("span", { dir: "ltr", className: "sp-metric-value", style: tone ? { color: `var(--${tone})` } : void 0, children: value })
  ] });
}
function StockSheet({ position, verdict, currency, onClose, mode = "live", demoStats = null, onDemoApplied, cash = null, orders = [] }) {
  const dialogRef = useDialog(true);
  const [view, setView] = useState("tv");
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 220);
  }, [onClose]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [close]);
  if (!position) return null;
  const p = position, q = p.live || {};
  const stop = validStop(verdict, p.currentPrice);
  const target = verdict?.target ?? null;
  const room = stopRoom(p.currentPrice, stop);
  const pos = (p.pnl ?? 0) >= 0;
  const day = q.dayChangePct;
  const trend = (px, m) => px != null && m != null ? px >= m ? "up" : "down" : null;
  const exchange = q.exchange ? TV_EXCHANGE[q.exchange] || q.exchange : null;
  const company = (() => {
    const c = String(p.companyName || "").trim();
    return c && c.toUpperCase() !== String(p.ticker).toUpperCase() ? c : "";
  })();
  return /* @__PURE__ */ jsx(
    "div",
    {
      dir: "rtl",
      "data-closing": closing ? "" : void 0,
      className: "sp-overlay fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      },
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": `גרף ${p.ticker}`,
          "data-closing": closing ? "" : void 0,
          ref: dialogRef,
          tabIndex: -1,
          className: "sp-sheet flex max-h-[94dvh] pb-[env(safe-area-inset-bottom)] outline-none w-full max-w-5xl flex-col overflow-hidden rounded-t-[28px] border border-[color:var(--line)] bg-[color:var(--sheet)] text-[color:var(--fg)] shadow-2xl sm:rounded-3xl",
          children: [
            /* @__PURE__ */ jsx("div", { className: "mx-auto mt-2 h-1 w-10 flex-none rounded-full bg-[color:var(--line-2)] sm:hidden", "aria-hidden": "true" }),
            /* @__PURE__ */ jsxs("header", { className: "flex flex-none flex-col gap-2 border-b border-[color:var(--line)] px-4 pb-3 pt-3 sm:px-5", children: [
              /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
                /* @__PURE__ */ jsxs("div", { className: "flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1", children: [
                  /* @__PURE__ */ jsx("b", { dir: "ltr", className: "text-2xl font-bold tracking-tight", children: p.ticker }),
                  /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num text-xl font-semibold", children: fmt(p.currentPrice) }),
                  day != null && /* @__PURE__ */ jsx("span", { dir: "ltr", className: `sp-num rounded-full px-2 py-0.5 text-xs font-semibold ${day >= 0 ? "bg-[color:var(--up-bg)] text-[color:var(--up)]" : "bg-[color:var(--down-bg)] text-[color:var(--down)]"}`, children: signedPct(day, 2) })
                ] }),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: close,
                    "aria-label": "סגירה",
                    className: "ms-auto grid h-10 w-10 flex-none place-items-center rounded-full border border-[color:var(--line-2)] bg-[color:var(--tint)] hover:bg-[color:var(--tint-2)]",
                    children: /* @__PURE__ */ jsx(Icon, { name: "x" })
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
                /* @__PURE__ */ jsxs("span", { className: "min-w-0 truncate text-xs text-[color:var(--fg-3)]", children: [
                  /* @__PURE__ */ jsxs("span", { dir: "ltr", children: [
                    p.ticker,
                    exchange ? ` · ${exchange}` : ""
                  ] }),
                  company ? /* @__PURE__ */ jsxs("span", { children: [
                    " · ",
                    company
                  ] }) : null
                ] }),
                verdict && /* @__PURE__ */ jsx("span", { className: "ms-auto", children: /* @__PURE__ */ jsx(ActionBadge, { action: verdict.action, showDetail: true }) })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "sp-stagger flex flex-col gap-4 overflow-y-auto overscroll-contain p-4 sm:p-5", children: [
              /* @__PURE__ */ jsx(
                Segmented,
                {
                  ariaLabel: "סוג גרף",
                  value: view,
                  onChange: setView,
                  className: "self-start rounded-xl border border-[color:var(--line)] bg-[color:var(--inset)] p-1 text-sm",
                  itemClass: "rounded-lg px-3.5 py-1.5",
                  options: [{ id: "tv", label: "TradingView" }, { id: "levels", label: "הרמות שלי" }]
                }
              ),
              /* @__PURE__ */ jsx("div", { className: "flex-none", children: view === "tv" ? /* @__PURE__ */ jsx(TradingViewChart, { symbol: tvSymbol(p.ticker, q.exchange) }) : /* @__PURE__ */ jsx(LevelsChart, { ticker: p.ticker, avgPrice: p.avgPrice, stop, target }) }),
              /* @__PURE__ */ jsxs("div", { className: "sp-stagger grid grid-cols-2 gap-2 sm:grid-cols-4", children: [
                /* @__PURE__ */ jsx(Metric, { label: "כמות", value: qty(p.shares) }),
                /* @__PURE__ */ jsx(Metric, { label: "מחיר קנייה", value: fmt(p.avgPrice) }),
                /* @__PURE__ */ jsx(Metric, { label: "שווי", value: money(p.value, currency) }),
                /* @__PURE__ */ jsx(Metric, { label: "רווח/הפסד", value: `${signedMoney(p.pnl, currency)} (${signedPct(p.pnlPct)})`, tone: pos ? "up" : "down" }),
                /* @__PURE__ */ jsx(Metric, { label: "מהתיק", value: p.allocationPct != null ? `${fmt(p.allocationPct, 1)}%` : "—" }),
                /* @__PURE__ */ jsx(Metric, { label: "MA20", value: fmt(q.sma20), tone: trend(p.currentPrice, q.sma20) }),
                /* @__PURE__ */ jsx(Metric, { label: "MA50", value: fmt(q.sma50), tone: trend(p.currentPrice, q.sma50) }),
                /* @__PURE__ */ jsx(Metric, { label: "טווח 20 יום", value: q.low20 != null ? `${fmt(q.low20)}–${fmt(q.high20)}` : "—" })
              ] }),
              REMOTE && /* @__PURE__ */ jsx(ManualTrade, { position: p, cash, mode, currency, orders, onApplied: (r) => onDemoApplied?.(r) }),
              REMOTE && !SANDBOX && /* @__PURE__ */ jsx(AnalystPanel, { ticker: p.ticker, mode, position: p, demoStats, onDemoApplied: (r) => onDemoApplied?.(r) }),
              !REMOTE && verdict && /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-4", children: [
                /* @__PURE__ */ jsxs("h3", { className: "flex items-center gap-2 text-sm font-bold", children: [
                  /* @__PURE__ */ jsx(Icon, { name: "brain", className: "h-4 w-4 text-[color:var(--accent)]" }),
                  "המלצת Gemini"
                ] }),
                (stop > 0 || target > 0) && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", children: [
                  stop > 0 && /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-2 rounded-xl border border-[color:var(--down-line)] bg-[color:var(--down-bg)] px-3 py-1.5 text-sm", children: [
                    /* @__PURE__ */ jsx("span", { className: "font-medium text-[color:var(--fg-2)]", children: "סטופ" }),
                    /* @__PURE__ */ jsxs("b", { dir: "ltr", className: "sp-num text-[color:var(--down)]", children: [
                      fmt(stop),
                      room != null ? ` · ${fmt(room, 1)}%-` : ""
                    ] })
                  ] }),
                  target > 0 && /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-2 rounded-xl border border-[color:var(--up-line)] bg-[color:var(--up-bg)] px-3 py-1.5 text-sm", children: [
                    /* @__PURE__ */ jsx("span", { className: "font-medium text-[color:var(--fg-2)]", children: "יעד" }),
                    /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num text-[color:var(--up)]", children: fmt(target) })
                  ] })
                ] }),
                verdict.verdict && /* @__PURE__ */ jsx("p", { dir: "rtl", className: "text-[15px] leading-relaxed", children: verdict.verdict }),
                verdict.bullets?.length > 0 && /* @__PURE__ */ jsx("ul", { dir: "rtl", className: "sp-list text-sm text-[color:var(--fg-2)]", style: { "--marker": "var(--accent)" }, children: verdict.bullets.map((b, i) => /* @__PURE__ */ jsx("li", { children: b }, i)) }),
                verdict.dataNote && /* @__PURE__ */ jsx("p", { dir: "rtl", className: "border-t border-[color:var(--line-soft)] pt-2 text-xs text-[color:var(--fg-3)]", children: verdict.dataNote })
              ] }),
              /* @__PURE__ */ jsx("p", { className: "text-center text-[11px] text-[color:var(--fg-4)]", children: "הגרף באדיבות TradingView. כלי עזר להחלטה, לא ייעוץ השקעות." })
            ] })
          ]
        }
      )
    }
  );
}
function TableTab({ portfolio, rows, stats, verdictOf, digestState, sort, setSort, onOpen }) {
  const cur = portfolio.currency || "USD";
  const sorted = useMemo(() => {
    const val = (p, k) => {
      const v = verdictOf(p.ticker);
      if (k === "stop") return stopRoom(p.currentPrice, validStop(v, p.currentPrice));
      if (k === "target") return v?.target ?? null;
      if (k === "action") return v ? ACTIONS[v.action]?.rank ?? 9 : 99;
      return p[k] ?? null;
    };
    const list = [...rows];
    list.sort((a, b) => {
      const x = val(a, sort.key), y = val(b, sort.key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return sort.dir === "asc" ? c : -c;
    });
    return list;
  }, [rows, sort, verdictOf]);
  const head = (col) => {
    const active = sort.key === col.key;
    return /* @__PURE__ */ jsx("th", { scope: "col", className: `whitespace-nowrap border-b border-[color:var(--line)] px-3 py-3 text-start text-xs font-medium text-[color:var(--fg-3)] ${col.key === "ticker" ? "sticky right-0 z-[2] bg-[color:var(--card)]" : ""}`, children: /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => setSort((s) => ({ key: col.key, dir: s.key === col.key && s.dir === "desc" ? "asc" : "desc" })),
        className: `inline-flex items-center gap-1 ${active ? "text-[color:var(--fg)]" : ""}`,
        children: [
          col.label,
          active && /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: sort.dir === "desc" ? "↓" : "↑" })
        ]
      }
    ) }, col.key);
  };
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-4", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-baseline gap-3", children: [
      /* @__PURE__ */ jsx("h2", { className: "text-lg font-bold", children: "טבלת תיק מלאה" }),
      /* @__PURE__ */ jsxs("span", { className: "text-sm text-[color:var(--fg-3)]", children: [
        rows.length,
        " פוזיציות · לחיצה על כותרת ממיינת"
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "overflow-x-auto rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)]", children: /* @__PURE__ */ jsxs("table", { className: "w-full border-collapse text-sm", children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsx("tr", { children: TABLE_COLUMNS.map(head) }) }),
      /* @__PURE__ */ jsx("tbody", { children: sorted.map((p) => {
        const v = verdictOf(p.ticker);
        const pos = (p.pnl ?? 0) >= 0;
        return /* @__PURE__ */ jsxs("tr", { onClick: () => onOpen?.(p.ticker), className: "cursor-pointer hover:bg-[color:var(--tint)]", children: [
          /* @__PURE__ */ jsx("td", { className: "sticky right-0 z-[1] whitespace-nowrap border-b border-[color:var(--line-soft)] bg-[color:var(--card)] px-3 py-3", children: /* @__PURE__ */ jsx("b", { dir: "ltr", children: p.ticker }) }),
          /* @__PURE__ */ jsx("td", { className: "max-w-[180px] truncate border-b border-[color:var(--line-soft)] px-3 py-3 text-[color:var(--fg-2)]", children: p.companyName }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { children: qty(p.shares) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { children: fmt(p.avgPrice) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { children: fmt(p.currentPrice) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { children: money(p.value, cur) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { className: pos ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedMoney(p.pnl, cur) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { className: pos ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedPct(p.pnlPct) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { children: p.allocationPct == null ? "—" : `${fmt(p.allocationPct, 1)}%` }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: (() => {
            const st = validStop(v, p.currentPrice), room = stopRoom(p.currentPrice, st);
            return /* @__PURE__ */ jsxs("span", { className: "flex flex-col leading-tight", children: [
              /* @__PURE__ */ jsx(Num, { className: "text-[color:var(--down)]", children: fmt(st) }),
              room != null && /* @__PURE__ */ jsxs(Num, { className: `text-[11px] ${room < 2 ? "font-semibold text-[color:var(--down)]" : "text-[color:var(--fg-3)]"}`, children: [
                room < 2 ? "קרוב! " : "",
                "−",
                fmt(room, 1),
                "%"
              ] })
            ] });
          })() }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(Num, { className: "text-[color:var(--up)]", children: fmt(v?.target) }) }),
          /* @__PURE__ */ jsx("td", { className: "whitespace-nowrap border-b border-[color:var(--line-soft)] px-3 py-3", children: /* @__PURE__ */ jsx(ActionBadge, { action: v?.action, waiting: digestState.busy, showDetail: true }) })
        ] }, p.ticker);
      }) }),
      /* @__PURE__ */ jsx("tfoot", { children: /* @__PURE__ */ jsxs("tr", { className: "text-[color:var(--fg-2)]", children: [
        /* @__PURE__ */ jsx("td", { className: "px-3 py-3 font-semibold", children: "סה״כ" }),
        /* @__PURE__ */ jsx("td", { className: "px-3 py-3", colSpan: 4, children: stats.cash != null && /* @__PURE__ */ jsxs(Fragment, { children: [
          "מזומן ",
          /* @__PURE__ */ jsx(Num, { children: money(stats.cash, cur) })
        ] }) }),
        /* @__PURE__ */ jsx("td", { className: "px-3 py-3 font-semibold", children: /* @__PURE__ */ jsx(Num, { children: money(stats.equity, cur) }) }),
        /* @__PURE__ */ jsx("td", { className: "px-3 py-3 font-semibold", children: /* @__PURE__ */ jsx(Num, { className: stats.pnl >= 0 ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedMoney(stats.pnl, cur) }) }),
        /* @__PURE__ */ jsx("td", { className: "px-3 py-3 font-semibold", children: /* @__PURE__ */ jsx(Num, { className: stats.pnl >= 0 ? "text-[color:var(--up)]" : "text-[color:var(--down)]", children: signedPct(stats.pnlPct) }) }),
        /* @__PURE__ */ jsxs("td", { className: "px-3 py-3", colSpan: 4, children: [
          "שווי תיק ",
          /* @__PURE__ */ jsx(Num, { children: money(stats.total, cur) })
        ] })
      ] }) })
    ] }) }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-3 text-xs text-[color:var(--fg-3)]", children: [
      /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx(ActionBadge, { action: "ADD" }),
        " הוספה לפוזיציה"
      ] }),
      /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx(ActionBadge, { action: "HOLD" }),
        " להחזיק לפי הסטופ"
      ] }),
      /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx(ActionBadge, { action: "TRIM" }),
        " מכירה חלקית"
      ] }),
      /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx(ActionBadge, { action: "CUT_LOSS" }),
        " יציאה (מימוש רווח / קיטוע הפסד)"
      ] })
    ] })
  ] });
}
function SecretsSection({ health, onHealth }) {
  const [key, setKey] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setMsg("");
    try {
      const h = await saveSecrets({ GEMINI_API_KEY: key, TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_CHAT_ID: tgChat });
      onHealth(h);
      setKey("");
      setTgToken("");
      setTgChat("");
      setMsg("נשמר.");
    } catch (e) {
      setMsg(e.message || "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }
  const field = "min-h-10 w-full rounded-xl border border-[color:var(--line-2)] bg-[color:var(--input)] px-3 text-sm outline-none focus:border-[#0a84ff]";
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-5", children: [
    /* @__PURE__ */ jsx("h3", { className: "font-semibold", children: "חיבורים" }),
    /* @__PURE__ */ jsx("p", { className: "-mt-1 text-xs text-[color:var(--fg-3)]", children: health?.platform === "cloud" ? "נשמרים בחשבון שלך בשרת. לא מוצגים שוב אחרי השמירה. מפתח Gemini אישי מבטל את המכסה היומית." : "נשמרים במאפייני הסקריפט בחשבון הגוגל שלך. לא מוצגים שוב אחרי השמירה. שדה ריק משאיר את הערך הקיים." }),
    /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1 text-sm", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        "מפתח Gemini ",
        /* @__PURE__ */ jsxs("span", { className: health?.keySet ? "text-[color:var(--up)]" : "text-[color:var(--warn)]", children: [
          "· ",
          health?.platform === "cloud" && !health.ownKey ? `משותף (${health.aiUsed || 0}/${health.aiLimit} היום)` : health?.keySet ? "מוגדר" : "חסר"
        ] })
      ] }),
      /* @__PURE__ */ jsx("input", { type: "password", autoComplete: "off", dir: "ltr", value: key, onChange: (e) => setKey(e.target.value), placeholder: health?.keySet ? "••••••••" : "AIza…", className: field })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [
      /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1 text-sm", children: [
        /* @__PURE__ */ jsxs("span", { children: [
          "טוקן בוט טלגרם ",
          /* @__PURE__ */ jsxs("span", { className: health?.telegram ? "text-[color:var(--up)]" : "text-[color:var(--fg-3)]", children: [
            "· ",
            health?.telegram ? "מחובר" : "לא מחובר"
          ] })
        ] }),
        /* @__PURE__ */ jsx("input", { type: "password", autoComplete: "off", dir: "ltr", value: tgToken, onChange: (e) => setTgToken(e.target.value), placeholder: "123456:ABC…", className: field })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1 text-sm", children: [
        /* @__PURE__ */ jsx("span", { children: "Chat ID בטלגרם" }),
        /* @__PURE__ */ jsx("input", { type: "text", autoComplete: "off", dir: "ltr", value: tgChat, onChange: (e) => setTgChat(e.target.value), placeholder: "123456789", className: field })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: save,
          disabled: busy || !(key || tgToken || tgChat),
          className: "min-h-10 rounded-xl bg-[#0a84ff] px-4 text-sm font-semibold text-white disabled:opacity-40",
          children: busy ? "שומר…" : "שמירה"
        }
      ),
      msg && /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-2)]", children: msg })
    ] })
  ] });
}
function PushSection({ health }) {
  const [state, setState] = useState("checking");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushState().then(setState).catch(() => setState("off"));
  }, []);
  async function turnOn() {
    setBusy(true);
    setMsg("");
    try {
      if (!health?.vapidPublicKey) throw new Error("השרת עוד לא מוכן להתראות");
      await enablePush(health.vapidPublicKey);
      setState("on");
      setMsg("הטלפון רשום להתראות.");
    } catch (e) {
      setMsg(e.message || "ההפעלה נכשלה");
      setState(await pushState().catch(() => "off"));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setMsg("");
    try {
      await testPush();
      setMsg("נשלחה התראת בדיקה. היא אמורה להופיע בעוד כמה שניות.");
    } catch (e) {
      setMsg(e.message || "השליחה נכשלה");
    } finally {
      setBusy(false);
    }
  }
  const standalone = typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone);
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-5", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h3", { className: "font-semibold", children: "התראות לטלפון" }),
        /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: state === "on" ? "פעיל במכשיר הזה. התראות מגיעות גם כשהאפליקציה סגורה." : state === "denied" ? "ההתראות חסומות בדפדפן. אפשרו אותן בהגדרות האתר ונסו שוב." : state === "unsupported" ? "הדפדפן הזה לא תומך בהתראות. במכשיר אנדרואיד פתחו ב-Chrome." : "באנר בטלפון לכל התראה, גם כשהאפליקציה סגורה." })
      ] }),
      /* @__PURE__ */ jsx("span", { className: "ms-auto flex items-center gap-2", children: state === "on" ? /* @__PURE__ */ jsx("button", { type: "button", onClick: test, disabled: busy, className: "min-h-10 rounded-xl border border-[color:var(--line-2)] px-3 text-sm hover:bg-[color:var(--tint)] disabled:opacity-40", children: "שלח בדיקה" }) : state !== "unsupported" && state !== "denied" && /* @__PURE__ */ jsx("button", { type: "button", onClick: turnOn, disabled: busy || state === "checking", className: "min-h-10 rounded-xl bg-[#0a84ff] px-4 text-sm font-semibold text-white disabled:opacity-40", children: busy ? "מפעיל…" : "הפעל התראות" }) })
    ] }),
    !standalone && state !== "unsupported" && /* @__PURE__ */ jsx("div", { className: "rounded-xl bg-[color:var(--inset)] p-3 text-xs text-[color:var(--fg-3)]", children: 'כדאי קודם להוסיף את האפליקציה למסך הבית: תפריט Chrome ← "הוספה למסך הבית" / "התקנת אפליקציה".' }),
    msg && /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-2)]", children: msg }),
    health?.pushSubs > 0 && /* @__PURE__ */ jsxs("div", { className: "text-xs text-[color:var(--fg-3)]", children: [
      "מכשירים רשומים: ",
      health.pushSubs
    ] })
  ] });
}
function SettingsTab({ settings, setSettings, nextRun, now, health, serverOk, onRunNow, digestBusy, hasPortfolio, onLogout, onHealth }) {
  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const updateType = (k, v) => setSettings((s) => ({ ...s, alertTypes: { ...s.alertTypes, [k]: v } }));
  const notifSupported = typeof window !== "undefined" && "Notification" in window;
  const [notifMsg, setNotifMsg] = useState("");
  async function toggleNotifications(on) {
    setNotifMsg("");
    if (!on) {
      update({ browserNotifications: false });
      return;
    }
    if (!notifSupported) {
      setNotifMsg("הדפדפן הזה לא תומך בהתראות.");
      return;
    }
    try {
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm === "granted") update({ browserNotifications: true });
      else setNotifMsg("ההרשאה להתראות נדחתה בדפדפן.");
    } catch {
      setNotifMsg("לא ניתן לבקש הרשאת התראות כאן.");
    }
  }
  const typeRows = [
    { k: "sell", title: "מכור — יציאה מלאה", sub: "מימוש רווח או קיטוע הפסד. נשלחת בכל סריקה עד שמבצעים." },
    { k: "trim", title: "מכור חלקית — צמצום", sub: "פעם אחת, כשההמלצה מופיעה." },
    { k: "buy", title: "קנה — הוספה לפוזיציה", sub: "פעם אחת, כשההמלצה מופיעה." },
    { k: "change", title: "כל שינוי בהמלצה", sub: "למשל החזק ← מכור, גם אם הסוג למעלה כבוי." },
    ...health?.agent ? [{ k: "stop", title: "נפרץ סטופ", sub: "המחיר החי ירד מתחת לסטופ שהוצע. פעם ביום לכל מניה." }] : []
  ];
  const [tgMsg, setTgMsg] = useState("");
  async function runTelegramTest() {
    setTgMsg("שולח…");
    try {
      await testTelegram();
      setTgMsg("נשלחה הודעת בדיקה לטלגרם.");
    } catch (e) {
      setTgMsg(e.message || "השליחה נכשלה");
    }
  }
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-4", children: [
    /* @__PURE__ */ jsx("h2", { className: "text-lg font-bold", children: "הגדרות סוכנים והתראות" }),
    (GAS || REMOTE) && /* @__PURE__ */ jsx(SecretsSection, { health, onHealth }),
    REMOTE && /* @__PURE__ */ jsx(PushSection, { health }),
    /* @__PURE__ */ jsxs("div", { className: "grid gap-4 lg:grid-cols-2", children: [
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-4 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-5", children: [
        /* @__PURE__ */ jsx("h3", { className: "font-semibold", children: "תדירות סריקה" }),
        /* @__PURE__ */ jsx("p", { className: "-mt-2 text-sm text-[color:var(--fg-3)]", children: "כל סריקה שולחת את התיק ל-Gemini לקבלת המלצות מעודכנות, עם מחירים חיים וממוצעים נעים." }),
        /* @__PURE__ */ jsx("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-5", children: FREQUENCIES.map((f) => /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => update({ frequency: f.id }),
            className: `rounded-xl border px-3 py-2 text-sm ${settings.frequency === f.id ? "border-[#0a84ff] bg-[color:var(--accent-bg)] text-[color:var(--fg)]" : "border-[color:var(--line)] text-[color:var(--fg-2)] hover:bg-[color:var(--tint)]"}`,
            children: f.label
          },
          f.id
        )) }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 border-t border-[color:var(--line)] pt-4", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm", children: "רק בשעות המסחר בארה״ב" }),
            /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: "16:30–23:00 שעון ישראל (לא חל על סוף יום)" })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "ms-auto", children: /* @__PURE__ */ jsx(Toggle, { on: settings.marketHoursOnly, onChange: (v) => update({ marketHoursOnly: v }), label: "רק בשעות מסחר" }) })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 border-t border-[color:var(--line)] pt-4", children: [
          /* @__PURE__ */ jsx(Icon, { name: "clock", className: "h-5 w-5 text-[color:var(--fg-3)]" }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm", children: "סריקה הבאה" }),
            /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: !hasPortfolio ? "אחרי ייבוא התיק" : nextRun ? `${dateTimeFmt(nextRun)} · בעוד ${countdown(nextRun - now)}` : "ידני בלבד" })
          ] }),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: onRunNow,
              disabled: !hasPortfolio || !serverOk || digestBusy,
              className: "ms-auto flex items-center gap-1.5 rounded-xl border border-[color:var(--line-2)] px-3 py-2 text-sm hover:bg-[color:var(--tint)] disabled:opacity-40",
              children: [
                /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: digestBusy }),
                " סרוק עכשיו"
              ]
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "rounded-xl bg-[color:var(--inset)] p-3 text-xs text-[color:var(--fg-3)]", children: [
          health?.agent ? "הסריקה רצה בשרת, גם כשהדף סגור." : "הסריקה רצה כשהדף פתוח.",
          " סוף יום = 16:15 שעון ניו יורק (23:15 בישראל ברוב השנה), בימי המסחר בארה״ב (ב׳–ו׳)."
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-4 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-5", children: [
        /* @__PURE__ */ jsx("h3", { className: "font-semibold", children: "סינון התראות" }),
        typeRows.map((r) => /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm", children: r.title }),
            /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: r.sub })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "ms-auto", children: /* @__PURE__ */ jsx(Toggle, { on: !!settings.alertTypes[r.k], onChange: (v) => updateType(r.k, v), label: r.title }) })
        ] }, r.k)),
        /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 border-t border-[color:var(--line)] pt-4", children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between text-sm", children: [
            /* @__PURE__ */ jsx("span", { children: "הקצאה מינימלית להתראה" }),
            /* @__PURE__ */ jsxs("b", { className: "tabular-nums", children: [
              settings.minAllocationPct,
              "%"
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "range",
              min: "0",
              max: "20",
              step: "1",
              value: settings.minAllocationPct,
              dir: "ltr",
              onChange: (e) => update({ minAllocationPct: Number(e.target.value) }),
              className: "w-full accent-[#0a84ff]",
              "aria-label": "הקצאה מינימלית להתראה"
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-3)]", children: "פוזיציות קטנות מזה לא יקפיצו התראה (הן עדיין מופיעות בטבלה)." })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 border-t border-[color:var(--line)] pt-4", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm", children: "התראות דפדפן" }),
            /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: notifSupported ? "הודעה קופצת גם כשהלשונית ברקע" : "לא נתמך בדפדפן הזה" })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "ms-auto", children: /* @__PURE__ */ jsx(Toggle, { on: settings.browserNotifications, onChange: toggleNotifications, label: "התראות דפדפן" }) })
        ] }),
        notifMsg && /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--warn)]", children: notifMsg }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 border-t border-[color:var(--line)] pt-4", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm", children: "התראות לטלגרם" }),
            /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: health?.telegram ? "השרת שולח כל התראה לטלגרם, גם כשהדף סגור" : GAS || REMOTE ? "הזינו טוקן ו-Chat ID בחיבורים למעלה" : "לא מוגדר בשרת (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)" })
          ] }),
          /* @__PURE__ */ jsxs("span", { className: "ms-auto flex items-center gap-2", children: [
            health?.telegram && /* @__PURE__ */ jsx("button", { type: "button", onClick: runTelegramTest, className: "rounded-lg border border-[color:var(--line-2)] px-2 py-1 text-xs hover:bg-[color:var(--tint)]", children: "בדיקה" }),
            /* @__PURE__ */ jsx(Toggle, { on: !!health?.telegram && settings.telegram !== false, onChange: (v) => update({ telegram: v }), label: "התראות לטלגרם" })
          ] })
        ] }),
        tgMsg && /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-2)]", children: tgMsg })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-5 text-sm", children: [
      /* @__PURE__ */ jsx("span", { className: `h-2.5 w-2.5 rounded-full ${serverOk ? "bg-[#30d158]" : "bg-[#ffd60a]"}` }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsxs("div", { children: [
          serverOk ? "שרת Gemini מחובר" : "שרת Gemini לא נגיש",
          " · גרסה ",
          APP_VERSION,
          " (Gemini Core)"
        ] }),
        /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: serverOk && health ? `מודל ${health.model} · ${health.search ? "המלצות עם חיפוש Google עדכני" : "המלצות לפי נתוני התיק בלבד"} · עד ${health.maxFiles} צילומים` : REMOTE || GAS ? "אין חיבור לשרת כרגע" : "הפעילו start.bat ופתחו http://localhost:5001/app" })
      ] }),
      health?.auth && /* @__PURE__ */ jsx("button", { type: "button", onClick: onLogout, className: "ms-auto rounded-xl border border-[color:var(--line-2)] px-3 py-2 text-sm hover:bg-[color:var(--tint)]", children: "התנתקות" })
    ] })
  ] });
}
function AlertsTab({ alerts, clearAlerts }) {
  const cur = alerts;
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-4", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
      /* @__PURE__ */ jsx("h2", { className: "text-lg font-bold", children: "יומן התראות" }),
      /* @__PURE__ */ jsxs("span", { className: "text-sm text-[color:var(--fg-3)]", children: [
        cur.length,
        " רשומות"
      ] }),
      cur.length > 0 && /* @__PURE__ */ jsxs("button", { type: "button", onClick: clearAlerts, className: "ms-auto flex items-center gap-1.5 rounded-xl border border-[color:var(--line-2)] px-3 py-2 text-sm hover:bg-[color:var(--tint)]", children: [
        /* @__PURE__ */ jsx(Icon, { name: "trash" }),
        " ניקוי"
      ] })
    ] }),
    cur.length === 0 ? /* @__PURE__ */ jsx("p", { className: "rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-6 text-center text-sm text-[color:var(--fg-3)]", children: "אין התראות עדיין. הן יופיעו כאן אחרי כל סריקה, לפי הסינון בהגדרות." }) : /* @__PURE__ */ jsx("ul", { className: "overflow-hidden rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)]", children: cur.map((a) => /* @__PURE__ */ jsxs("li", { className: "flex gap-3 border-b border-[color:var(--line-soft)] px-4 py-3 last:border-b-0", children: [
      /* @__PURE__ */ jsx("span", { className: "w-24 flex-none pt-0.5 text-xs tabular-nums text-[color:var(--fg-3)]", children: dateTimeFmt(a.at) }),
      /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
          /* @__PURE__ */ jsx("b", { dir: "ltr", children: a.ticker }),
          a.from && /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsx(ActionBadge, { action: a.from }),
            /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: "←" })
          ] }),
          /* @__PURE__ */ jsx(ActionBadge, { action: a.action, showDetail: true }),
          /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-4)]", children: a.trigger === "auto" ? "סריקה אוטומטית" : a.trigger === "import" ? "אחרי ייבוא" : "סריקה ידנית" })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "mt-1 text-sm text-[color:var(--fg-2)]", children: a.text }),
        a.stop != null && /* @__PURE__ */ jsxs("p", { className: "text-xs text-[color:var(--fg-3)]", children: [
          "סטופ נגרר ",
          /* @__PURE__ */ jsx(Num, { children: fmt(a.stop) })
        ] })
      ] })
    ] }, a.id)) })
  ] });
}
function AccountBadge({ health, status, onReconnect, onSwitchCode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return void 0;
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const account = health?.account || "";
  const sheet = health?.sheet || {};
  const cloud = health?.platform === "cloud";
  const tone = status === "online" ? "up" : status === "offline" ? "warn" : "fg-4";
  const label = status === "online" ? "מחובר לשרת" : status === "offline" ? "השרת לא עונה" : "בודק חיבור…";
  const initial = (account.trim()[0] || "?").toUpperCase();
  const mismatch = health?.version && health.version !== APP_VERSION;
  return /* @__PURE__ */ jsxs("div", { ref, className: "relative", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen((o) => !o),
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "aria-label": account ? `חשבון מחובר: ${account}` : "מצב חיבור",
        className: "flex h-10 items-center gap-2 rounded-full border border-[color:var(--line-2)] bg-[color:var(--tint)] ps-1 pe-1 hover:bg-[color:var(--tint-2)] sm:pe-3",
        children: [
          /* @__PURE__ */ jsxs("span", { className: "relative grid h-8 w-8 flex-none place-items-center rounded-full bg-gradient-to-br from-[#30d158] to-[#0a84ff] text-sm font-bold text-white", children: [
            initial,
            /* @__PURE__ */ jsx("span", { className: `absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full border-2 border-[color:var(--bg)] ${status === "checking" ? "animate-pulse" : ""}`, style: { background: `var(--${tone})` } })
          ] }),
          /* @__PURE__ */ jsx("span", { dir: "ltr", className: "hidden max-w-[11rem] truncate text-xs font-medium text-[color:var(--fg-2)] sm:inline", children: account || label })
        ]
      }
    ),
    open && /* @__PURE__ */ jsxs(
      "div",
      {
        role: "dialog",
        "aria-label": "חשבון מחובר",
        className: "sp-pop absolute left-0 top-12 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-2 text-sm shadow-2xl",
        children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 rounded-xl px-2 py-2.5", children: [
            /* @__PURE__ */ jsx("span", { className: "grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--accent-bg)] text-[color:var(--accent)]", children: /* @__PURE__ */ jsx(Icon, { name: "user" }) }),
            /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
              /* @__PURE__ */ jsx("div", { className: "text-[11px] text-[color:var(--fg-3)]", children: "חשבון Google" }),
              /* @__PURE__ */ jsx("div", { dir: "ltr", className: "truncate text-right font-medium", children: account || "לא ידוע" })
            ] })
          ] }),
          cloud ? /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 rounded-xl px-2 py-2.5", children: [
            /* @__PURE__ */ jsx("span", { className: "grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--up-bg)] text-[color:var(--up)]", children: /* @__PURE__ */ jsx(Icon, { name: "pulse" }) }),
            /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
              /* @__PURE__ */ jsx("div", { className: "text-[11px] text-[color:var(--fg-3)]", children: "ניתוחי AI היום" }),
              /* @__PURE__ */ jsx("div", { className: "sp-num font-medium", children: health.ownKey ? "ללא הגבלה (מפתח אישי)" : `${health.aiUsed || 0} מתוך ${health.aiLimit || "—"}` })
            ] })
          ] }) : /* @__PURE__ */ jsxs(
            "a",
            {
              href: safeUrl(sheet.url),
              target: "_blank",
              rel: "noreferrer",
              className: `flex items-center gap-3 rounded-xl px-2 py-2.5 ${sheet.url ? "hover:bg-[color:var(--tint)]" : "pointer-events-none"}`,
              children: [
                /* @__PURE__ */ jsx("span", { className: "grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--up-bg)] text-[color:var(--up)]", children: /* @__PURE__ */ jsx(Icon, { name: "sheet" }) }),
                /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
                  /* @__PURE__ */ jsx("div", { className: "text-[11px] text-[color:var(--fg-3)]", children: "גיליון התיק" }),
                  /* @__PURE__ */ jsx("div", { className: "truncate font-medium", children: sheet.name || "—" })
                ] }),
                sheet.url && /* @__PURE__ */ jsx("span", { className: "ms-auto text-[color:var(--fg-3)]", children: /* @__PURE__ */ jsx(Icon, { name: "link", className: "h-3.5 w-3.5" }) })
              ]
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 rounded-xl px-2 py-2.5", children: [
            /* @__PURE__ */ jsx("span", { className: "grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--tint-2)]", children: /* @__PURE__ */ jsx("span", { className: `h-2.5 w-2.5 rounded-full ${status === "checking" ? "animate-pulse" : ""}`, style: { background: `var(--${tone})` } }) }),
            /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
              /* @__PURE__ */ jsx("div", { className: "text-[11px] text-[color:var(--fg-3)]", children: "שרת" }),
              /* @__PURE__ */ jsxs("div", { className: "font-medium", children: [
                label,
                health?.model ? /* @__PURE__ */ jsxs("span", { className: "text-[color:var(--fg-3)]", children: [
                  " · ",
                  /* @__PURE__ */ jsx("span", { dir: "ltr", children: health.model })
                ] }) : null
              ] }),
              /* @__PURE__ */ jsxs("div", { dir: "ltr", className: "sp-num text-right text-[11px] text-[color:var(--fg-3)]", children: [
                "app v",
                APP_VERSION,
                health?.version ? ` · server v${health.version}` : ""
              ] }),
              mismatch && /* @__PURE__ */ jsx("div", { className: "text-[11px] text-[color:var(--warn)]", children: "גרסת השרת שונה מהאפליקציה" })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "mt-1 grid grid-cols-2 gap-2 border-t border-[color:var(--line-soft)] p-2 pt-3", children: [
            /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => {
                  onReconnect();
                },
                className: "flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-[color:var(--line-2)] text-[13px] font-medium hover:bg-[color:var(--tint)]",
                children: [
                  /* @__PURE__ */ jsx(Icon, { name: "refresh", className: "h-3.5 w-3.5" }),
                  "התחבר מחדש"
                ]
              }
            ),
            /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => {
                  setOpen(false);
                  onSwitchCode();
                },
                className: "flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-[color:var(--inverse)] text-[13px] font-semibold text-[color:var(--inverse-fg)]",
                children: [
                  /* @__PURE__ */ jsx(Icon, { name: "key", className: "h-3.5 w-3.5" }),
                  cloud ? "התנתקות" : "החלף קוד גישה"
                ]
              }
            )
          ] })
        ]
      }
    )
  ] });
}
var LS_MODE = "swingpulse.mode";
var DEMO_DAYS = 30;
var TRADE_MODES = ["live", "demo"];
function requireMode(mode) {
  if (!TRADE_MODES.includes(mode)) throw Object.assign(new Error("מצב לא ברור (תיק אמיתי / דמו). שום דבר לא נשלח."), { code: "bad_mode" });
  if (SANDBOX && mode !== "demo") throw Object.assign(new Error("בדמו המקומי אין תיק אמיתי."), { code: "bad_mode" });
  return mode;
}
var demoApi = {
  get: () => rpc("getDemo"),
  reset: () => rpc("demoReset"),
  put: (patch) => rpc("putDemo", patch),
  parse: async (text, mode) => rpc("parseTrade", text, requireMode(mode)),
  apply: async (trades, mode, source) => rpc("applyTrades", trades, requireMode(mode), source),
  analysts: (ticker, mode, refresh = false) => rpc("analysts", ticker, mode, refresh),
  place: async (order, mode) => rpc("placeOrder", order, requireMode(mode)),
  cancel: async (id, mode) => rpc("cancelOrder", id, requireMode(mode)),
  fill: async (id, mode, price) => rpc("fillOrder", id, requireMode(mode), price)
};
function ModeNotice({ mode }) {
  const live = mode === "live";
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: "note",
      className: "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold",
      style: live ? { borderColor: "var(--down)", background: "color-mix(in srgb, var(--down) 12%, transparent)", color: "var(--down)" } : { borderColor: "var(--warn-line)", background: "var(--warn-bg)", color: "var(--warn)" },
      children: [
        /* @__PURE__ */ jsx(Icon, { name: "alert", className: "h-4 w-4 flex-none" }),
        live ? isCloud() ? "אזהרה: יעודכן התיק האמיתי בחשבון!" : "אזהרה: יעודכן התיק האמיתי בגיליון!" : "יעודכן תיק הדמו בלבד (ללא השפעה על האמיתי)"
      ]
    }
  );
}
var MANUAL_ACTIONS = [{ id: "BUY", label: "קנייה / חיזוק" }, { id: "SELL_PARTIAL", label: "מכירה חלקית" }, { id: "SELL_ALL", label: "מכירת הכל" }];
var ORDER_KINDS = [{ id: "MARKET", label: "שוק (Market)" }, { id: "LIMIT", label: "לימיט (Limit)" }];
var ORDER_STATUS = { open: "ממתינה", triggered: "הגיעה למחיר", filled: "בוצעה", cancelled: "בוטלה", failed: "נכשלה" };
var num = (v) => {
  const x = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : NaN;
};
function ManualTrade({ position, cash, mode, currency, orders = [], onApplied }) {
  const isDemo = mode === "demo";
  const held = Number(position.shares) || 0;
  const startPx = position.currentPrice > 0 ? String(Math.round(position.currentPrice * 100) / 100) : "";
  const [type, setType] = useState("BUY");
  const [kind, setKind] = useState("MARKET");
  const [count, setCount] = useState("");
  const [price, setPrice] = useState(startPx);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const shares = type === "SELL_ALL" ? held : num(count);
  const px = num(price);
  const amount = shares > 0 && px > 0 ? shares * px : null;
  const tooMany = type !== "BUY" && shares > held + 1e-9;
  const cashAfter = amount == null || cash == null ? null : type === "BUY" ? cash - amount : cash + amount;
  const realized = type !== "BUY" && amount != null && position.avgPrice > 0 ? shares * (px - position.avgPrice) : null;
  const limitOff = kind === "LIMIT" && SANDBOX;
  const ok = amount != null && !tooMany && !limitOff && !busy;
  const mine = orders.filter((o) => o.ticker === position.ticker && o.status !== "cancelled").slice(-6).reverse();
  const verb = kind === "LIMIT" ? "לשים פקודת לימיט" : isDemo ? "לבצע בדמו" : "לעדכן את התיק האמיתי";
  async function run(key, call, done) {
    setBusy(key);
    setNote(null);
    try {
      const r = await call();
      onApplied?.(r);
      setNote({ ok: true, text: done });
      if (key === "place") setCount("");
    } catch (e) {
      setNote({ ok: false, text: e.message || "הפעולה נכשלה" });
    } finally {
      setBusy("");
    }
  }
  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    const order = { type, ticker: position.ticker, shares, price: px, orderType: kind };
    run("place", () => demoApi.place(order, mode), kind === "LIMIT" ? "הפקודה נשמרה. בודקים אותה כל 15 דקות." : isDemo ? "בוצע בדמו" : "התיק האמיתי עודכן");
  };
  const input = "min-h-11 w-full rounded-xl border border-[color:var(--line-2)] bg-[color:var(--input)] px-3 text-base outline-none focus:border-[#0a84ff]";
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-4", children: [
    /* @__PURE__ */ jsxs("h3", { className: "flex items-center gap-2 text-sm font-bold", children: [
      "הוסף פעולה ידנית",
      /* @__PURE__ */ jsx("span", { className: "rounded-full px-2 py-0.5 text-[11px] font-semibold", style: isDemo ? { background: "var(--warn-bg)", color: "var(--warn)" } : { background: "var(--tint)", color: "var(--fg-2)" }, children: isDemo ? "דמו" : "תיק אמיתי" })
    ] }),
    /* @__PURE__ */ jsxs("form", { onSubmit: submit, className: "flex flex-col gap-3", children: [
      /* @__PURE__ */ jsx(
        Segmented,
        {
          ariaLabel: "סוג פעולה",
          value: type,
          onChange: (t) => {
            setType(t);
            setNote(null);
          },
          options: MANUAL_ACTIONS,
          className: "rounded-xl border border-[color:var(--line)] bg-[color:var(--inset)] p-1",
          itemClass: "flex-1 rounded-lg px-2 py-2 text-sm"
        }
      ),
      /* @__PURE__ */ jsx(
        Segmented,
        {
          ariaLabel: "סוג פקודה",
          value: kind,
          onChange: (k) => {
            setKind(k);
            setNote(null);
          },
          options: ORDER_KINDS,
          className: "rounded-xl border border-[color:var(--line)] bg-[color:var(--inset)] p-1",
          itemClass: "flex-1 rounded-lg px-2 py-2 text-sm"
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-2 gap-3", children: [
        /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1.5 text-xs text-[color:var(--fg-3)]", children: [
          "כמות ",
          type !== "BUY" && /* @__PURE__ */ jsxs("span", { children: [
            "(בתיק: ",
            qty(held),
            ")"
          ] }),
          /* @__PURE__ */ jsx(
            "input",
            {
              dir: "ltr",
              inputMode: "decimal",
              className: input,
              disabled: type === "SELL_ALL",
              value: type === "SELL_ALL" ? qty(held) : count,
              onChange: (e) => setCount(e.target.value),
              placeholder: "0"
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1.5 text-xs text-[color:var(--fg-3)]", children: [
          kind === "LIMIT" ? "מחיר לימיט" : "מחיר ביצוע",
          /* @__PURE__ */ jsx("input", { dir: "ltr", inputMode: "decimal", className: input, value: price, onChange: (e) => setPrice(e.target.value), placeholder: "0.00" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-[color:var(--inset)] p-3 text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: "סכום העסקה" }),
        /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num text-left", children: amount == null ? "—" : money(amount, currency, 2) }),
        /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: "מזומן אחרי" }),
        /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num text-left", style: { color: cashAfter != null && cashAfter < 0 ? "var(--down)" : void 0 }, children: cashAfter == null ? "—" : money(cashAfter, currency, 2) }),
        realized != null && /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: "רווח ממומש" }),
          /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num text-left", style: { color: realized >= 0 ? "var(--up)" : "var(--down)" }, children: signedMoney(realized, currency) })
        ] })
      ] }),
      kind === "LIMIT" && px > 0 && !limitOff && /* @__PURE__ */ jsxs("p", { className: "text-xs text-[color:var(--fg-3)]", children: [
        type === "BUY" ? `תתבצע כשהמחיר ירד ל-${money(px, currency, 2)} או פחות.` : `תתבצע כשהמחיר יעלה ל-${money(px, currency, 2)} או יותר.`,
        isDemo ? " בדמו היא מתבצעת לבד." : " בתיק האמיתי תקבל התראה, ומאשרים אחרי שביצעת בבלינק."
      ] }),
      limitOff && /* @__PURE__ */ jsx("p", { className: "text-xs text-[color:var(--warn)]", children: "פקודת לימיט צריכה מחירים חיים. זמינה בחשבון אישי." }),
      tooMany && /* @__PURE__ */ jsx("p", { className: "text-xs text-[color:var(--down)]", children: "אי אפשר למכור יותר ממה שיש בתיק." }),
      note && /* @__PURE__ */ jsxs("p", { className: "sp-pop text-sm font-semibold", style: { color: note.ok ? "var(--up)" : "var(--down)" }, children: [
        note.ok ? "✓ " : "",
        note.text
      ] }, note.text),
      /* @__PURE__ */ jsx(ModeNotice, { mode: isDemo ? "demo" : "live" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "submit",
          disabled: !ok,
          className: "sp-press min-h-11 rounded-xl font-semibold disabled:opacity-40",
          style: isDemo ? { background: "var(--warn)", color: "#000" } : { background: "#0a84ff", color: "#fff" },
          children: busy === "place" ? "שולח…" : verb
        }
      )
    ] }),
    mine.length > 0 && /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 border-t border-[color:var(--line-soft)] pt-3", children: [
      /* @__PURE__ */ jsx("span", { className: "text-xs font-semibold text-[color:var(--fg-3)]", children: "פקודות לימיט" }),
      mine.map((o) => /* @__PURE__ */ jsxs("div", { className: "sp-pop flex flex-wrap items-center gap-2 text-sm", children: [
        /* @__PURE__ */ jsx("b", { children: TRADE_HE[o.type] || o.type }),
        /* @__PURE__ */ jsxs("span", { dir: "ltr", className: "sp-num", children: [
          qty(o.shares),
          " @ ",
          money(o.limit, currency, 2)
        ] }),
        /* @__PURE__ */ jsx("span", { className: "rounded-full px-2 py-0.5 text-[11px]", style: { background: o.status === "triggered" ? "var(--warn-bg)" : "var(--tint)", color: o.status === "triggered" ? "var(--warn)" : "var(--fg-2)" }, children: ORDER_STATUS[o.status] || o.status }),
        o.error && /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--down)]", children: o.error }),
        /* @__PURE__ */ jsxs("span", { className: "ms-auto flex gap-2", children: [
          o.status === "triggered" && /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              disabled: !!busy,
              onClick: () => run(o.id, () => demoApi.fill(o.id, mode, o.limit), "התיק האמיתי עודכן"),
              className: "sp-press min-h-9 rounded-lg bg-[#0a84ff] px-3 text-xs font-semibold text-white disabled:opacity-40",
              children: "ביצעתי בבלינק · לעדכן"
            }
          ),
          (o.status === "open" || o.status === "triggered") && /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              disabled: !!busy,
              onClick: () => run(o.id, () => demoApi.cancel(o.id, mode), "הפקודה בוטלה"),
              className: "sp-press min-h-9 rounded-lg border border-[color:var(--line-2)] px-3 text-xs disabled:opacity-40",
              children: "ביטול"
            }
          )
        ] })
      ] }, o.id))
    ] })
  ] });
}
function portfolioStats(pf) {
  if (!pf) return null;
  const rows = (pf.positions || []).map(enrichPosition);
  const equity = rows.reduce((s, p) => s + (p.value || 0), 0);
  const cost = rows.reduce((s, p) => s + (p.cost || 0), 0);
  const cash = pf.cashBalance ?? null;
  const total = pf.totalPortfolioValue ?? equity + (cash || 0);
  return { equity, cost, cash, total, pnl: equity - cost, pnlPct: cost ? (equity / cost - 1) * 100 : null, exposure: total ? equity / total : null };
}
function tradeQuestion(t) {
  const n2 = Number(t.shares);
  const count = n2 === 1 ? "מניה אחת של" : `${qty(n2)} מניות`;
  const px = money(t.price, "USD", 2);
  if (t.type === "SELL_ALL") return `לאשר מכירת כל המניות של ${t.ticker} (${qty(n2)}) ב-${px}?`;
  return `לאשר ${t.type === "BUY" ? "קניית" : "מכירת"} ${count} ${t.ticker} ב-${px}?`;
}
function ModeSwitcher({ mode, setMode, demo, onReset, resetBusy, sandbox = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return void 0;
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const isDemo = mode === "demo";
  const item = (id, title, sub) => /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick: () => {
        setMode(id);
        setOpen(false);
      },
      className: `flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-right hover:bg-[color:var(--tint)] ${mode === id ? "bg-[color:var(--tint)]" : ""}`,
      children: [
        /* @__PURE__ */ jsx("span", { className: "mt-1 h-2.5 w-2.5 flex-none rounded-full", style: { background: id === "demo" ? "var(--warn)" : "var(--up)" } }),
        /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
          /* @__PURE__ */ jsx("b", { className: "block text-sm", children: title }),
          /* @__PURE__ */ jsx("span", { className: "block text-xs text-[color:var(--fg-3)]", children: sub })
        ] }),
        mode === id && /* @__PURE__ */ jsx("span", { className: "text-[color:var(--accent)]", children: "✓" })
      ]
    }
  );
  return /* @__PURE__ */ jsxs("div", { ref, className: "relative", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen((o) => !o),
        "aria-expanded": open,
        "aria-haspopup": "menu",
        className: "flex h-10 flex-none items-center gap-1.5 whitespace-nowrap rounded-xl border px-2.5 text-sm font-semibold",
        style: isDemo ? { borderColor: "var(--warn-line)", background: "var(--warn-bg)", color: "var(--warn)" } : { borderColor: "var(--line-2)" },
        children: [
          /* @__PURE__ */ jsx("span", { className: "h-2 w-2 rounded-full", style: { background: isDemo ? "var(--warn)" : "var(--up)" } }),
          /* @__PURE__ */ jsx("span", { children: isDemo ? "דמו" : /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsx("span", { className: "hidden min-[420px]:inline", children: "תיק " }),
            "אמיתי"
          ] }) }),
          /* @__PURE__ */ jsx("span", { className: `text-[color:var(--fg-3)] transition-transform duration-300 ${open ? "rotate-180" : ""}`, children: /* @__PURE__ */ jsx(Icon, { name: "chevron", className: "h-3.5 w-3.5" }) })
        ]
      }
    ),
    open && /* @__PURE__ */ jsxs("div", { role: "menu", className: "sp-pop absolute right-0 top-12 z-40 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-2 shadow-2xl", style: { transformOrigin: "top right" }, children: [
      sandbox ? /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          onClick: () => {
            setOpen(false);
            leaveSandbox();
          },
          className: "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-right hover:bg-[color:var(--tint)]",
          children: [
            /* @__PURE__ */ jsx("span", { className: "mt-1 h-2.5 w-2.5 flex-none rounded-full", style: { background: "var(--up)" } }),
            /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
              /* @__PURE__ */ jsx("b", { className: "block text-sm", children: "תיק אמיתי (Live)" }),
              /* @__PURE__ */ jsx("span", { className: "block text-xs text-[color:var(--fg-3)]", children: "לחבר חשבון אישי" })
            ] })
          ]
        }
      ) : item("live", "תיק אמיתי (Live)", "הפוזיציות האמיתיות שלך מבלינק"),
      item("demo", sandbox ? "מצב דמו (מקומי)" : "מצב דמו (ניסוי 30 יום)", demo?.zero ? `התחיל ב־${dateTimeFmt(demo.zero.at)}` : "תיק ניסוי שמתחיל מהתיק האמיתי"),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          disabled: resetBusy,
          onClick: () => {
            setOpen(false);
            setMode("demo");
            onReset();
          },
          className: "mt-1 flex w-full items-start gap-2 rounded-xl border-t border-[color:var(--line-soft)] px-3 py-2.5 text-right text-sm hover:bg-[color:var(--tint)] disabled:opacity-40",
          children: [
            /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: resetBusy, className: "mt-0.5 h-4 w-4 flex-none" }),
            /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
              /* @__PURE__ */ jsx("b", { className: "block", children: resetBusy ? "מעתיק…" : demo?.zero ? "איפוס הדמו" : "להתחיל דמו" }),
              /* @__PURE__ */ jsx("span", { className: "block text-xs text-[color:var(--fg-3)]", children: sandbox ? "חזרה לתיק הדוגמה המקורי" : "העתקה של התיק הקיים כנקודת התחלה" })
            ] })
          ]
        }
      )
    ] })
  ] });
}
function DemoStart({ onStart, busy, error, hasReal }) {
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col items-center gap-4 rounded-3xl border border-[color:var(--warn-line)] bg-[color:var(--card)] px-6 py-12 text-center", children: [
    /* @__PURE__ */ jsx("div", { className: "grid h-14 w-14 place-items-center rounded-2xl text-2xl", style: { background: "var(--warn-bg)", color: "var(--warn)" }, children: "0" }),
    /* @__PURE__ */ jsxs("h1", { className: "text-xl font-bold", children: [
      "מצב דמו · ניסוי של ",
      DEMO_DAYS,
      " יום"
    ] }),
    /* @__PURE__ */ jsxs("p", { className: "max-w-md text-sm leading-relaxed text-[color:var(--fg-2)]", children: [
      "הדמו מעתיק את התיק האמיתי שלך כמו שהוא עכשיו, עם המחירים של עכשיו. זו ",
      /* @__PURE__ */ jsx("b", { children: "נקודת האפס" }),
      ". מכאן אפשר לבצע בדמו את ההמלצות של האנליסטים ולראות אחרי חודש אם הם ניצחו את התיק האמיתי. התיק האמיתי לא משתנה."
    ] }),
    error && /* @__PURE__ */ jsx("p", { className: "text-sm text-[color:var(--down)]", children: error }),
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: onStart,
        disabled: busy || !hasReal,
        className: "flex min-h-11 items-center gap-2 rounded-xl px-5 font-semibold text-black disabled:opacity-40",
        style: { background: "var(--warn)" },
        children: [
          /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: busy, className: "h-4 w-4" }),
          busy ? "מעתיק…" : "להעתיק את התיק הקיים ולהתחיל"
        ]
      }
    ),
    !hasReal && /* @__PURE__ */ jsx("p", { className: "text-xs text-[color:var(--fg-3)]", children: "קודם צריך תיק אמיתי (ייבוא מבלינק)." })
  ] });
}
function BenchmarkBanner({ demo, demoStats, realStats, cur, onReset, resetBusy }) {
  const z = demo.zero;
  const demoRet = z.total ? (demoStats.total / z.total - 1) * 100 : null;
  const realRet = z.realTotal && realStats ? (realStats.total / z.realTotal - 1) * 100 : null;
  const alpha = demoRet != null && realRet != null ? demoRet - realRet : null;
  const day = Math.min(DEMO_DAYS, Math.max(1, Math.ceil((Date.now() - new Date(z.at).getTime()) / 864e5)));
  const tone = (v) => v == null ? "fg" : v >= 0 ? "up" : "down";
  const cell = (label, value, sub, t) => /* @__PURE__ */ jsxs("div", { className: "flex min-w-0 flex-col gap-0.5", children: [
    /* @__PURE__ */ jsx("span", { className: "text-[11px] text-[color:var(--fg-3)]", children: label }),
    /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num truncate text-right text-lg", style: { color: `var(--${t || "fg"})` }, children: value }),
    sub && /* @__PURE__ */ jsx("span", { className: "text-[11px] text-[color:var(--fg-3)]", children: sub })
  ] });
  return /* @__PURE__ */ jsxs("section", { className: "rounded-3xl border p-4 sm:p-5", style: { borderColor: "var(--warn-line)", background: "linear-gradient(180deg, var(--warn-bg), transparent 70%)" }, children: [
    /* @__PURE__ */ jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2", children: [
      /* @__PURE__ */ jsx("span", { className: "rounded-full px-2.5 py-0.5 text-xs font-bold", style: { background: "var(--warn-bg)", color: "var(--warn)" }, children: "מצב דמו" }),
      /* @__PURE__ */ jsxs("span", { className: "text-xs text-[color:var(--fg-3)]", children: [
        "יום ",
        day,
        " מתוך ",
        DEMO_DAYS,
        " · נקודת אפס ",
        dateTimeFmt(z.at)
      ] }),
      /* @__PURE__ */ jsx("div", { className: "ms-auto h-1.5 w-20 overflow-hidden rounded-full bg-[color:var(--tint-2)]", children: /* @__PURE__ */ jsx("div", { className: "h-full rounded-full", style: { width: `${day / DEMO_DAYS * 100}%`, background: "var(--warn)" } }) }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          onClick: onReset,
          disabled: resetBusy,
          title: "איפוס: העתקה מחדש של התיק הקיים",
          className: "sp-press flex min-h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold disabled:opacity-40",
          style: { borderColor: "var(--warn-line)", color: "var(--warn)" },
          children: [
            /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: resetBusy, className: "h-3.5 w-3.5" }),
            resetBusy ? "מעתיק…" : "איפוס"
          ]
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-2 gap-4 sm:grid-cols-4", children: [
      cell("שווי דמו נוכחי", money(demoStats.total, cur), `נקודת האפס ${money(z.total, cur)}`),
      cell("תשואת דמו", demoRet == null ? "—" : signedPct(demoRet, 2), "מנקודת האפס", tone(demoRet)),
      cell("תשואת תיק אמיתי", realRet == null ? "—" : signedPct(realRet, 2), "באותה תקופה", tone(realRet)),
      cell("פער (אלפא)", alpha == null ? "—" : signedPct(alpha, 2), alpha == null ? "" : Math.abs(alpha) < 5e-3 ? "שווה" : alpha > 0 ? "הדמו מוביל" : "התיק האמיתי מוביל", tone(alpha))
    ] }),
    demo.history?.length > 1 && /* @__PURE__ */ jsxs("details", { className: "mt-3 text-sm", children: [
      /* @__PURE__ */ jsxs("summary", { className: "cursor-pointer text-xs text-[color:var(--fg-3)]", children: [
        "פעולות בדמו (",
        demo.history.length - 1,
        ")"
      ] }),
      /* @__PURE__ */ jsx("ul", { className: "mt-2 flex flex-col gap-1", children: demo.history.filter((h) => h.source !== "system").slice(0, 20).map((h, i) => /* @__PURE__ */ jsxs("li", { className: "flex flex-wrap items-center gap-x-2 text-xs text-[color:var(--fg-2)]", children: [
        /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-4)]", children: dateTimeFmt(h.at) }),
        /* @__PURE__ */ jsx("b", { children: h.action }),
        " ",
        /* @__PURE__ */ jsx("b", { dir: "ltr", children: h.ticker }),
        /* @__PURE__ */ jsxs("span", { dir: "ltr", className: "sp-num", children: [
          h.shares,
          " @ ",
          h.price
        ] }),
        h.source && h.source !== "chat" && /* @__PURE__ */ jsxs("span", { className: "text-[color:var(--fg-4)]", children: [
          "· ",
          h.source
        ] })
      ] }, i)) })
    ] })
  ] });
}
function TradePreview({ p, mode }) {
  if (!p.ok) {
    return /* @__PURE__ */ jsx("li", { className: "rounded-2xl px-3 py-2.5 text-sm", style: { background: "var(--down-bg)", color: "var(--down)" }, children: p.error });
  }
  const t = p.trade;
  const line = (label, value, color) => /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 text-sm", children: [
    /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: label }),
    /* @__PURE__ */ jsx("span", { dir: "ltr", className: "sp-num font-semibold", style: color ? { color: `var(--${color})` } : void 0, children: value })
  ] });
  return /* @__PURE__ */ jsxs("li", { className: "flex flex-col gap-2 rounded-2xl border border-[color:var(--line)] bg-[color:var(--inset)] p-3", children: [
    /* @__PURE__ */ jsx("b", { className: "text-[15px]", children: tradeQuestion(t) }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
      line("כמות", `${qty(p.before.shares)} → ${qty(p.after.shares)}`),
      t.type === "BUY" && line("מחיר ממוצע", `${p.before.avgPrice != null ? fmt(p.before.avgPrice) : "—"} → ${fmt(p.after.avgPrice)}`),
      line("סכום העסקה", money(p.amount, "USD", 2)),
      line("מזומן", `${money(p.cashBefore, "USD", 2)} → ${money(p.cashAfter, "USD", 2)}`),
      t.type !== "BUY" && line("רווח ממומש", signedMoney(p.realized, "USD"), p.realized >= 0 ? "up" : "down")
    ] }),
    p.warning && /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--warn)]", children: p.warning }),
    t.priceSource === "live" && /* @__PURE__ */ jsx("span", { className: "text-xs text-[color:var(--fg-3)]", children: "לא צוין מחיר, נלקח המחיר החי." }),
    p.isNew && /* @__PURE__ */ jsxs("span", { className: "text-xs text-[color:var(--fg-3)]", children: [
      "מניה חדשה ב",
      mode === "demo" ? "דמו" : "תיק",
      "."
    ] })
  ] });
}
function TradeConfirm({ result, mode, busy, error, onConfirm, onCancel }) {
  const ok = (result.previews || []).filter((p) => p.ok);
  const live = mode === "live";
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3", children: [
    result.reply && /* @__PURE__ */ jsx("p", { className: "text-sm text-[color:var(--fg-2)]", children: result.reply }),
    (result.previews || []).length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-[color:var(--fg-3)]", children: 'לא זיהיתי קנייה או מכירה. נסו למשל: "מכרתי 5 מניות PLTR ב-173".' }) : /* @__PURE__ */ jsx("ul", { className: "flex flex-col gap-2", children: result.previews.map((p, i) => /* @__PURE__ */ jsx(TradePreview, { p: { ...p, trade: { ...p.trade, priceSource: result.trades?.[i]?.priceSource } }, mode }, i)) }),
    error && /* @__PURE__ */ jsx("p", { className: "text-sm text-[color:var(--down)]", children: error }),
    /* @__PURE__ */ jsx(ModeNotice, { mode }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: onConfirm,
          disabled: busy || !ok.length,
          className: "flex min-h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold disabled:opacity-40",
          style: live ? { background: "var(--inverse)", color: "var(--inverse-fg)" } : { background: "var(--warn)", color: "#000" },
          children: busy ? "מעדכן…" : ok.length > 1 ? `לאשר ${ok.length} פעולות` : "לאשר ולעדכן"
        }
      ),
      /* @__PURE__ */ jsx("button", { type: "button", onClick: onCancel, className: "min-h-10 rounded-xl border border-[color:var(--line-2)] px-4 text-sm", children: "ביטול" })
    ] })
  ] });
}
function CommandBar({ mode, enabled, onApplied }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const isDemo = mode === "demo";
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const reset = () => {
    setPhase("idle");
    setResult(null);
    setError("");
  };
  useEffect(() => {
    reset();
  }, [mode]);
  async function submit(e) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || phase === "parsing") return;
    setPhase("parsing");
    setError("");
    setResult(null);
    try {
      const sent = mode;
      const r = await demoApi.parse(msg, sent);
      if (modeRef.current !== sent) return;
      setResult({ ...r, mode: sent });
      setPhase("review");
    } catch (x) {
      setError(x.code === "gemini_no_key" ? "חסר מפתח Gemini בהגדרות." : x.message || "לא הצלחתי להבין");
      setPhase("idle");
    }
  }
  async function confirm() {
    const trades = (result.previews || []).filter((p) => p.ok).map((p) => ({ type: p.trade.type, ticker: p.trade.ticker, shares: p.trade.shares, price: p.trade.price }));
    if (result.mode !== mode) {
      reset();
      setError("המצב השתנה. שלחו שוב.");
      return;
    }
    setPhase("applying");
    setError("");
    try {
      const r = await demoApi.apply(trades, result.mode, "chat");
      onApplied(r);
      setText("");
      reset();
      setFlash(result.mode === "demo" ? "תיק הדמו עודכן" : "התיק האמיתי עודכן");
      setTimeout(() => setFlash(""), 3500);
    } catch (x) {
      setError(x.message || "העדכון נכשל");
      setPhase("review");
    }
  }
  if (!enabled) return null;
  return /* @__PURE__ */ jsxs("div", { className: "fixed inset-x-0 z-30 px-3 bottom-[calc(env(safe-area-inset-bottom)+4.6rem)] md:bottom-4", children: [
    (phase === "review" || phase === "applying") && result && /* @__PURE__ */ jsx(
      "div",
      {
        "aria-hidden": "true",
        onClick: phase === "applying" ? void 0 : reset,
        className: "sp-fade fixed inset-0 -z-10 bg-[color:var(--overlay)] backdrop-blur-sm"
      }
    ),
    /* @__PURE__ */ jsxs("div", { className: "mx-auto flex max-w-2xl flex-col gap-2", children: [
      (phase === "review" || phase === "applying") && result && /* @__PURE__ */ jsx("div", { className: "sp-sheet relative z-10 max-h-[60dvh] overflow-y-auto rounded-3xl border border-[color:var(--line)] bg-[color:var(--sheet)] p-4 shadow-[0_-8px_40px_rgba(0,0,0,.45)]", children: /* @__PURE__ */ jsx(TradeConfirm, { result, mode: result.mode, busy: phase === "applying", error, onConfirm: confirm, onCancel: reset }) }),
      flash && /* @__PURE__ */ jsxs("div", { className: "sp-pop self-center rounded-full px-4 py-2 text-sm font-semibold shadow-lg", style: { background: "var(--up)", color: "#fff" }, children: [
        "✓ ",
        flash
      ] }),
      error && phase === "idle" && /* @__PURE__ */ jsx("div", { className: "self-center rounded-full px-4 py-2 text-sm shadow-lg", style: { background: "var(--down-bg)", color: "var(--down)" }, children: error }),
      /* @__PURE__ */ jsxs(
        "form",
        {
          onSubmit: submit,
          className: "flex items-center gap-2 rounded-2xl border bg-[color:var(--nav)] p-1.5 shadow-xl backdrop-blur-xl",
          style: { borderColor: isDemo ? "var(--warn-line)" : "var(--line-2)" },
          children: [
            /* @__PURE__ */ jsx(
              "span",
              {
                className: "flex-none rounded-xl px-2 py-1 text-[11px] font-bold",
                style: isDemo ? { background: "var(--warn-bg)", color: "var(--warn)" } : { background: "var(--accent-bg)", color: "var(--accent)" },
                children: isDemo ? "דמו" : "AI"
              }
            ),
            /* @__PURE__ */ jsx(
              "input",
              {
                value: text,
                onChange: (e) => setText(e.target.value),
                dir: "rtl",
                enterKeyHint: "send",
                "aria-label": isDemo ? "עדכון עסקה בדמו בטקסט חופשי" : "עדכון עסקה בתיק האמיתי בטקסט חופשי",
                placeholder: isDemo ? "מה עשית בדמו?" : "מה עשית היום? (קניתי 3 NVDA)",
                className: "min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-[color:var(--fg-3)]"
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "submit",
                disabled: !text.trim() || phase === "parsing",
                "aria-label": "שליחה",
                className: "grid h-11 w-11 flex-none place-items-center rounded-xl disabled:opacity-40",
                style: { background: isDemo ? "var(--warn)" : "var(--accent)", color: isDemo ? "#000" : "#fff" },
                children: phase === "parsing" ? /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: true, className: "h-4 w-4" }) : /* @__PURE__ */ jsx(Icon, { name: "send", className: "h-5 w-5" })
              }
            )
          ]
        }
      )
    ] })
  ] });
}
function demoTradeFor(action, position, price, demoStats) {
  if (!(price > 0)) return null;
  if (action === "ADD" || action === "BUY") {
    const cash = demoStats?.cash || 0;
    const budget = Math.min(cash, (demoStats?.total || 0) * 0.05);
    const shares = Math.floor(budget / price * 1e4) / 1e4;
    return shares > 0 ? { type: "BUY", ticker: position?.ticker, shares, price, note: "5% מהתיק" } : { error: "אין מספיק מזומן בדמו" };
  }
  if (!position || !(position.shares > 0)) return null;
  if (action === "TRIM") return { type: "SELL_PARTIAL", ticker: position.ticker, shares: Math.round(position.shares / 3 * 1e4) / 1e4, price, note: "שליש מהפוזיציה" };
  if (action === "TAKE_PROFIT" || action === "CUT_LOSS") return { type: "SELL_ALL", ticker: position.ticker, shares: position.shares, price };
  return null;
}
function AnalystPanel({ ticker, mode, position, demoStats, onDemoApplied }) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const [openId, setOpenId] = useState("synthesis");
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(async (refresh) => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      setState({ loading: false, error: "", data: await demoApi.analysts(ticker, mode, refresh) });
    } catch (e) {
      setState({ loading: false, error: e.code === "gemini_no_key" ? "חסר מפתח Gemini בהגדרות." : e.message || "הניתוח נכשל", data: null });
    }
  }, [ticker, mode]);
  useEffect(() => {
    load(false);
  }, [load]);
  const price = state.data?.indicators?.price ?? position?.currentPrice;
  async function execute() {
    setBusy(true);
    setMsg("");
    try {
      const r = await demoApi.apply([pending.trade], "demo", `אנליסט: ${pending.name}`);
      onDemoApplied(r);
      setPending(null);
      setMsg("בוצע בדמו ✓");
      setTimeout(() => setMsg(""), 3e3);
    } catch (e) {
      setMsg(e.message || "הביצוע נכשל");
    } finally {
      setBusy(false);
    }
  }
  const ind = state.data?.indicators;
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-4", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsxs("h3", { className: "flex items-center gap-2 text-sm font-bold", children: [
        /* @__PURE__ */ jsx(Icon, { name: "brain", className: "h-4 w-4 text-[color:var(--accent)]" }),
        "פאנל אנליסטים"
      ] }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: () => load(true),
          disabled: state.loading,
          "aria-label": "ניתוח מחדש",
          className: "ms-auto grid h-8 w-8 place-items-center rounded-lg text-[color:var(--fg-3)] hover:bg-[color:var(--tint)] disabled:opacity-40",
          children: /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: state.loading, className: "h-4 w-4" })
        }
      )
    ] }),
    ind && /* @__PURE__ */ jsx("div", { dir: "ltr", className: "flex flex-wrap justify-end gap-1.5 text-[11px]", children: [["RSI", ind.rsi14], ["MACD", ind.macd?.hist], ["SMA20", ind.sma20], ["SMA50", ind.sma50], ["1M", ind.chg1m != null ? `${ind.chg1m}%` : null]].filter(([, v]) => v != null).map(([k, v]) => /* @__PURE__ */ jsxs("span", { className: "sp-num rounded-md bg-[color:var(--inset)] px-2 py-0.5 text-[color:var(--fg-2)]", children: [
      k,
      " ",
      /* @__PURE__ */ jsx("b", { className: "text-[color:var(--fg)]", children: v })
    ] }, k)) }),
    state.loading && !state.data && /* @__PURE__ */ jsx("ul", { className: "flex flex-col gap-2", "aria-busy": "true", children: [0, 1, 2, 3].map((i) => /* @__PURE__ */ jsx("li", { className: "h-14 animate-pulse rounded-2xl bg-[color:var(--inset)]" }, i)) }),
    state.error && /* @__PURE__ */ jsx("p", { className: "text-sm text-[color:var(--down)]", children: state.error }),
    state.data && /* @__PURE__ */ jsx("ul", { className: "sp-stagger flex flex-col gap-2", children: state.data.analysts.map((a) => {
      const open = openId === a.id;
      const trade = mode === "demo" ? demoTradeFor(a.action, position || { ticker }, price, demoStats) : null;
      const tradeOk = trade && !trade.error;
      return /* @__PURE__ */ jsxs("li", { className: "overflow-hidden rounded-2xl border border-[color:var(--line)] bg-[color:var(--inset)]", children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            onClick: () => setOpenId(open ? null : a.id),
            "aria-expanded": open,
            className: "sp-press-soft flex w-full items-center gap-2 px-3 py-3 text-right",
            children: [
              /* @__PURE__ */ jsx("span", { className: "min-w-0 flex-1 text-sm font-semibold leading-snug", children: a.name }),
              /* @__PURE__ */ jsx(ActionBadge, { action: a.action, showDetail: true }),
              /* @__PURE__ */ jsx("span", { className: `text-[color:var(--fg-3)] transition-transform duration-300 ${open ? "rotate-180" : ""}`, children: /* @__PURE__ */ jsx(Icon, { name: "chevron", className: "h-4 w-4" }) })
            ]
          }
        ),
        /* @__PURE__ */ jsx("div", { className: "sp-acc", "data-open": open, children: /* @__PURE__ */ jsx("div", { inert: open ? void 0 : "", children: /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 px-3 pb-3", children: [
          /* @__PURE__ */ jsx("p", { dir: "rtl", className: "text-sm leading-relaxed text-[color:var(--fg-2)]", children: a.summary }),
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2 text-xs", children: [
            a.stop != null && /* @__PURE__ */ jsxs("span", { className: "rounded-lg px-2 py-1", style: { background: "var(--down-bg)" }, children: [
              "סטופ ",
              /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num", style: { color: "var(--down)" }, children: fmt(a.stop) })
            ] }),
            a.target != null && /* @__PURE__ */ jsxs("span", { className: "rounded-lg px-2 py-1", style: { background: "var(--up-bg)" }, children: [
              "יעד ",
              /* @__PURE__ */ jsx("b", { dir: "ltr", className: "sp-num", style: { color: "var(--up)" }, children: fmt(a.target) })
            ] }),
            /* @__PURE__ */ jsxs("span", { className: "rounded-lg bg-[color:var(--tint)] px-2 py-1 text-[color:var(--fg-3)]", children: [
              "ביטחון ",
              { low: "נמוך", medium: "בינוני", high: "גבוה" }[a.confidence]
            ] })
          ] }),
          mode === "demo" && a.action !== "HOLD" && (pending?.id === a.id ? /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 rounded-xl p-3", style: { background: "var(--warn-bg)" }, children: [
            /* @__PURE__ */ jsx("b", { className: "text-sm", children: tradeQuestion(pending.trade) }),
            pending.trade.note && /* @__PURE__ */ jsxs("span", { className: "text-xs text-[color:var(--fg-3)]", children: [
              pending.trade.note,
              " · סכום ",
              money(pending.trade.shares * pending.trade.price, "USD", 2)
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
              /* @__PURE__ */ jsx("button", { type: "button", onClick: execute, disabled: busy, className: "min-h-9 rounded-lg px-3 text-sm font-semibold text-black disabled:opacity-40", style: { background: "var(--warn)" }, children: busy ? "מבצע…" : "לבצע בדמו" }),
              /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setPending(null), className: "min-h-9 rounded-lg border border-[color:var(--line-2)] px-3 text-sm", children: "ביטול" })
            ] })
          ] }) : /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              disabled: !tradeOk,
              onClick: () => setPending({ id: a.id, name: a.name, trade }),
              className: "self-start rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-40",
              style: { borderColor: "var(--warn-line)", color: "var(--warn)" },
              children: trade?.error || "בצע המלצה זו בדמו"
            }
          ))
        ] }) }) })
      ] }, a.id);
    }) }),
    msg && /* @__PURE__ */ jsx("p", { className: "text-sm font-semibold", style: { color: "var(--up)" }, children: msg }),
    state.data && /* @__PURE__ */ jsxs("p", { className: "text-[11px] text-[color:var(--fg-4)]", children: [
      state.data.model,
      " · ",
      state.data.liveData ? "עם חיפוש עדכני" : "בלי חדשות חיות",
      " · ",
      timeFmt(state.data.at)
    ] })
  ] });
}
var TABS = [
  { id: "dashboard", label: "לוח בקרה", icon: "dash" },
  { id: "table", label: "טבלת תיק", icon: "table" },
  { id: "settings", label: "הגדרות סוכנים", icon: "sliders" },
  { id: "alerts", label: "התראות", icon: "bell" }
];
var SETUP_STEPS = [
  "פותחים Google Sheets חדש, ואז: הרחבות ← Apps Script.",
  "מדביקים את כל הקוד מהקובץ Code.gs (בקישור למטה) ושומרים.",
  "מריצים פעם אחת את הפונקציה setup ומאשרים הרשאות.",
  "פריסה ← פריסה חדשה ← אפליקציית אינטרנט. להפעיל בתור: אני. גישה: כולם.",
  "מעתיקים לכאן את כתובת ה-Web App, ואת קוד הגישה מ: הגדרות הפרויקט ← מאפייני סקריפט ← APP_TOKEN.",
  "את מפתח Gemini (חינם) מוסיפים אחר כך במסך ההגדרות."
];
var CODE_GS_URL = "https://raw.githubusercontent.com/JudaZinger/-/main/swingpulse/Code.gs";
function LoginScreen({ onDone, theme, onToggleTheme }) {
  const [step, setStep] = useState(REMOTE && getToken() && !SB ? "live" : "choose");
  const [url, setUrl] = useState(REMOTE_API);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(CLOUD_ERROR || "");
  const [gBusy, setGBusy] = useState(false);
  async function google2() {
    setGBusy(true);
    setErr("");
    try {
      await startGoogleLogin();
    } catch {
      setGBusy(false);
      setErr("לא הצלחתי לפתוח את ההתחברות עם Google");
    }
  }
  async function submit(e) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setErr("");
    try {
      const h = await login(pw, url);
      onDone(h);
    } catch (x) {
      setErr(x.message || "ההתחברות נכשלה");
    } finally {
      setBusy(false);
    }
  }
  const field = "min-h-11 rounded-xl border border-[color:var(--line-2)] bg-[color:var(--input)] px-3 text-base outline-none focus:border-[#0a84ff]";
  const card = "sp-press flex w-full items-start gap-3 rounded-2xl border p-4 text-right transition-colors hover:bg-[color:var(--tint)]";
  return /* @__PURE__ */ jsxs(
    "div",
    {
      dir: "rtl",
      lang: "he",
      className: "relative grid min-h-screen place-items-center bg-[color:var(--bg)] px-4 py-10 text-[color:var(--fg)] antialiased",
      style: { fontFamily: "Heebo, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" },
      children: [
        /* @__PURE__ */ jsx("div", { className: "absolute left-4 top-4", children: /* @__PURE__ */ jsx(ThemeToggle, { theme, onToggle: onToggleTheme }) }),
        /* @__PURE__ */ jsxs("div", { className: "sp-sheet flex w-full max-w-md flex-col gap-5 rounded-3xl border border-[color:var(--line)] bg-[color:var(--card)] p-6", children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
            /* @__PURE__ */ jsx("div", { className: "grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[#30d158] to-[#0a84ff] text-black", children: /* @__PURE__ */ jsx(Icon, { name: "pulse" }) }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("b", { dir: "ltr", className: "text-lg", children: "SwingPulse" }),
              /* @__PURE__ */ jsx("div", { className: "text-xs text-[color:var(--fg-3)]", children: "פולס מסחר · ניהול תיק סווינג בעברית" })
            ] })
          ] }),
          !REMOTE ? /* @__PURE__ */ jsxs("form", { onSubmit: submit, className: "flex flex-col gap-3", children: [
            /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1.5 text-sm", children: [
              "סיסמה",
              /* @__PURE__ */ jsx("input", { type: "password", autoComplete: "current-password", autoFocus: true, value: pw, onChange: (e) => setPw(e.target.value), dir: "ltr", className: field })
            ] }),
            err && /* @__PURE__ */ jsx("div", { className: "text-sm text-[color:var(--down)]", children: err }),
            /* @__PURE__ */ jsx("button", { type: "submit", disabled: busy || !pw, className: "min-h-11 rounded-xl bg-[#0a84ff] font-semibold text-white disabled:opacity-40", children: busy ? "מתחבר…" : "כניסה" })
          ] }) : step === "choose" ? /* @__PURE__ */ jsxs("div", { className: "sp-stagger flex flex-col gap-3", children: [
            SB && /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  onClick: google2,
                  disabled: gBusy,
                  className: "sp-press flex min-h-12 w-full items-center justify-center gap-3 rounded-2xl bg-white px-4 text-base font-semibold text-[#1f1f1f] shadow-sm ring-1 ring-black/10 disabled:opacity-60",
                  children: [
                    /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 48 48", className: "h-5 w-5", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx("path", { fill: "#EA4335", d: "M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" }),
                      /* @__PURE__ */ jsx("path", { fill: "#4285F4", d: "M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 2.9-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.5z" }),
                      /* @__PURE__ */ jsx("path", { fill: "#FBBC05", d: "M10.6 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.1z" }),
                      /* @__PURE__ */ jsx("path", { fill: "#34A853", d: "M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" })
                    ] }),
                    gBusy ? "פותח את Google…" : "התחברות עם Google"
                  ]
                }
              ),
              /* @__PURE__ */ jsx("p", { className: "-mt-1 text-center text-xs text-[color:var(--fg-3)]", children: "בלי הגדרות. תיק פרטי, ניתוח AI והתראות. המידע נשמר בשרת של SwingPulse." }),
              err && /* @__PURE__ */ jsx("div", { className: "text-center text-sm text-[color:var(--down)]", children: err }),
              /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 text-xs text-[color:var(--fg-4)]", children: [
                /* @__PURE__ */ jsx("span", { className: "h-px flex-1 bg-[color:var(--line)]" }),
                "או",
                /* @__PURE__ */ jsx("span", { className: "h-px flex-1 bg-[color:var(--line)]" })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("button", { type: "button", onClick: enterSandbox, className: card, style: { borderColor: "var(--warn-line)" }, children: [
              /* @__PURE__ */ jsx("span", { className: "mt-0.5 grid h-9 w-9 flex-none place-items-center rounded-xl font-bold", style: { background: "var(--warn-bg)", color: "var(--warn)" }, children: "0" }),
              /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
                /* @__PURE__ */ jsx("b", { className: "block", children: "כניסה למצב דמו" }),
                /* @__PURE__ */ jsx("span", { className: "block text-sm text-[color:var(--fg-3)]", children: "נסה עכשיו, בלי להירשם. תיק לדוגמה שנשמר רק בדפדפן הזה." })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setStep("live"), className: card, style: { borderColor: "var(--accent-line)" }, children: [
              /* @__PURE__ */ jsx("span", { className: "mt-0.5 grid h-9 w-9 flex-none place-items-center rounded-xl", style: { background: "var(--accent-bg)", color: "var(--accent)" }, children: /* @__PURE__ */ jsx(Icon, { name: "link", className: "h-4 w-4" }) }),
              /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
                /* @__PURE__ */ jsx("b", { className: "block", children: SB ? "שרת משלך (מתקדם)" : "הגדר חשבון אישי (Live)" }),
                /* @__PURE__ */ jsx("span", { className: "block text-sm text-[color:var(--fg-3)]", children: "השרת והגיליון שלך ב-Google, בחינם. רק לך יש גישה." })
              ] })
            ] })
          ] }) : /* @__PURE__ */ jsxs("form", { onSubmit: submit, className: "flex flex-col gap-3", children: [
            /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1.5 text-sm", children: [
              "כתובת השרת (Web App)",
              /* @__PURE__ */ jsx("input", { type: "text", inputMode: "url", autoComplete: "url", spellCheck: false, value: url, onChange: (e) => setUrl(e.target.value), dir: "ltr", placeholder: "https://script.google.com/macros/s/…/exec", className: `${field} text-sm` })
            ] }),
            /* @__PURE__ */ jsxs("label", { className: "flex flex-col gap-1.5 text-sm", children: [
              "קוד גישה",
              /* @__PURE__ */ jsx("input", { type: "password", autoComplete: "current-password", autoFocus: true, value: pw, onChange: (e) => setPw(e.target.value), dir: "ltr", className: field })
            ] }),
            err && /* @__PURE__ */ jsx("div", { className: "text-sm text-[color:var(--down)]", children: err }),
            /* @__PURE__ */ jsx("button", { type: "submit", disabled: busy || !pw || !url, className: "min-h-11 rounded-xl bg-[#0a84ff] font-semibold text-white disabled:opacity-40", children: busy ? "מתחבר…" : "התחברות" }),
            /* @__PURE__ */ jsxs("details", { className: "rounded-xl border border-[color:var(--line)] p-3 text-sm", children: [
              /* @__PURE__ */ jsx("summary", { className: "cursor-pointer font-semibold", children: "איך מקימים שרת משלך (5 דקות, חינם)" }),
              /* @__PURE__ */ jsx("ol", { className: "mt-2 flex list-decimal flex-col gap-1.5 ps-5 text-[color:var(--fg-2)]", children: SETUP_STEPS.map((t) => /* @__PURE__ */ jsx("li", { children: t }, t)) }),
              /* @__PURE__ */ jsxs("a", { href: safeUrl(CODE_GS_URL), target: "_blank", rel: "noreferrer", className: "mt-2 inline-flex items-center gap-1.5 text-[color:var(--accent)] hover:underline", children: [
                /* @__PURE__ */ jsx(Icon, { name: "link", className: "h-3.5 w-3.5" }),
                "הקוד: Code.gs"
              ] })
            ] }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
              setStep("choose");
              setErr("");
            }, className: "text-sm text-[color:var(--fg-3)] hover:underline", children: "חזרה" })
          ] })
        ] })
      ]
    }
  );
}
var ErrorBoundary = class extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    try {
      console.error("SwingPulse crashed", err);
    } catch {
    }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return /* @__PURE__ */ jsxs("div", { dir: "rtl", className: "flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-[#0A0D12] p-6 text-center text-[#F3F4F6]", children: [
      /* @__PURE__ */ jsx("div", { className: "text-lg font-semibold", children: "משהו השתבש בתצוגה" }),
      /* @__PURE__ */ jsx("div", { className: "max-w-xs text-sm text-[#9CA3AF]", children: "הנתונים שלך שמורים בשרת. טעינה מחדש בדרך כלל פותרת את זה." }),
      /* @__PURE__ */ jsx("button", { type: "button", onClick: () => window.location.reload(), className: "min-h-11 rounded-xl bg-[#0A84FF] px-5 font-semibold text-white", children: "טעינה מחדש" })
    ] });
  }
};
function SwingPulse() {
  return /* @__PURE__ */ jsx(ErrorBoundary, { children: /* @__PURE__ */ jsx(SwingPulseApp, {}) });
}
function SwingPulseApp() {
  const [data, setData] = useState(() => loadJSON(LS_DATA, { portfolio: null, digest: null }));
  const [digestState, setDigestState] = useState({ busy: false, error: "" });
  const [health, setHealth] = useState(null);
  const [serverOk, setServerOk] = useState(true);
  const [serverChecked, setServerChecked] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [full, setFull] = useState(false);
  const [settings, setSettings] = useState(() => {
    const s = loadJSON(LS_SETTINGS, {});
    return { ...DEFAULT_SETTINGS, ...s, alertTypes: { ...DEFAULT_SETTINGS.alertTypes, ...s.alertTypes || {} } };
  });
  const [alerts, setAlerts] = useState(() => loadJSON(LS_ALERTS, []));
  const [nextRun, setNextRun] = useState(null);
  const [sort, setSort] = useState({ key: "value", dir: "desc" });
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState({ busy: false, error: "", failed: [] });
  const [openTicker, setOpenTicker] = useState(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [synced, setSynced] = useState(false);
  const [authNonce, setAuthNonce] = useState(0);
  const [healthNonce, setHealthNonce] = useState(0);
  const [theme, toggleTheme] = useThemeState();
  const [mode, setModeRaw] = useState(() => {
    try {
      return localStorage.getItem(LS_MODE) === "demo" ? "demo" : "live";
    } catch {
      return "live";
    }
  });
  const setMode = useCallback((m) => {
    setModeRaw(m);
    try {
      localStorage.setItem(LS_MODE, m);
    } catch {
    }
  }, []);
  const [demo, setDemo] = useState(null);
  const [demoState, setDemoState] = useState({ busy: false, error: "" });
  const demoRef = useRef(null);
  demoRef.current = demo;
  const syncedRef = useRef(false);
  const serverSettingsJSON = useRef("");
  const abortRef = useRef(null);
  const lastOk = useRef(false);
  const [updateReady, setUpdateReady] = useState(false);
  const dataRef = useRef(data);
  const settingsRef = useRef(settings);
  dataRef.current = data;
  settingsRef.current = settings;
  const { portfolio, digest } = data;
  const isDemo = REMOTE && (SANDBOX || mode === "demo");
  const viewPf = isDemo ? demo?.portfolio || null : portfolio;
  const viewDigest = isDemo ? demo?.digest || null : digest;
  useEffect(() => {
    if (REMOTE && typeof navigator !== "undefined" && "serviceWorker" in navigator && signedIn() && !needLogin) swReady().catch(() => {
    });
  }, [needLogin]);
  useEffect(() => {
    saveJSON(LS_DATA, data);
  }, [data]);
  useEffect(() => {
    saveJSON(LS_SETTINGS, settings);
  }, [settings]);
  useEffect(() => {
    saveJSON(LS_ALERTS, alerts);
  }, [alerts]);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const h = await fetchHealth();
      if (!alive) return;
      setHealth(h);
      setServerOk(!!h);
      setServerChecked(true);
      setNeedLogin(!!(h && h.auth && !h.authed));
      lastOk.current = !!h;
    };
    let timer = null;
    const loop = async () => {
      await check();
      if (alive) timer = setTimeout(loop, lastOk.current ? 60 * 1e3 : 10 * 1e3);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [healthNonce]);
  useEffect(() => {
    if (API_BASE !== "" && !REMOTE || typeof window === "undefined") return void 0;
    const files = ["SwingPulse.js", "index.html"].map((f) => new URL(f, window.location.href).href);
    const stamp = (r) => r.headers.get("etag") || r.headers.get("last-modified") || "";
    let baseline = null, timer = null, alive = true;
    const check = async () => {
      try {
        const now2 = (await Promise.all(files.map((u) => fetch(u, { method: "HEAD", cache: "no-store" }).then(stamp)))).join("|");
        if (baseline == null) baseline = now2;
        else if (now2 && now2 !== baseline && alive) {
          setUpdateReady(true);
          return;
        }
      } catch {
      }
      if (alive) timer = setTimeout(check, 30 * 1e3);
    };
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const applyServerState = useCallback((st) => {
    serverSettingsJSON.current = JSON.stringify(st.settings || {});
    setData((cur) => ({ ...cur, portfolio: st.portfolio ?? null, digest: st.digest ?? null, orders: st.orders || [] }));
    if (st.settings) setSettings((s) => ({ ...s, ...st.settings, alertTypes: { ...s.alertTypes, ...st.settings.alertTypes || {} } }));
    if (Array.isArray(st.alerts)) setAlerts(st.alerts);
  }, []);
  useEffect(() => {
    if (!serverOk || needLogin || !health?.storage) return void 0;
    let alive = true, timer = null;
    (async () => {
      try {
        let st = await fetchState();
        const local = dataRef.current;
        const owner = isCloud() ? `cloud:${cloudSession()?.email || ""}` : `gas:${REMOTE_API}`;
        const mine = !lsGet(LS_OWNER) || lsGet(LS_OWNER) === owner;
        if (!mine) clearLocalCopy();
        if (!st.portfolio && local.portfolio && mine && !local.portfolio.sample && !lsGet(LS_OWNER) && !SANDBOX) {
          st = await putState({ portfolio: local.portfolio, digest: local.digest, settings: settingsRef.current, alerts: loadJSON(LS_ALERTS, []) });
        }
        try {
          if (!SANDBOX) localStorage.setItem(LS_OWNER, owner);
        } catch {
        }
        if (!alive) return;
        applyServerState(st);
        syncedRef.current = true;
        setSynced(true);
        let seen = st.updatedAt;
        const poll = async () => {
          try {
            const next = await fetchState();
            if (alive && next.updatedAt && next.updatedAt !== seen) {
              seen = next.updatedAt;
              applyServerState(next);
            }
          } catch (e) {
            if (e.status === 401) setNeedLogin(true);
          }
          if (alive) timer = setTimeout(poll, 60 * 1e3);
        };
        timer = setTimeout(poll, 60 * 1e3);
      } catch (e) {
        if (e.status === 401) setNeedLogin(true);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [serverOk, needLogin, health?.storage, authNonce, applyServerState]);
  useEffect(() => {
    if (!isDemo || !synced) return void 0;
    let alive = true;
    demoApi.get().then((d) => {
      if (alive) setDemo(d);
    }).catch((e) => {
      if (alive) setDemoState((s) => ({ ...s, error: e.message }));
    });
    return () => {
      alive = false;
    };
  }, [isDemo, synced]);
  async function startDemo() {
    if (demoRef.current?.zero && typeof window !== "undefined" && !window.confirm("לאפס את הדמו? כל הפעולות בדמו יימחקו, והתיק הקיים יועתק מחדש כנקודת התחלה.")) return;
    setDemoState({ busy: true, error: "" });
    try {
      setDemo(await demoApi.reset());
      setDemoState({ busy: false, error: "" });
    } catch (e) {
      setDemoState({ busy: false, error: e.message || "ההעתקה נכשלה" });
    }
  }
  const runDemoDigest = useCallback(async () => {
    const pf = demoRef.current?.portfolio;
    if (!pf?.positions?.length) return;
    setDigestState({ busy: true, error: "" });
    try {
      const d = await fetchSwingDigest(pf, { save: false, trigger: "manual" });
      delete d.newAlerts;
      setDemo(await demoApi.put({ digest: d }));
      setDigestState({ busy: false, error: "" });
    } catch (e) {
      setDigestState({ busy: false, error: e.code === "gemini_busy" ? "Gemini עמוס כרגע, נסו שוב בעוד כמה דקות" : `ההמלצות נכשלו: ${e.message}` });
    }
  }, []);
  function onTradeApplied(r) {
    if (!r) return;
    if (r.mode === "demo") {
      if (r.demo) setDemo(r.demo);
      if (r.orders) setDemo((d) => d ? { ...d, orders: r.orders } : d);
      return;
    }
    if (r.mode !== "live") return;
    setData((cur) => ({ ...cur, ...r.portfolio ? { portfolio: r.portfolio } : {}, ...r.orders ? { orders: r.orders } : {} }));
  }
  useEffect(() => {
    if (!synced) return void 0;
    const json = JSON.stringify(settings);
    if (json === serverSettingsJSON.current) return void 0;
    const t = setTimeout(() => {
      serverSettingsJSON.current = json;
      putState({ settings }).catch(() => {
      });
    }, 600);
    return () => clearTimeout(t);
  }, [settings, synced]);
  const tickerKey = (portfolio?.positions || []).map((p) => p.ticker).join(",");
  const refreshLive = useCallback(async () => {
    const pf = dataRef.current.portfolio;
    if (!pf?.positions?.length) return;
    setLive((l) => ({ ...l, busy: true }));
    try {
      const j = await fetchQuotes(pf.positions.map((p) => p.ticker));
      setData((cur) => cur.portfolio ? { ...cur, portfolio: applyLiveQuotes(cur.portfolio, j.quotes || {}, j.at || (/* @__PURE__ */ new Date()).toISOString()) } : cur);
      setLive({ busy: false, error: "", failed: j.failed || [] });
      const d = demoRef.current;
      if (d?.portfolio?.positions?.length) {
        const extra = d.portfolio.positions.map((p) => p.ticker).filter((t) => !(j.quotes || {})[String(t).toUpperCase()]);
        let quotes = j.quotes || {};
        if (extra.length) {
          try {
            quotes = { ...quotes, ...(await fetchQuotes(extra)).quotes || {} };
          } catch {
          }
        }
        setDemo((cur) => cur && cur.portfolio ? { ...cur, portfolio: applyLiveQuotes(cur.portfolio, quotes, j.at || (/* @__PURE__ */ new Date()).toISOString()) } : cur);
      }
    } catch (e) {
      setLive((l) => ({ ...l, busy: false, error: e.code === "http_404" && !REMOTE ? "השרת ישן — הפעילו מחדש את start.bat" : "לא הצלחתי למשוך מחירים חיים" }));
    }
  }, []);
  useEffect(() => {
    if (!tickerKey || !serverOk) return void 0;
    let timer = null, alive = true;
    const loop = async () => {
      await refreshLive();
      if (alive) timer = setTimeout(loop, isUsMarketOpen(/* @__PURE__ */ new Date()) ? 2 * 60 * 1e3 : 15 * 60 * 1e3);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tickerKey, serverOk, refreshLive]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setNextRun(portfolio ? computeNextRun(settings) : null);
  }, [settings.frequency, portfolio]);
  const notify = useCallback((list) => {
    if (!list.length || !settingsRef.current.browserNotifications) return;
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
    list.slice(0, 5).forEach((a) => {
      try {
        new Notification(`SwingPulse · ${a.ticker} · ${ACTIONS[a.action]?.badge || ""}`, { body: a.text, tag: `${a.ticker}-${a.action}` });
      } catch {
      }
    });
  }, []);
  const runDigest = useCallback(async (trigger = "manual", pfOverride = null) => {
    const pf = pfOverride || dataRef.current.portfolio;
    if (!pf?.positions?.length) return;
    if (abortRef.current) abortRef.current.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setDigestState({ busy: true, error: "" });
    try {
      const save = syncedRef.current;
      const d = await fetchSwingDigest(pf, { signal: ctl.signal, save, trigger });
      const prev = pfOverride ? null : dataRef.current.digest;
      const fresh = save ? d.newAlerts || [] : buildAlerts(prev, d, pf, settingsRef.current, trigger);
      delete d.newAlerts;
      setData((cur) => ({ ...cur, digest: d }));
      if (fresh.length) {
        setAlerts((cur) => [...fresh, ...cur].slice(0, MAX_ALERTS));
        notify(fresh);
      }
      setDigestState({ busy: false, error: "" });
    } catch (e) {
      if (e.name === "AbortError") return;
      setDigestState({
        busy: false,
        error: e.code === "gemini_no_key" ? "חסר מפתח Gemini. הזינו אותו בלשונית ההגדרות." : e.code === "gemini_auth" ? GAS || REMOTE ? "Gemini דחה את המפתח. הזינו מפתח תקין בהגדרות." : "Gemini דחה את המפתח — בדקו את .env בשרת" : e.code === "gemini_busy" ? 'Gemini עמוס כרגע — לחצו שוב על "המלצות Gemini" בעוד כמה דקות' : e.code === "unreachable" ? "השרת המקומי לא עונה" : `ההמלצות נכשלו: ${e.message}`
      });
    } finally {
      setNextRun(computeNextRun(settingsRef.current));
    }
  }, [notify]);
  useEffect(() => {
    if (!nextRun || !portfolio || !serverOk || digestState.busy || health?.agent) return;
    if (now < nextRun.getTime()) return;
    const s = settingsRef.current;
    if (s.marketHoursOnly && s.frequency !== "eod" && !isUsMarketOpen(new Date(now))) {
      setNextRun(computeNextRun(s, new Date(now)));
      return;
    }
    runDigest("auto");
  }, [now, nextRun, portfolio, serverOk, digestState.busy, runDigest, health?.agent]);
  function onExtracted(json, { merge = false } = {}) {
    const base = merge && dataRef.current.portfolio ? mergePortfolios(dataRef.current.portfolio, json) : json;
    const pf = { ...base, importedAt: (/* @__PURE__ */ new Date()).toISOString() };
    setData({ portfolio: pf, digest: null });
    setMode("live");
    if (syncedRef.current) putState({ portfolio: pf, digest: null }).catch(() => {
    });
    setTab("dashboard");
    runDigest("import", pf);
    setTimeout(refreshLive, 500);
  }
  const rows = useMemo(() => (viewPf?.positions || []).map(enrichPosition), [viewPf]);
  const realStats = useMemo(() => portfolioStats(portfolio), [portfolio]);
  const demoStats = useMemo(() => isDemo ? portfolioStats(demo?.portfolio) : null, [isDemo, demo]);
  const stats = useMemo(() => {
    const portfolio2 = viewPf;
    if (!portfolio2) return null;
    const equity = rows.reduce((s, p) => s + (p.value || 0), 0);
    const cost = rows.reduce((s, p) => s + (p.cost || 0), 0);
    const cash = portfolio2.cashBalance ?? null;
    const total = portfolio2.totalPortfolioValue ?? equity + (cash || 0);
    return {
      equity,
      cost,
      cash,
      total,
      pnl: equity - cost,
      pnlPct: cost ? (equity / cost - 1) * 100 : null,
      exposure: total ? equity / total : null
    };
  }, [viewPf, rows]);
  const verdictMap = useMemo(() => new Map((viewDigest?.positions || []).map((v) => [v.ticker, v])), [viewDigest]);
  const verdictOf = useCallback((t) => verdictMap.get(t), [verdictMap]);
  const [alertsSeenAt, setAlertsSeenAt] = useState(() => {
    try {
      return localStorage.getItem("swingpulse.alertsSeenAt") || "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (tab !== "alerts") return;
    const t = (/* @__PURE__ */ new Date()).toISOString();
    setAlertsSeenAt(t);
    try {
      localStorage.setItem("swingpulse.alertsSeenAt", t);
    } catch {
    }
  }, [tab, alerts.length]);
  const unseenSells = (alerts || []).filter((a) => a && a.at && (!alertsSeenAt || a.at > alertsSeenAt)).length;
  async function doLogout() {
    try {
      await logout();
    } catch {
    }
    setData({ portfolio: null, digest: null });
    setAlerts([]);
    setDemo(null);
    syncedRef.current = false;
    setSynced(false);
    setNeedLogin(true);
  }
  if (needLogin) {
    return /* @__PURE__ */ jsx(ThemeCtx.Provider, { value: theme, children: /* @__PURE__ */ jsx(LoginScreen, { theme, onToggleTheme: toggleTheme, onDone: (fresh) => {
      setNeedLogin(false);
      setHealth((h) => ({ ...h || {}, ...fresh && fresh.version ? fresh : {}, authed: true }));
      setAuthNonce((n2) => n2 + 1);
    } }) });
  }
  const serverStatus = !serverChecked ? "checking" : serverOk ? "online" : "offline";
  return /* @__PURE__ */ jsx(ThemeCtx.Provider, { value: theme, children: /* @__PURE__ */ jsxs(
    "div",
    {
      dir: "rtl",
      lang: "he",
      className: "min-h-screen bg-[color:var(--bg)] text-[color:var(--fg)] antialiased",
      style: { fontFamily: "Heebo, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" },
      children: [
        /* @__PURE__ */ jsx("header", { className: "sticky top-0 z-20 border-b border-[color:var(--line)] bg-[color:var(--header)] pt-[env(safe-area-inset-top)] backdrop-blur-xl", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:gap-3 sm:px-4", children: [
          /* @__PURE__ */ jsx("div", { className: "grid h-8 w-8 flex-none place-items-center rounded-lg bg-gradient-to-br from-[#30d158] to-[#0a84ff] text-black", children: /* @__PURE__ */ jsx(Icon, { name: "pulse" }) }),
          /* @__PURE__ */ jsx("b", { dir: "ltr", className: "hidden lg:inline", children: "SwingPulse" }),
          REMOTE && synced && /* @__PURE__ */ jsx(ModeSwitcher, { mode: SANDBOX ? "demo" : mode, setMode, demo, onReset: startDemo, resetBusy: demoState.busy, sandbox: SANDBOX }),
          /* @__PURE__ */ jsx("span", { className: "hidden text-sm text-[color:var(--fg-3)] lg:inline", children: "פולס מסחר" }),
          /* @__PURE__ */ jsx(
            Segmented,
            {
              ariaLabel: "ניווט",
              value: tab,
              onChange: setTab,
              className: "ms-2 hidden rounded-xl border border-[color:var(--line)] bg-[color:var(--inset)] p-1 md:flex",
              itemClass: "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm",
              options: TABS,
              render: (t) => /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsx(Icon, { name: t.icon }),
                " ",
                t.label,
                t.id === "alerts" && unseenSells > 0 && /* @__PURE__ */ jsx("span", { className: "rounded-full bg-[#ff453a] px-1.5 text-[10px] font-bold text-white", children: unseenSells })
              ] })
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "ms-auto" }),
          viewPf && !SANDBOX && /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: () => isDemo ? runDemoDigest() : runDigest("manual"),
              disabled: digestState.busy || !serverOk,
              "aria-label": "המלצות Gemini",
              className: "flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-xl border border-[color:var(--line-2)] px-3 py-2 text-sm hover:bg-[color:var(--tint)] disabled:opacity-40",
              children: [
                /* @__PURE__ */ jsx(Icon, { name: "refresh", spin: digestState.busy }),
                /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: "המלצות Gemini" })
              ]
            }
          ),
          !SANDBOX && /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: () => setImportOpen(true),
              "aria-label": "ייבוא מבלינק",
              className: "flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-xl bg-[color:var(--inverse)] px-3 py-2 text-sm font-semibold text-[color:var(--inverse-fg)]",
              children: [
                /* @__PURE__ */ jsx(Icon, { name: "upload" }),
                /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: "ייבוא מבלינק" })
              ]
            }
          ),
          /* @__PURE__ */ jsx(ThemeToggle, { theme, onToggle: toggleTheme }),
          !SANDBOX && /* @__PURE__ */ jsx(
            AccountBadge,
            {
              health,
              status: serverStatus,
              onSwitchCode: doLogout,
              onReconnect: () => {
                setServerChecked(false);
                setHealthNonce((n2) => n2 + 1);
              }
            }
          )
        ] }) }),
        /* @__PURE__ */ jsxs("main", { className: `mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 ${REMOTE && synced ? "pb-48" : "pb-28"}`, children: [
          SANDBOX && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--warn-line)] bg-[color:var(--warn-bg)] p-3 text-sm", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "דמו מקומי." }),
              " תיק לדוגמה עם מחירים קבועים. נשמר רק בדפדפן הזה."
            ] }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: leaveSandbox, className: "ms-auto min-h-10 rounded-xl bg-[#0a84ff] px-4 font-semibold text-white", children: "לחבר חשבון אישי" })
          ] }),
          viewPf && !SANDBOX && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[color:var(--fg-3)]", children: [
            /* @__PURE__ */ jsx("span", { className: `h-1.5 w-1.5 rounded-full ${viewPf.liveAt && !live.error ? "bg-[#30d158]" : "bg-[#ffd60a]"}`, "aria-hidden": "true" }),
            live.error ? /* @__PURE__ */ jsx("span", { className: "text-[color:var(--warn)]", children: live.error }) : viewPf.liveAt ? /* @__PURE__ */ jsxs("span", { children: [
              "מחירים · עודכן ",
              new Date(viewPf.liveAt).toDateString() === (/* @__PURE__ */ new Date()).toDateString() ? new Date(viewPf.liveAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : new Date(viewPf.liveAt).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }),
              " · ",
              viewPf.liveCount,
              "/",
              viewPf.positions.length,
              " מניות"
            ] }) : /* @__PURE__ */ jsx("span", { children: "מחירים מזמן הצילומים" }),
            live.failed.length > 0 && /* @__PURE__ */ jsxs("span", { children: [
              "· ללא מחיר חי: ",
              /* @__PURE__ */ jsx("span", { dir: "ltr", children: live.failed.map((f) => f.ticker).join(", ") })
            ] }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: refreshLive,
                disabled: live.busy,
                className: "rounded-lg border border-[color:var(--line)] px-2 py-0.5 text-[color:var(--fg-2)] hover:bg-[color:var(--tint)] disabled:opacity-40",
                children: live.busy ? "מעדכן…" : "רענן מחירים"
              }
            )
          ] }),
          updateReady && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--accent-line)] bg-[color:var(--accent-bg)] p-4 text-sm", children: [
            /* @__PURE__ */ jsx(Icon, { name: "refresh", className: "h-5 w-5 text-[color:var(--accent)]" }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "גרסה חדשה זמינה." }),
              " התיק וההגדרות נשמרים."
            ] }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => window.location.reload(),
                className: "ms-auto min-h-10 rounded-xl bg-[#0a84ff] px-4 font-semibold text-white",
                children: "רענן עכשיו"
              }
            )
          ] }),
          (GAS || REMOTE) && health && health.authed !== false && !health.keySet && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--warn-line)] bg-[color:var(--warn-bg)] p-4 text-sm", children: [
            /* @__PURE__ */ jsx(Icon, { name: "alert", className: "h-5 w-5 text-[color:var(--warn)]" }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "חסר מפתח Gemini." }),
              " בלי מפתח אין פענוח צילומים והמלצות."
            ] }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setTab("settings"), className: "ms-auto min-h-10 rounded-xl bg-[#ffd60a] px-4 font-semibold text-black", children: "להגדרות" })
          ] }),
          serverChecked && !serverOk && /* @__PURE__ */ jsxs("div", { className: "flex gap-3 rounded-2xl border border-[color:var(--warn-line)] bg-[color:var(--warn-bg)] p-4 text-sm", children: [
            /* @__PURE__ */ jsx(Icon, { name: "alert", className: "mt-0.5 h-5 w-5 text-[color:var(--warn)]" }),
            /* @__PURE__ */ jsx("div", { children: REMOTE || GAS ? /* @__PURE__ */ jsx("span", { children: "אין חיבור לשרת כרגע. בדקו את האינטרנט. הנתונים יתעדכנו כשהחיבור יחזור." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx("b", { children: "השרת המקומי של Gemini לא נגיש מכאן." }),
              " הפעילו את start.bat ופתחו",
              " ",
              /* @__PURE__ */ jsx("span", { dir: "ltr", className: "font-mono", children: "http://localhost:5001/app" }),
              ".",
              /* @__PURE__ */ jsx("span", { className: "text-[color:var(--fg-3)]", children: " עמוד שמתארח ב-claude.ai לא יכול לפנות ל-localhost." })
            ] }) })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "sp-tab flex flex-col gap-6", children: tab === "settings" ? /* @__PURE__ */ jsx(
            SettingsTab,
            {
              onLogout: doLogout,
              onHealth: setHealth,
              settings,
              setSettings,
              nextRun,
              now,
              health,
              serverOk,
              onRunNow: () => runDigest("manual"),
              digestBusy: digestState.busy,
              hasPortfolio: !!portfolio
            }
          ) : tab === "alerts" ? /* @__PURE__ */ jsx(AlertsTab, { alerts, clearAlerts: () => {
            setAlerts([]);
            if (syncedRef.current) putState({ alerts: [] }).catch(() => {
            });
          } }) : isDemo && !demo?.zero ? /* @__PURE__ */ jsx(DemoStart, { onStart: startDemo, busy: demoState.busy || !demo && !demoState.error, error: demoState.error, hasReal: !!portfolio }) : !viewPf ? /* @__PURE__ */ jsxs("section", { className: "flex flex-col items-center gap-4 rounded-3xl border border-[color:var(--line)] bg-[color:var(--card)] px-6 py-16 text-center", children: [
            /* @__PURE__ */ jsx("div", { className: "grid h-14 w-14 place-items-center rounded-2xl bg-[color:var(--accent-bg)] text-[color:var(--accent)]", children: /* @__PURE__ */ jsx(Icon, { name: "upload", className: "h-7 w-7" }) }),
            /* @__PURE__ */ jsx("h1", { className: "text-xl font-bold", children: "עוד אין תיק" }),
            /* @__PURE__ */ jsx("p", { className: "max-w-md text-sm text-[color:var(--fg-3)]", children: "מעלים את כל צילומי המסך מבלינק בבת אחת. Gemini מפענח את התיק ומחזיר המלצות סווינג בעברית." }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setImportOpen(true), className: "rounded-xl bg-[color:var(--inverse)] px-5 py-3 font-semibold text-[color:var(--inverse-fg)]", children: "ייבוא מבלינק" })
          ] }) : tab === "table" ? /* @__PURE__ */ jsx(TableTab, { onOpen: setOpenTicker, portfolio: viewPf, rows, stats, verdictOf, digestState, sort, setSort }) : /* @__PURE__ */ jsxs(Fragment, { children: [
            isDemo && demo?.zero && demoStats && /* @__PURE__ */ jsx(BenchmarkBanner, { demo, demoStats, realStats, cur: viewPf.currency || "USD", onReset: startDemo, resetBusy: demoState.busy }),
            /* @__PURE__ */ jsx(
              DashboardTab,
              {
                onOpen: setOpenTicker,
                portfolio: viewPf,
                rows,
                stats,
                digest: viewDigest,
                digestState,
                verdictOf,
                full,
                setFull,
                onImport: () => setImportOpen(true),
                onRun: () => isDemo ? runDemoDigest() : runDigest("manual"),
                canRun: serverOk,
                isDemo
              }
            )
          ] }) }, tab),
          /* @__PURE__ */ jsxs("p", { className: "text-center text-xs text-[color:var(--fg-4)]", children: [
            viewDigest?.meta ? `${viewDigest.meta.model} · ${viewDigest.meta.liveData ? "עם נתוני חיפוש עדכניים" : "ללא נתוני שוק חיים"} · ` : "",
            "כלי עזר להחלטה, לא ייעוץ השקעות. · ",
            /* @__PURE__ */ jsxs("span", { dir: "ltr", children: [
              "SwingPulse v",
              APP_VERSION,
              " · ",
              APP_ENGINE
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsx("nav", { className: "fixed inset-x-0 bottom-0 z-30 border-t border-[color:var(--line)] bg-[color:var(--nav)] px-2 pb-[max(env(safe-area-inset-bottom),0.4rem)] pt-1.5 backdrop-blur-xl md:hidden", "aria-label": "ניווט", children: /* @__PURE__ */ jsx(
          Segmented,
          {
            ariaLabel: "ניווט",
            value: tab,
            onChange: setTab,
            className: "w-full",
            pillClass: "sp-accent",
            itemClass: "flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10.5px] font-medium",
            activeClass: "text-[color:var(--accent)]",
            idleClass: "text-[color:var(--fg-3)]",
            options: TABS,
            render: (t) => /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsxs("span", { className: "relative", children: [
                /* @__PURE__ */ jsx(Icon, { name: t.icon, className: "h-5 w-5" }),
                t.id === "alerts" && unseenSells > 0 && /* @__PURE__ */ jsx("span", { className: "absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-[#ff453a]" })
              ] }),
              t.label
            ] })
          }
        ) }),
        openTicker && /* @__PURE__ */ jsx(
          StockSheet,
          {
            position: rows.find((r) => r.ticker === openTicker),
            verdict: verdictOf(openTicker),
            currency: viewPf?.currency || "USD",
            onClose: () => setOpenTicker(null),
            mode: isDemo ? "demo" : "live",
            demoStats,
            onDemoApplied: onTradeApplied,
            cash: viewPf?.cashBalance ?? null,
            orders: (isDemo ? demo?.orders : data.orders) || []
          }
        ),
        REMOTE && !SANDBOX && synced && tab !== "settings" && /* @__PURE__ */ jsx(CommandBar, { mode: isDemo ? "demo" : "live", enabled: !isDemo || !!demo?.zero, onApplied: onTradeApplied }),
        /* @__PURE__ */ jsx(ImportModal, { open: importOpen, onClose: () => setImportOpen(false), onExtracted, serverOk, hasPortfolio: !!portfolio, fromDemo: isDemo })
      ]
    }
  ) });
}
export {
  APP_ENGINE,
  APP_VERSION,
  applyLiveQuotes,
  buildAlerts,
  buildPlan,
  cleanNotes,
  SwingPulse as default,
  demoApi,
  enablePush,
  extractPortfolio,
  fetchCandles,
  fetchHealth,
  fetchQuotes,
  fetchState,
  fetchSwingDigest,
  isUsMarketOpen,
  login,
  logout,
  mergePortfolios,
  nextEndOfDay,
  portfolioStats,
  pushState,
  pushSupported,
  putState,
  requireMode,
  saveSecrets,
  testPush,
  testTelegram,
  tvSymbol
};
