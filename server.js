import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const CONFIG = getConfig();
const PORT = CONFIG.port;
const BASE_URL = CONFIG.baseUrl;
const CLIENT_ID = CONFIG.clientId;
const CURRENCY = CONFIG.currency;
const ISSUER = "https://connect.parqet.com";
const AUTHORIZE_URL = `${ISSUER}/oauth2/authorize`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

function resolveUserDataDir() {
  if (CONFIG.appDataDir) return path.resolve(CONFIG.appDataDir);

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Parqet Strategic Liquidity Manager");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Parqet Strategic Liquidity Manager");
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  const base = xdgDataHome || path.join(os.homedir(), ".local", "share");
  return path.join(base, "parqet-strategic-liquidity-manager");
}

const DATA_DIR = resolveUserDataDir();
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TOKEN_FILE = path.join(DATA_DIR, "tokens.json");
const FX_FILE = path.join(DATA_DIR, "fx.json");
const LEGACY_DATA_DIR = path.join(__dirname, ".data");
const ECB_FX_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

const oauthStates = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function pkceChallenge(verifier) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(DATA_DIR, 0o700);
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function readJsonFileOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function isFreshDefaultProfileStore(value) {
  if (!value || value.schemaVersion !== 2 || value.activeProfileId !== "main") return false;
  const ids = Object.keys(value.profiles || {});
  if (ids.length !== 1 || ids[0] !== "main") return false;

  const p = value.profiles.main || {};
  const settings = p.settings || {};
  return (
    (!Array.isArray(p.portfolioIds) || p.portfolioIds.length === 0) &&
    !p.selectedPortfolioId &&
    Object.keys(p.assignments || {}).length === 0 &&
    Array.isArray(p.futures || []) && (p.futures || []).length === 0 &&
    Array.isArray(p.credits || []) && (p.credits || []).length === 0 &&
    Number(settings.firefishBorrowPercent || 0) === 0 &&
    Number(settings.firefishTargetLtv ?? 30) === 30
  );
}

async function copyLegacyFile(source, target, { allowReplaceFreshState = false } = {}) {
  if (!(await fileExists(source))) return "source-missing";

  if (await fileExists(target)) {
    if (!allowReplaceFreshState) return "target-exists";

    const current = await readJsonFileOrNull(target);
    if (!isFreshDefaultProfileStore(current)) return "target-exists";

    // Preserve the accidentally created empty state before replacing it.
    const backup = `${target}.pre-migration-empty`;
    if (!(await fileExists(backup))) {
      await fs.copyFile(target, backup);
      if (process.platform !== "win32") await fs.chmod(backup, 0o600);
    }
  }

  const tmp = `${target}.migrate-${process.pid}.tmp`;
  await fs.copyFile(source, tmp);
  if (process.platform !== "win32") await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, target);
  return "migrated";
}

async function migrateLegacyData() {
  if (path.resolve(DATA_DIR) === path.resolve(LEGACY_DATA_DIR)) return;

  await ensureDataDir();

  const results = {
    state: await copyLegacyFile(
      path.join(LEGACY_DATA_DIR, "state.json"),
      STATE_FILE,
      { allowReplaceFreshState: true }
    ),
    tokens: await copyLegacyFile(
      path.join(LEGACY_DATA_DIR, "tokens.json"),
      TOKEN_FILE
    ),
    fx: await copyLegacyFile(
      path.join(LEGACY_DATA_DIR, "fx.json"),
      FX_FILE
    )
  };

  for (const [name, result] of Object.entries(results)) {
    if (result === "migrated") {
      console.log(`Migrated legacy user data: ${name}.json -> ${DATA_DIR}`);
    } else if (result === "target-exists") {
      console.log(`Migration skipped: ${name}.json already contains user data.`);
    }
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDataDir();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

function defaultProfile(id = "main", name = "Main") {
  return {
    id,
    name,
    portfolioIds: [],
    selectedPortfolioId: null,
    assignments: {},
    futures: [],
    credits: [],
    settings: { firefishBorrowPercent: 0, firefishTargetLtv: 30, monthlyNeed: 0, targetMonths: 0, pot2Multiplier: 2 }
  };
}

function normalizeProfile(profile, id = "main", name = "Main") {
  const base = defaultProfile(id, name);
  const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  return {
    ...base,
    ...source,
    id,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : name,
    portfolioIds: Array.isArray(source.portfolioIds)
      ? [...new Set(source.portfolioIds.filter(id => typeof id === "string" && id.trim()))]
      : (typeof source.selectedPortfolioId === "string" && source.selectedPortfolioId
          ? [source.selectedPortfolioId]
          : []),
    selectedPortfolioId: Array.isArray(source.portfolioIds) && source.portfolioIds.length
      ? source.portfolioIds[0]
      : (typeof source.selectedPortfolioId === "string" ? source.selectedPortfolioId : null),
    assignments: source.assignments && typeof source.assignments === "object" && !Array.isArray(source.assignments)
      ? source.assignments : {},
    futures: Array.isArray(source.futures) ? source.futures : [],
    credits: Array.isArray(source.credits) ? source.credits : [],
    settings: {
      ...(source.settings && typeof source.settings === "object" && !Array.isArray(source.settings) ? source.settings : {}),
      firefishBorrowPercent: Math.min(100, Math.abs(safeNumber(source.settings?.firefishBorrowPercent))),
      firefishTargetLtv: source.settings?.firefishTargetLtv == null
        ? 30
        : Math.min(50, Math.abs(safeNumber(source.settings.firefishTargetLtv))),
      monthlyNeed: Math.max(0, safeNumber(source.settings?.monthlyNeed)),
      targetMonths: Math.max(0, Math.trunc(safeNumber(source.settings?.targetMonths))),
      pot2Multiplier: source.settings?.pot2Multiplier == null
        ? 2
        : Math.min(12, Math.max(1, safeNumber(source.settings.pot2Multiplier)))
    }
  };
}

function isProfileState(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === 2 &&
    typeof value.activeProfileId === "string" &&
    value.profiles &&
    typeof value.profiles === "object" &&
    !Array.isArray(value.profiles)
  );
}

async function getProfileStore() {
  const raw = await readJson(STATE_FILE, null);

  if (isProfileState(raw)) {
    const ids = Object.keys(raw.profiles);
    const activeProfileId = raw.profiles[raw.activeProfileId]
      ? raw.activeProfileId
      : (ids[0] || "main");
    const profiles = { ...raw.profiles };
    if (!profiles[activeProfileId]) profiles[activeProfileId] = defaultProfile(activeProfileId, "Main");
    profiles[activeProfileId] = normalizeProfile(
      profiles[activeProfileId],
      activeProfileId,
      profiles[activeProfileId]?.name || "Main"
    );
    return {
      schemaVersion: 2,
      setupCompleted: raw.setupCompleted !== false,
      activeProfileId,
      profiles
    };
  }

  // MS5.1 migration: the complete legacy v0.7 single-profile state becomes "main".
  // Tokens and FX cache live in separate files and are intentionally untouched.
  const isFirstRun = raw == null;
  const migrated = {
    schemaVersion: 2,
    setupCompleted: !isFirstRun,
    activeProfileId: "main",
    profiles: {
      main: normalizeProfile(raw || {}, "main", isFirstRun ? "Default" : "Main")
    }
  };
  await writeJsonAtomic(STATE_FILE, migrated);
  return migrated;
}

async function getState() {
  const store = await getProfileStore();
  return store.profiles[store.activeProfileId];
}

async function saveState(state) {
  const store = await getProfileStore();
  const id = store.activeProfileId;
  store.profiles[id] = normalizeProfile(state, id, store.profiles[id]?.name || "Main");
  await writeJsonAtomic(STATE_FILE, store);
}

async function getTokens() {
  return readJson(TOKEN_FILE, null);
}

async function saveTokens(tokens) {
  await writeJsonAtomic(TOKEN_FILE, {
    ...tokens,
    saved_at: Date.now()
  });
}

async function clearTokens() {
  try { await fs.unlink(TOKEN_FILE); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

async function tokenRequest(params) {
  const body = new URLSearchParams(params);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`OAuth token error ${res.status}: ${data.error_description || data.error || "unknown error"}`);
    err.status = res.status;
    err.code = "OAUTH_TOKEN_ERROR";
    throw err;
  }
  return data;
}

async function refreshTokens(tokens) {
  if (!tokens?.refresh_token) {
    await clearTokens();
    const err = new Error("Parqet-Verbindung ist nicht mehr gültig. Bitte neu verbinden.");
    err.status = 401;
    err.code = "PARQET_RECONNECT_REQUIRED";
    throw err;
  }

  try {
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID
    });
    const merged = {
      ...tokens,
      ...fresh,
      refresh_token: fresh.refresh_token || tokens.refresh_token
    };
    await saveTokens(merged);
    return merged;
  } catch (err) {
    // A revoked/expired refresh token is no longer useful. Remove only the local
    // OAuth credentials; profiles, assignments, futures and credits stay intact.
    if (err?.code === "OAUTH_TOKEN_ERROR" && [400, 401].includes(Number(err.status))) {
      await clearTokens();
      const reconnect = new Error("Parqet-Verbindung ist nicht mehr gültig. Bitte neu verbinden.");
      reconnect.status = 401;
      reconnect.code = "PARQET_RECONNECT_REQUIRED";
      throw reconnect;
    }
    throw err;
  }
}

async function parqetFetch(urlPath, options = {}, allowRefresh = true) {
  let tokens = await getTokens();
  if (!tokens?.access_token) {
    const err = new Error("NOT_CONNECTED");
    err.status = 401;
    throw err;
  }

  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${tokens.access_token}`);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  let res = await fetch(`${ISSUER}${urlPath}`, { ...options, headers });

  if (res.status === 401 && allowRefresh && tokens.refresh_token) {
    tokens = await refreshTokens(tokens);
    headers.set("authorization", `Bearer ${tokens.access_token}`);
    res = await fetch(`${ISSUER}${urlPath}`, { ...options, headers });
  }

  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Parqet API ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function holdingName(h) {
  return h.nickname || h.asset?.name || h.asset?.symbol || h.asset?.identifier || h.asset?.type || h.id;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getEurUsdRate() {
  const cached = await readJson(FX_FILE, null);
  try {
    const response = await fetch(ECB_FX_URL, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`ECB FX ${response.status}`);
    const xml = await response.text();
    const rateMatch = xml.match(/currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/);
    const dateMatch = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/);
    const rate = rateMatch ? Number(rateMatch[1]) : NaN;
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("USD-Kurs in ECB-Antwort nicht gefunden");
    const fx = { eurUsd: rate, date: dateMatch?.[1] || null, source: "ECB", stale: false };
    await writeJsonAtomic(FX_FILE, fx);
    return fx;
  } catch (err) {
    if (cached?.eurUsd) return { ...cached, stale: true, source: cached.source || "ECB" };
    return { eurUsd: null, date: null, source: "ECB", stale: true, unavailable: true };
  }
}

function futureToEur(value, inputCurrency, fx) {
  const amount = safeNumber(value);
  if (inputCurrency === "EUR") return amount;
  if ((inputCurrency === "USD" || inputCurrency === "USDT") && fx?.eurUsd) return amount / fx.eurUsd;
  return null;
}

//function creditAmount(value) {
//  const n = Number(value);
//  return Number.isFinite(n) ? Math.abs(n) : 0;
//}

app.get("/api/status", async (_req, res) => {
  const tokens = await getTokens();
  const store = await getProfileStore();
  const state = store.profiles[store.activeProfileId];
  res.json({
    configured: Boolean(CLIENT_ID),
    connected: Boolean(tokens?.access_token),
    setupCompleted: store.setupCompleted !== false,
    firstRun: store.setupCompleted === false,
    portfolioIds: state.portfolioIds || (state.selectedPortfolioId ? [state.selectedPortfolioId] : []),
    selectedPortfolioId: state.selectedPortfolioId,
    baseUrl: BASE_URL,
    redirectUri: REDIRECT_URI,
    currency: CURRENCY,
    instancePath: __dirname
  });
});

let httpServer = null;
let shutdownInProgress = false;

app.post("/api/app/shutdown", (req, res) => {
  const remote = req.socket?.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLocal) return res.status(403).json({ error: "Shutdown ist nur lokal erlaubt." });
  if (shutdownInProgress) return res.json({ ok: true, shuttingDown: true });

  shutdownInProgress = true;
  res.json({ ok: true, shuttingDown: true });

  // Give the HTTP response time to reach the browser, then stop accepting new
  // connections. The same path works for Linux and the bundled Windows runtime.
  setTimeout(() => {
    if (!httpServer) return process.exit(0);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }, 150).unref();
});

app.get("/auth/parqet", async (_req, res) => {
  if (!CLIENT_ID) return res.status(500).send("PARQET_CLIENT_ID fehlt.");

  const state = randomUrlSafe(24);
  const verifier = randomUrlSafe(48);
  oauthStates.set(state, { verifier, createdAt: Date.now() });

  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "portfolio:read");
  u.searchParams.set("code_challenge", pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);

  res.redirect(u.toString());
});

app.get("/oauth/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`Parqet-Autorisierung abgelehnt: ${req.query.error}`);
    }
    const { code, state } = req.query;
    const pending = oauthStates.get(state);
    if (!code || !state || !pending) return res.status(400).send("Ungültiger OAuth-Callback (state/code).");
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      oauthStates.delete(state);
      return res.status(400).send("OAuth-Anmeldung ist abgelaufen. Bitte erneut verbinden.");
    }

    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pending.verifier
    });
    oauthStates.delete(state);
    await saveTokens(tokens);
    res.redirect("/?connected=1");
  } catch (err) {
    console.error(err);
    res.status(500).send(`OAuth-Fehler: ${err.message}`);
  }
});

app.post("/api/disconnect", async (_req, res) => {
  await clearTokens();
  res.json({ ok: true });
});

app.get("/api/portfolios", async (_req, res, next) => {
  try {
    const data = await parqetFetch("/portfolios");
    res.json(data);
  } catch (err) { next(err); }
});

app.get("/api/portfolio-holdings/:portfolioId", async (req, res, next) => {
  try {
    const perf = await parqetFetch("/performance", {
      method: "POST",
      body: JSON.stringify({
        portfolioIds: [req.params.portfolioId],
        interval: { type: "relative", value: "1d" },
        currency: CURRENCY
      })
    });

    const holdings = (perf.holdings || [])
      .filter(h => !h.position?.isSold)
      .map(h => ({
        id: h.id,
        name: holdingName(h),
        currentValue: safeNumber(h.position?.currentValue),
        currency: h.currency || CURRENCY
      }));

    res.json({ holdings });
  } catch (e) { next(e); }
});

app.post("/api/select-portfolios", async (req, res) => {
  const portfolioIds = Array.isArray(req.body?.portfolioIds)
    ? [...new Set(req.body.portfolioIds.filter(id => typeof id === "string" && id.trim()))]
    : [];
  if (!portfolioIds.length) return res.status(400).json({ error: "Mindestens ein Portfolio muss ausgewählt werden." });
  const state = await getState();
  state.portfolioIds = portfolioIds;
  state.selectedPortfolioId = portfolioIds[0];
  await saveState(state);
  res.json({ ok: true });
});

app.post("/api/setup/complete", async (req, res) => {
  const portfolioIds = Array.isArray(req.body?.portfolioIds)
    ? [...new Set(req.body.portfolioIds.filter(id => typeof id === "string" && id.trim()))]
    : [];
  if (!portfolioIds.length) {
    return res.status(400).json({ error: "Mindestens ein Parqet-Portfolio muss ausgewählt werden." });
  }

  const store = await getProfileStore();
  if (store.setupCompleted !== false) {
    return res.status(409).json({ error: "Die Ersteinrichtung wurde bereits abgeschlossen." });
  }

  const profile = store.profiles[store.activeProfileId];
  if (!profile) return res.status(500).json({ error: "Default-Profil nicht gefunden." });

  profile.name = profile.name || "Default";
  profile.portfolioIds = portfolioIds;
  profile.selectedPortfolioId = portfolioIds[0];
  store.profiles[store.activeProfileId] = normalizeProfile(
    profile,
    store.activeProfileId,
    profile.name || "Default"
  );
  store.setupCompleted = true;

  await writeJsonAtomic(STATE_FILE, store);
  res.json({
    ok: true,
    setupCompleted: true,
    profile: {
      id: store.activeProfileId,
      name: store.profiles[store.activeProfileId].name,
      portfolioIds
    }
  });
});

// Legacy endpoint for older clients.
app.post("/api/select-portfolio", async (req, res) => {
  const { portfolioId } = req.body || {};
  if (!portfolioId || typeof portfolioId !== "string") return res.status(400).json({ error: "portfolioId fehlt" });
  const state = await getState();
  state.portfolioIds = [portfolioId];
  state.selectedPortfolioId = portfolioId;
  await saveState(state);
  res.json({ ok: true });
});

app.get("/api/dashboard", async (_req, res, next) => {
  try {
    const state = await getState();
    const portfolioIds = Array.isArray(state.portfolioIds) && state.portfolioIds.length
      ? state.portfolioIds
      : (state.selectedPortfolioId ? [state.selectedPortfolioId] : []);

    if (!portfolioIds.length) {
      return res.json({
        needsPortfolio: true,
        portfolioIds: [],
        assignments: state.assignments,
        futures: state.futures,
        credits: state.credits
      });
    }

    const tokens = await getTokens();
    if (!tokens?.access_token) {
      const futures = state.futures.map(f => {
        const inputCurrency = ["EUR", "USD", "USDT"].includes(f.currency) ? f.currency : "EUR";
        const leverage = safeNumber(f.leverage) > 0
          ? safeNumber(f.leverage)
          : (safeNumber(f.equity) !== 0 ? Math.abs(safeNumber(f.exposure) / safeNumber(f.equity)) : 1);
        const isEur = inputCurrency === "EUR";
        return {
          ...f,
          currency: inputCurrency,
          leverage,
          equityEur: isEur ? safeNumber(f.equity) : null,
          exposureEur: isEur ? safeNumber(f.exposure) : null,
          pnlEur: isEur ? safeNumber(f.pnl) : null
        };
      });

      const credits = state.credits.map(c => {
        const type = c.type || "revolving";
        const source = c.source || "manual";
        const inputCurrency = ["EUR", "USD", "USDT"].includes(c.currency) ? c.currency : "EUR";
        const amount = Math.abs(safeNumber(c.activeAmount ?? c.used));
        return {
          ...c,
          type,
          source,
          currency: inputCurrency,
          status: c.status || (type === "firefish" ? "ACTIVE" : ""),
          activeAmount: amount,
          activeAmountEur: inputCurrency === "EUR" ? amount : null,
          sourceFound: source !== "parqet",
          sourcePortfolioName: null,
          sourceHoldingName: null,
          limit: safeNumber(c.limit),
          rate: safeNumber(c.rate)
        };
      });

      const futuresEquity = futures.reduce((sum, f) => sum + (f.equityEur ?? 0), 0);
      const futuresExposure = futures.reduce((sum, f) => sum + Math.abs(f.exposureEur ?? 0), 0);
      const futuresPnl = futures.reduce((sum, f) => sum + (f.pnlEur ?? 0), 0);
      const futuresEffectiveLeverage = futuresEquity > 0 ? futuresExposure / futuresEquity : 0;
      const revolvingCredits = credits.filter(c => c.type === "revolving");
      const firefishCredits = credits.filter(c => c.type === "firefish");
      const creditsUsed = revolvingCredits.reduce((sum, c) => sum + (c.activeAmountEur ?? 0), 0);
      const creditsLimit = revolvingCredits.reduce((sum, c) => sum + (c.currency === "EUR" ? c.limit : 0), 0);
      const firefishActive = firefishCredits
        .filter(c => String(c.status || "ACTIVE").toUpperCase() === "ACTIVE")
        .reduce((sum, c) => sum + (c.activeAmountEur ?? 0), 0);
      const firefishPlanned = firefishCredits
        .filter(c => String(c.status || "").toUpperCase() === "PLANNED")
        .reduce((sum, c) => sum + (c.activeAmountEur ?? 0), 0);
      const firefishBorrowPercent = Math.min(100, Math.abs(safeNumber(state.settings?.firefishBorrowPercent)));
      const firefishTargetLtv = state.settings?.firefishTargetLtv == null
        ? 30
        : Math.min(50, Math.abs(safeNumber(state.settings.firefishTargetLtv)));
      const monthlyNeed = Math.max(0, safeNumber(state.settings?.monthlyNeed));
      const targetMonths = Math.max(0, Math.trunc(safeNumber(state.settings?.targetMonths)));
      const pot2Multiplier = state.settings?.pot2Multiplier == null
        ? 2
        : Math.min(12, Math.max(1, safeNumber(state.settings.pot2Multiplier)));
      const pot3Target = monthlyNeed * targetMonths;
      const pot3Current = 0;
      const pot2Target = pot3Target * pot2Multiplier;
      const pot2Current = 0;
      const targetModelConfigured = monthlyNeed > 0 && targetMonths > 0;

      return res.json({
        needsPortfolio: false,
        offline: true,
        currency: CURRENCY,
        parqetUpdatedAt: null,
        portfolioIds,
        selectedPortfolioId: portfolioIds[0] || null,
        holdings: [],
        futures,
        credits,
        settings: { firefishBorrowPercent, firefishTargetLtv, monthlyNeed, targetMonths, pot2Multiplier },
        targetModel: {
          configured: targetModelConfigured,
          monthlyNeed,
          targetMonths,
          pot2Multiplier,
          pot3: {
            current: pot3Current,
            target: pot3Target,
            coverage: pot3Target > 0 ? pot3Current / pot3Target * 100 : 0,
            monthsCovered: monthlyNeed > 0 ? pot3Current / monthlyNeed : 0,
            difference: pot3Current - pot3Target
          },
          pot2: {
            current: pot2Current,
            target: pot2Target,
            coverage: pot2Target > 0 ? pot2Current / pot2Target * 100 : 0,
            difference: pot2Current - pot2Target
          }
        },
        fx: { eurUsd: null, date: null, source: "ECB", stale: true },
        portfolios: [],
        totals: {
          buckets: { "1": futuresEquity, "2": 0, "3": 0 },
          assignedAssets: futuresEquity,
          futuresEquity,
          futuresExposure,
          futuresPnl,
          futuresEffectiveLeverage,
          creditsUsed,
          creditsLimit,
          creditsAvailable: Math.max(0, creditsLimit - creditsUsed),
          firefishActive,
          firefishPlanned,
          bitcoinTotalValue: 0,
          bitcoinTotalAmount: 0,
          bitcoinPositionCount: 0,
          firefishBorrowPercent,
          firefishTargetLtv,
          firefishCollateralBase: 0,
          firefishCollateralBtc: 0,
          firefishCurrentLtv: 0,
          firefishPlannedLtv: 0,
          firefishTotalLimit: 0,
          firefishAvailable: 0,
          firefishAvailableAfterPlanning: 0,
          freeCreditLiquidity: Math.max(0, creditsLimit - creditsUsed)
        }
      });
    }

    const perf = await parqetFetch("/performance", {
      method: "POST",
      body: JSON.stringify({
        portfolioIds,
        interval: { type: "relative", value: "1d" },
        currency: CURRENCY
      })
    });

    const holdings = (perf.holdings || [])
      .filter(h => !h.position?.isSold)
      .map(h => ({
        id: h.id,
        name: holdingName(h),
        type: h.asset?.type || "unknown",
        symbol: h.asset?.symbol || null,
        isin: h.asset?.isin || null,
        currency: h.currency || CURRENCY,
        currentValue: safeNumber(h.position?.currentValue),
        currentPrice: safeNumber(h.position?.currentPrice),
        shares: safeNumber(h.position?.shares),
        logo: h.logo || null,
        bucket: state.assignments[h.id] ?? null
      }));

    const bucketTotals = { "1": 0, "2": 0, "3": 0 };
    for (const h of holdings) {
      if (["1","2","3"].includes(String(h.bucket))) {
        bucketTotals[String(h.bucket)] += h.currentValue;
      }
    }

    const needsUsdFx = state.futures.some(f => ["USD", "USDT"].includes(f.currency))
      || state.credits.some(c => c.type === "firefish" && ["USD", "USDT"].includes(c.currency));
    const fx = needsUsdFx ? await getEurUsdRate() : { eurUsd: null, date: null, source: "ECB", stale: false };
    const futures = state.futures.map(f => {
      const inputCurrency = ["EUR", "USD", "USDT"].includes(f.currency) ? f.currency : "EUR";
      const leverage = safeNumber(f.leverage) > 0
        ? safeNumber(f.leverage)
        : (safeNumber(f.equity) !== 0 ? Math.abs(safeNumber(f.exposure) / safeNumber(f.equity)) : 1);
      return {
        ...f,
        currency: inputCurrency,
        leverage,
        equityEur: futureToEur(f.equity, inputCurrency, fx),
        exposureEur: futureToEur(f.exposure, inputCurrency, fx),
        pnlEur: futureToEur(f.pnl, inputCurrency, fx)
      };
    });
    const futuresEquity = futures.reduce((sum, f) => sum + (f.equityEur ?? 0), 0);
    const futuresExposure = futures.reduce((sum, f) => sum + Math.abs(f.exposureEur ?? 0), 0);
    const futuresPnl = futures.reduce((sum, f) => sum + (f.pnlEur ?? 0), 0);
    const futuresEffectiveLeverage = futuresEquity > 0 ? futuresExposure / futuresEquity : 0;
    bucketTotals["1"] += futuresEquity;

    // Credit records created before v0.3 remain valid as manual revolving credits.
    const portfolioData = await parqetFetch("/portfolios");
    const portfolioNames = new Map((portfolioData.items || []).map(p => [p.id, p.name]));
    const creditSources = new Map();
    for (const c of state.credits.filter(c => c.source === "parqet" && c.portfolioId && c.holdingId)) {
      if (!creditSources.has(c.portfolioId)) {
        const creditPerf = await parqetFetch("/performance", {
          method: "POST",
          body: JSON.stringify({
            portfolioIds: [c.portfolioId],
            interval: { type: "relative", value: "1d" },
            currency: CURRENCY
          })
        });
        creditSources.set(c.portfolioId, creditPerf.holdings || []);
      }
    }

    const credits = state.credits.map(c => {
      const type = c.type || "revolving";
      const source = c.source || "manual";
      const manualAmount = safeNumber(c.activeAmount ?? c.used);
      const sourceHolding = source === "parqet" && c.portfolioId && c.holdingId
        ? (creditSources.get(c.portfolioId) || []).find(h => h.id === c.holdingId && !h.position?.isSold)
        : null;
      const amount = source === "parqet"
        ? (sourceHolding ? Math.abs(safeNumber(sourceHolding.position?.currentValue)) : 0)
        : Math.abs(manualAmount);

      const inputCurrency = ["EUR", "USD", "USDT"].includes(c.currency) ? c.currency : "EUR";
      const amountEur = futureToEur(amount, inputCurrency, fx);

      return {
        ...c,
        type,
        source,
        currency: inputCurrency,
        status: c.status || (type === "firefish" ? "ACTIVE" : ""),
        activeAmount: amount,
        activeAmountEur: amountEur,
        sourceFound: source !== "parqet" || Boolean(sourceHolding),
        sourcePortfolioName: c.portfolioId ? (portfolioNames.get(c.portfolioId) || null) : null,
        sourceHoldingName: sourceHolding ? holdingName(sourceHolding) : null,
        limit: safeNumber(c.limit),
        rate: safeNumber(c.rate)
      };
    });

    const revolvingCredits = credits.filter(c => c.type === "revolving");
    const firefishCredits = credits.filter(c => c.type === "firefish");
    const creditsUsed = revolvingCredits.reduce((sum, c) => sum + c.activeAmount, 0);
    const creditsLimit = revolvingCredits.reduce((sum, c) => sum + c.limit, 0);
    const firefishActive = firefishCredits
      .filter(c => String(c.status || "ACTIVE").toUpperCase() === "ACTIVE")
      .reduce((sum, c) => sum + (c.activeAmountEur ?? 0), 0);
    const firefishPlanned = firefishCredits
      .filter(c => String(c.status || "").toUpperCase() === "PLANNED")
      .reduce((sum, c) => sum + (c.activeAmountEur ?? 0), 0);
    const isBitcoinHolding = h => {
      const name = String(h.name || "").trim().toLowerCase();
      const type = String(h.type || "").trim().toLowerCase();
      const symbol = String(h.symbol || "").trim().toUpperCase();
      return name === "bitcoin"
        || symbol === "BTC"
        || (type.includes("kryptow") && symbol === "BTC")
        || (type.includes("crypto") && symbol === "BTC");
    };
    // /performance is requested in CURRENCY (EUR), therefore currentValue is already
    // the EUR basis used for the borrowing-capacity calculation.
    const bitcoinHoldings = holdings.filter(h =>
      isBitcoinHolding(h) && ["1", "2", "3"].includes(String(h.bucket))
    );
    const bitcoinTotalValue = bitcoinHoldings.reduce((sum, h) => sum + Math.max(0, h.currentValue), 0);
    const bitcoinTotalAmount = bitcoinHoldings.reduce((sum, h) => sum + Math.max(0, safeNumber(h.shares)), 0);
    const firefishBorrowPercent = Math.min(100, Math.abs(safeNumber(state.settings?.firefishBorrowPercent)));
    const firefishTargetLtv = state.settings?.firefishTargetLtv == null
      ? 30
      : Math.min(50, Math.abs(safeNumber(state.settings.firefishTargetLtv)));
    const monthlyNeed = Math.max(0, safeNumber(state.settings?.monthlyNeed));
    const targetMonths = Math.max(0, Math.trunc(safeNumber(state.settings?.targetMonths)));
    const pot2Multiplier = state.settings?.pot2Multiplier == null
      ? 2
      : Math.min(12, Math.max(1, safeNumber(state.settings.pot2Multiplier)));
    const pot3Target = monthlyNeed * targetMonths;
    const pot3Current = bucketTotals["3"];
    const pot2Target = pot3Target * pot2Multiplier;
    const pot2Current = bucketTotals["2"];
    const targetModelConfigured = monthlyNeed > 0 && targetMonths > 0;
    const firefishCollateralBase = bitcoinTotalValue * firefishBorrowPercent / 100;
    const firefishCollateralBtc = bitcoinTotalAmount * firefishBorrowPercent / 100;
    const firefishTotalLimit = firefishCollateralBase * firefishTargetLtv / 100;
    const firefishCurrentLtv = firefishCollateralBase > 0 ? firefishActive / firefishCollateralBase * 100 : 0;
    const firefishPlannedLtv = firefishCollateralBase > 0
      ? (firefishActive + firefishPlanned) / firefishCollateralBase * 100
      : 0;

    const parqetUpdatedAt = new Date().toISOString();

    res.json({
      needsPortfolio: false,
      currency: CURRENCY,
      parqetUpdatedAt,
      portfolioIds,
      selectedPortfolioId: portfolioIds[0] || null,
      holdings,
      futures,
      credits,
      settings: { firefishBorrowPercent, firefishTargetLtv, monthlyNeed, targetMonths, pot2Multiplier },
      targetModel: {
        configured: targetModelConfigured,
        monthlyNeed,
        targetMonths,
        pot2Multiplier,
        pot3: {
          current: pot3Current,
          target: pot3Target,
          coverage: pot3Target > 0 ? pot3Current / pot3Target * 100 : 0,
          monthsCovered: monthlyNeed > 0 ? pot3Current / monthlyNeed : 0,
          difference: pot3Current - pot3Target
        },
        pot2: {
          current: pot2Current,
          target: pot2Target,
          coverage: pot2Target > 0 ? pot2Current / pot2Target * 100 : 0,
          difference: pot2Current - pot2Target
        }
      },
      fx,
      portfolios: (portfolioData.items || []).map(p => ({ id: p.id, name: p.name, currency: p.currency })),
      totals: {
        buckets: bucketTotals,
        assignedAssets: bucketTotals["1"] + bucketTotals["2"] + bucketTotals["3"],
        futuresEquity,
        futuresExposure,
        futuresPnl,
        futuresEffectiveLeverage,
        creditsUsed,
        creditsLimit,
        creditsAvailable: Math.max(0, creditsLimit - creditsUsed),
        firefishActive,
        firefishPlanned,
        bitcoinTotalValue,
        bitcoinTotalAmount,
        bitcoinPositionCount: bitcoinHoldings.length,
        firefishBorrowPercent,
        firefishTargetLtv,
        firefishCollateralBase,
        firefishCollateralBtc,
        firefishCurrentLtv,
        firefishPlannedLtv,
        firefishTotalLimit,
        firefishAvailable: Math.max(0, firefishTotalLimit - firefishActive),
        firefishAvailableAfterPlanning: Math.max(0, firefishTotalLimit - firefishActive - firefishPlanned),
        freeCreditLiquidity: Math.max(0, creditsLimit - creditsUsed) + Math.max(0, firefishTotalLimit - firefishActive)
      }
    });
  } catch (err) { next(err); }
});

app.post("/api/assign", async (req, res) => {
  const { holdingId, bucket } = req.body || {};
  if (!holdingId) return res.status(400).json({ error: "holdingId fehlt" });
  const allowed = [null, 1, 2, 3, "1", "2", "3"];
  if (!allowed.includes(bucket)) return res.status(400).json({ error: "bucket muss 1, 2, 3 oder null sein" });

  const state = await getState();
  if (bucket === null) delete state.assignments[holdingId];
  else state.assignments[holdingId] = Number(bucket);
  await saveState(state);
  res.json({ ok: true });
});

app.post("/api/futures", async (req, res) => {
  const body = req.body || {};
  const equity = safeNumber(body.equity);
  const leverage = safeNumber(body.leverage) > 0 ? safeNumber(body.leverage) : 1;
  const item = {
    id: body.id || crypto.randomUUID(),
    name: String(body.name || "").trim(),
    equity,
    leverage,
    exposure: Math.abs(equity) * leverage,
    pnl: safeNumber(body.pnl),
    currency: ["EUR", "USD", "USDT"].includes(body.currency) ? body.currency : "EUR",
    note: String(body.note || "").trim()
  };
  if (!item.name) return res.status(400).json({ error: "Name fehlt" });
  const state = await getState();
  const idx = state.futures.findIndex(x => x.id === item.id);
  if (idx >= 0) state.futures[idx] = item;
  else state.futures.push(item);
  await saveState(state);
  res.json({ ok: true, item });
});

app.delete("/api/futures/:id", async (req, res) => {
  const state = await getState();
  state.futures = state.futures.filter(x => x.id !== req.params.id);
  await saveState(state);
  res.json({ ok: true });
});

function parseCsvLine(line) {
  const cells = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(value); value = "";
    } else value += ch;
  }
  cells.push(value);
  return cells;
}

function firefishDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function parseFirefishCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error("CSV enthält keine Kredite.");
  const headers = parseCsvLine(lines[0]).map(x => x.trim());
  const required = ["Loan id", "Start date (dd.mm.yyyy)", "Maturity date (dd.mm.yyyy)", "Interest rate (% p.a.)", "Currency", "Loan amount", "Status"];
  for (const name of required) if (!headers.includes(name)) throw new Error(`Firefish-Spalte fehlt: ${name}`);
  const col = name => headers.indexOf(name);

  return lines.slice(1).map((line, index) => {
    const row = parseCsvLine(line);
    const loanId = String(row[col("Loan id")] || "").trim();
    const currency = String(row[col("Currency")] || "").trim().toUpperCase();
    const status = String(row[col("Status")] || "").trim().toUpperCase();
    if (!loanId) throw new Error(`Zeile ${index + 2}: Loan id fehlt.`);
    if (!["EUR", "USDT", "USD"].includes(currency)) throw new Error(`Zeile ${index + 2}: Währung ${currency || "fehlt"} wird nicht unterstützt.`);
    return {
      id: crypto.randomUUID(),
      name: `Firefish ${loanId}`,
      type: "firefish",
      source: "firefish-csv",
      firefishLoanId: loanId,
      startDate: firefishDate(row[col("Start date (dd.mm.yyyy)")]),
      maturityDate: firefishDate(row[col("Maturity date (dd.mm.yyyy)")]),
      rate: safeNumber(row[col("Interest rate (% p.a.)")]),
      currency,
      activeAmount: Math.abs(safeNumber(row[col("Loan amount")])),
      status: status || "UNKNOWN",
      portfolioId: "",
      holdingId: "",
      limit: 0,
      note: ""
    };
  });
}

app.post("/api/credits/firefish/import", async (req, res) => {
  try {
    const mode = req.body?.mode === "replace" ? "replace" : "new";
    const imported = parseFirefishCsv(req.body?.csv);
    const state = await getState();
    const existingFirefish = state.credits.filter(c => c.type === "firefish");
    const nonCsvCredits = state.credits.filter(c => !(c.type === "firefish" && c.source === "firefish-csv"));

    let added = imported;
    let skipped = 0;
    if (mode === "new") {
      const known = new Set(existingFirefish.map(c => String(c.firefishLoanId || "")).filter(Boolean));
      added = imported.filter(c => !known.has(c.firefishLoanId));
      skipped = imported.length - added.length;
      state.credits = [...state.credits, ...added];
    } else {
      // Replace only earlier CSV imports. Manually planned/entered Firefish loans
      // and all revolving credits remain untouched.
      state.credits = [...nonCsvCredits, ...imported];
    }

    await saveState(state);
    res.json({ ok: true, imported: added.length, skipped, totalRows: imported.length, mode });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/credits", async (req, res) => {
  const body = req.body || {};
  const type = body.type === "firefish" ? "firefish" : "revolving";
  const source = body.source === "parqet" ? "parqet" : "manual";
  const firefishStatus = String(body.status || "ACTIVE").trim().toUpperCase();
  const firefishCurrency = ["EUR", "USD", "USDT"].includes(String(body.currency || "").toUpperCase())
    ? String(body.currency).toUpperCase()
    : "EUR";
  const item = {
    id: body.id || crypto.randomUUID(),
    name: String(body.name || "").trim(),
    type,
    source,
    portfolioId: source === "parqet" ? String(body.portfolioId || "") : "",
    holdingId: source === "parqet" ? String(body.holdingId || "") : "",
    activeAmount: safeNumber(body.activeAmount ?? body.used),
    limit: type === "revolving" ? Math.abs(safeNumber(body.limit)) : 0,
    rate: safeNumber(body.rate),
    status: type === "firefish" ? firefishStatus : "",
    currency: type === "firefish" ? firefishCurrency : "EUR",
    startDate: type === "firefish" ? String(body.startDate || "").trim() : "",
    maturityDate: type === "firefish" ? String(body.maturityDate || "").trim() : "",
    note: String(body.note || "").trim()
  };
  if (!item.name) return res.status(400).json({ error: "Name fehlt" });
  if (source === "parqet" && !item.portfolioId) {
    return res.status(400).json({ error: "Parqet-Portfolio fehlt" });
  }
  if (source === "parqet" && !item.holdingId) {
    return res.status(400).json({ error: "Parqet-Position fehlt" });
  }

  const state = await getState();
  const idx = state.credits.findIndex(x => x.id === item.id);
  if (idx >= 0) state.credits[idx] = item;
  else state.credits.push(item);
  await saveState(state);
  res.json({ ok: true, item });
});

app.post("/api/settings/firefish", async (req, res) => {
  const state = await getState();
  state.settings = state.settings || {};
  const percent = Math.min(100, Math.abs(safeNumber(req.body?.borrowPercent)));
  const targetLtv = Math.min(50, Math.abs(safeNumber(req.body?.targetLtv)));
  state.settings.firefishBorrowPercent = percent;
  state.settings.firefishTargetLtv = targetLtv;
  delete state.settings.firefishTotalLimit;
  await saveState(state);
  res.json({ ok: true, firefishBorrowPercent: percent, firefishTargetLtv: targetLtv });
});

app.post("/api/settings/targets", async (req, res) => {
  const monthlyNeed = safeNumber(req.body?.monthlyNeed);
  const targetMonthsRaw = safeNumber(req.body?.targetMonths);
  const pot2Multiplier = safeNumber(req.body?.pot2Multiplier);

  if (!(monthlyNeed > 0)) return res.status(400).json({ error: "Bedarf / Monat muss größer als 0 sein." });
  if (!(targetMonthsRaw > 0) || !Number.isInteger(targetMonthsRaw)) {
    return res.status(400).json({ error: "Dauer muss eine positive ganze Zahl von Monaten sein." });
  }
  if (pot2Multiplier < 1 || pot2Multiplier > 12) {
    return res.status(400).json({ error: "Topf-2-Multiplikator muss zwischen 1,0 und 12,0 liegen." });
  }

  const state = await getState();
  state.settings = state.settings || {};
  state.settings.monthlyNeed = monthlyNeed;
  state.settings.targetMonths = targetMonthsRaw;
  state.settings.pot2Multiplier = pot2Multiplier;
  await saveState(state);

  res.json({ ok: true, monthlyNeed, targetMonths: targetMonthsRaw, pot2Multiplier });
});

app.delete("/api/credits/:id", async (req, res) => {
  const state = await getState();
  state.credits = state.credits.filter(x => x.id !== req.params.id);
  await saveState(state);
  res.json({ ok: true });
});


function validateBackupPayload(payload) {
  if (!payload || payload.format !== "parqet-risk-pots-backup" || payload.version !== 1) {
    throw new Error("Ungültiges oder nicht unterstütztes Risk-Pots-Backup.");
  }
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Backup enthält keinen gültigen Konfigurationsblock.");
  }
  if (data.assignments != null && (typeof data.assignments !== "object" || Array.isArray(data.assignments))) {
    throw new Error("Backup: assignments ist ungültig.");
  }
  if (data.futures != null && !Array.isArray(data.futures)) throw new Error("Backup: futures ist ungültig.");
  if (data.credits != null && !Array.isArray(data.credits)) throw new Error("Backup: credits ist ungültig.");
  if (data.settings != null && (typeof data.settings !== "object" || Array.isArray(data.settings))) {
    throw new Error("Backup: settings ist ungültig.");
  }
  const portfolioIds = Array.isArray(data.portfolioIds)
    ? [...new Set(data.portfolioIds.filter(id => typeof id === "string" && id.trim()))]
    : (typeof data.selectedPortfolioId === "string" && data.selectedPortfolioId ? [data.selectedPortfolioId] : []);
  return {
    portfolioIds,
    selectedPortfolioId: portfolioIds[0] || null,
    assignments: data.assignments || {},
    futures: data.futures || [],
    credits: data.credits || [],
    settings: {
      firefishBorrowPercent: Math.min(100, Math.abs(safeNumber(data.settings?.firefishBorrowPercent))),
      firefishTargetLtv: data.settings?.firefishTargetLtv == null ? 30 : Math.min(50, Math.abs(safeNumber(data.settings.firefishTargetLtv))),
      monthlyNeed: Math.max(0, safeNumber(data.settings?.monthlyNeed)),
      targetMonths: Math.max(0, Math.trunc(safeNumber(data.settings?.targetMonths))),
      pot2Multiplier: data.settings?.pot2Multiplier == null ? 2 : Math.min(12, Math.max(1, safeNumber(data.settings.pot2Multiplier)))
    }
  };
}

app.get("/api/profiles", async (_req, res) => {
  const store = await getProfileStore();
  res.json({
    activeProfileId: store.activeProfileId,
    profiles: Object.values(store.profiles).map(p => ({
      id: p.id,
      name: p.name,
      portfolioIds: p.portfolioIds || (p.selectedPortfolioId ? [p.selectedPortfolioId] : [])
    }))
  });
});

app.post("/api/profiles", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const portfolioIds = Array.isArray(req.body?.portfolioIds)
    ? [...new Set(req.body.portfolioIds.filter(id => typeof id === "string" && id.trim()))]
    : [];
  if (!name) return res.status(400).json({ error: "Profilname fehlt." });
  if (!portfolioIds.length) return res.status(400).json({ error: "Mindestens ein Parqet-Portfolio muss ausgewählt werden." });
  const store = await getProfileStore();
  let id;
  do { id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
  while (store.profiles[id]);
  const profile = defaultProfile(id, name);
  profile.portfolioIds = portfolioIds;
  profile.selectedPortfolioId = portfolioIds[0];
  store.profiles[id] = profile;
  store.activeProfileId = id;
  await writeJsonAtomic(STATE_FILE, store);
  res.json({ ok: true, id, name });
});

app.post("/api/profiles/:id/activate", async (req, res) => {
  const store = await getProfileStore();
  if (!store.profiles[req.params.id]) return res.status(404).json({ error: "Profil nicht gefunden." });
  store.activeProfileId = req.params.id;
  await writeJsonAtomic(STATE_FILE, store);
  res.json({ ok: true });
});

app.put("/api/profiles/:id/portfolios", async (req, res) => {
  const requested = Array.isArray(req.body?.portfolioIds) ? [...new Set(req.body.portfolioIds.filter(id => typeof id === "string" && id.trim()))] : [];
  if (!requested.length) return res.status(400).json({ error: "Mindestens ein Portfolio muss zugeordnet bleiben." });
  const store = await getProfileStore(), profile = store.profiles[req.params.id];
  if (!profile) return res.status(404).json({ error: "Profil nicht gefunden." });
  const existing = profile.portfolioIds || (profile.selectedPortfolioId ? [profile.selectedPortfolioId] : []);
  const base = existing[0];
  if (base && !requested.includes(base)) return res.status(400).json({ error: "Das erste zugeordnete Portfolio kann nicht entfernt werden." });
  for (const portfolioId of existing.filter(id => !requested.includes(id))) {
    const creditRefs = (profile.credits || []).filter(c => c.portfolioId === portfolioId);
    if (creditRefs.length) return res.status(409).json({ error: `Portfolio kann nicht entfernt werden: ${creditRefs.length} Kredit-Referenz(en) vorhanden.` });
    const perf = await parqetFetch("/performance", { method:"POST", body:JSON.stringify({portfolioIds:[portfolioId],currency:"EUR"}) });
    const holdingIds = new Set((perf.holdings || []).map(h => h.id).filter(Boolean));
    const refs = Object.keys(profile.assignments || {}).filter(id => holdingIds.has(id));
    if (refs.length) return res.status(409).json({ error: `Portfolio kann nicht entfernt werden: ${refs.length} Topf-Zuordnung(en) vorhanden. Bitte zuerst auflösen.` });
  }
  profile.portfolioIds=requested; profile.selectedPortfolioId=requested[0];
  await writeJsonAtomic(STATE_FILE,store); res.json({ok:true,portfolioIds:requested});
});

app.post("/api/profiles/:id/portfolios/add", async (req, res) => {
  const additions = Array.isArray(req.body?.portfolioIds)
    ? [...new Set(req.body.portfolioIds.filter(id => typeof id === "string" && id.trim()))]
    : [];
  if (!additions.length) return res.status(400).json({ error: "Keine neuen Portfolios ausgewählt." });

  const store = await getProfileStore();
  const profile = store.profiles[req.params.id];
  if (!profile) return res.status(404).json({ error: "Profil nicht gefunden." });

  const existing = profile.portfolioIds || (profile.selectedPortfolioId ? [profile.selectedPortfolioId] : []);
  profile.portfolioIds = [...new Set([...existing, ...additions])];
  profile.selectedPortfolioId = profile.portfolioIds[0] || null;
  await writeJsonAtomic(STATE_FILE, store);
  res.json({ ok: true, portfolioIds: profile.portfolioIds });
});

app.put("/api/profiles/:id", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Profilname fehlt." });
  const store = await getProfileStore();
  const profile = store.profiles[req.params.id];
  if (!profile) return res.status(404).json({ error: "Profil nicht gefunden." });
  profile.name = name;
  await writeJsonAtomic(STATE_FILE, store);
  res.json({ ok: true });
});

app.delete("/api/profiles/:id", async (req, res) => {
  const store = await getProfileStore();
  if (!store.profiles[req.params.id]) return res.status(404).json({ error: "Profil nicht gefunden." });
  const ids = Object.keys(store.profiles);
  if (ids.length <= 1) return res.status(400).json({ error: "Das letzte Profil kann nicht gelöscht werden." });
  delete store.profiles[req.params.id];
  if (store.activeProfileId === req.params.id) {
    store.activeProfileId = Object.keys(store.profiles)[0];
  }
  await writeJsonAtomic(STATE_FILE, store);
  res.json({ ok: true, activeProfileId: store.activeProfileId });
});

app.get("/api/config/export", async (_req, res) => {
  const state = await getState();
  res.json({
    format: "parqet-risk-pots-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      portfolioIds: state.portfolioIds || (state.selectedPortfolioId ? [state.selectedPortfolioId] : []),
      selectedPortfolioId: state.selectedPortfolioId ?? null,
      assignments: state.assignments || {},
      futures: state.futures || [],
      credits: state.credits || [],
      settings: {
        firefishBorrowPercent: Math.min(100, Math.abs(safeNumber(state.settings?.firefishBorrowPercent))),
        firefishTargetLtv: state.settings?.firefishTargetLtv == null ? 30 : Math.min(50, Math.abs(safeNumber(state.settings.firefishTargetLtv))),
        monthlyNeed: Math.max(0, safeNumber(state.settings?.monthlyNeed)),
        targetMonths: Math.max(0, Math.trunc(safeNumber(state.settings?.targetMonths))),
        pot2Multiplier: state.settings?.pot2Multiplier == null ? 2 : Math.min(12, Math.max(1, safeNumber(state.settings.pot2Multiplier)))
      }
    }
  });
});

app.post("/api/config/import", async (req, res) => {
  try {
    const imported = validateBackupPayload(req.body);
    const store = await getProfileStore();
    const id = store.activeProfileId;
    const current = store.profiles[id] || defaultProfile(id, "Main");

    // Restore the exported configuration into the currently active profile.
    // Preserve profile identity/name; all exported profile-local configuration
    // (including settings) is replaced by the backup.
    store.profiles[id] = normalizeProfile({
      ...current,
      ...imported,
      id,
      name: current.name
    }, id, current.name || "Main");

    await writeJsonAtomic(STATE_FILE, store);
    res.json({
      ok: true,
      counts: {
        assignments: Object.keys(imported.assignments).length,
        futures: imported.futures.length,
        credits: imported.credits.length
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || "Serverfehler",
    code: err.code || null
  });
});

await migrateLegacyData();
httpServer = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Parqet Risk Pots läuft auf ${BASE_URL}`);
  console.log(`User data: ${DATA_DIR}`);
  console.log(`OAuth Redirect URI: ${REDIRECT_URI}`);
});
