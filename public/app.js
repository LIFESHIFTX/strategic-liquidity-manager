const $ = (id) => document.getElementById(id);
let dashboard = null;
let currency = "EUR";
let editingCreditId = null;
let editingFutureId = null;
let portfolioCatalog = [];

function money(v) {
  return new Intl.NumberFormat("de-DE", { style:"currency", currency, maximumFractionDigits:0 }).format(Number(v || 0));
}
function moneyIn(v, inputCurrency) {
  const c = inputCurrency === "USDT" ? "USD" : inputCurrency;
  const formatted = new Intl.NumberFormat("de-DE", { style:"currency", currency:c || "EUR", maximumFractionDigits:0 }).format(Number(v || 0));
  return inputCurrency === "USDT" ? `${formatted.replace("$", "").trim()} USDT` : formatted;
}
function num(v, digits=2) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits:digits }).format(Number(v || 0));
}
async function api(url, options={}) {
  const res = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: { "content-type":"application/json", ...(options.headers||{}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code || null;
    throw err;
  }
  return data;
}
function notice(text, error=false) {
  const el = $("notice");
  if (!text) { el.classList.add("hidden"); return; }
  el.textContent = text;
  el.className = `notice${error ? " error" : ""}`;
}
function openManagementFor(inputId) {
  const area = $("managementArea");
  const button = $("toggleManagementBtn");
  area.classList.remove("hidden");
  button.setAttribute("aria-expanded", "true");
  button.textContent = "Verwaltung ausblenden ▲";

  const input = $(inputId);
  requestAnimationFrame(() => {
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus({ preventScroll: true });
  });
}
function positionHtml(h) {
  const extra = [h.symbol, h.isin, h.type].filter(Boolean).join(" · ");
  return `<div class="position"><div><strong>${escapeHtml(h.name)}</strong><br><small>${escapeHtml(extra)}</small></div><strong>${money(h.currentValue)}</strong></div>`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function renderBucket(n) {
  const items = dashboard.holdings
    .filter(h => Number(h.bucket) === n)
    .sort((a, b) => Number(b.currentValue || 0) - Number(a.currentValue || 0));

  const el = $(`bucket${n}`);
  el.classList.toggle("empty", items.length === 0);
  el.innerHTML = items.length ? items.map(positionHtml).join("") : "Keine Positionen zugeordnet";
  $(`total${n}`).textContent = money(dashboard.totals.buckets[String(n)]);
}
function renderTargetModels() {
  const model = dashboard?.targetModel;
  const host1 = $("targetModel1");
  const host2 = $("targetModel2");
  const host3 = $("targetModel3");
  if (!host1 || !host2 || !host3) return;
  if (!model?.configured) {
    const empty = `<div class="target-model-empty">Zielmodell noch nicht konfiguriert</div>`;
    host1.innerHTML = ""; host2.innerHTML = empty; host3.innerHTML = empty; return;
  }
  const render = (pot, extraHtml="") => {
    const coverage = Math.max(0, Number(pot.coverage || 0));
    const width = Math.min(100, coverage);
    const diff = Number(pot.difference || 0);
    const diffLabel = diff < 0 ? "Fehlbetrag" : "Überschuss";
    return `<div class="target-values"><span>Ist <strong>${money(pot.current)}</strong></span><span>Soll <strong>${money(pot.target)}</strong></span></div>
      <div class="target-progress" title="${num(coverage, 1)} % Zielerreichung"><div class="target-progress-fill" style="width:${width}%"></div></div>
      <div class="target-details"><span>Deckung <strong>${num(coverage, 1)} %</strong></span>${extraHtml}<span>${diffLabel} <strong>${money(Math.abs(diff))}</strong></span></div>`;
  };
  const pot1Current = Number(dashboard?.totals?.buckets?.["1"] || 0);
  const pot1Months = model.monthlyNeed > 0 ? pot1Current / model.monthlyNeed : 0;
  const pot1Years = pot1Months / 12;
  host1.innerHTML = `<div class="target-details target-details-pot1"><span>Reichweite bei Liquidierung heute <strong>${num(pot1Months, 1)} Monate · ${num(pot1Years, 1)} Jahre</strong></span></div>`;
  host3.innerHTML = render(model.pot3, `<span>Reichweite <strong>${num(model.pot3.monthsCovered, 1)} Monate</strong></span><span>Ziel <strong>${num(model.targetMonths, 0)} Monate</strong></span>`);
  const pot2Months = model.monthlyNeed > 0 ? Number(model.pot2.current || 0) / model.monthlyNeed : 0;
  const pot2TargetMonths = Number(model.targetMonths || 0) * Number(model.pot2Multiplier || 0);
  host2.innerHTML = render(model.pot2, `<span>Reichweite <strong>${num(pot2Months, 1)} Monate</strong></span><span>Ziel <strong>${num(pot2TargetMonths, 1)} Monate</strong></span>`);
}

function renderOverview() {
  const assigned = Number(dashboard.totals.assignedAssets || 0);
  $("assignedAssets").textContent = money(assigned);
  $("freeCreditLiquidity").textContent = money(dashboard.totals.freeCreditLiquidity);

  [1, 2, 3].forEach(n => {
    const value = Number(dashboard.totals.buckets[String(n)] || 0);
    const share = assigned > 0 ? (value / assigned) * 100 : 0;
    $(`share${n}`).textContent = `${num(share, 1)} % · ${money(value)}`;
    $(`allocation${n}`).style.width = `${share}%`;
    $(`allocation${n}`).title = `Topf ${n}: ${num(share, 1)} %`;
  });
}

function renderFutures() {
  const host = $("futureBlock");
  if (!dashboard.futures.length) { host.innerHTML = ""; return; }

  const fx = dashboard.fx || {};
  const fxInfo = dashboard.futures.some(f => f.currency !== "EUR")
    ? (fx.eurUsd
        ? `<div class="fx-info">EUR/USD ${num(fx.eurUsd, 4)} · ${escapeHtml(fx.source || "ECB")}${fx.date ? ` ${escapeHtml(fx.date)}` : ""}${fx.stale ? " · letzter verfügbarer Kurs" : ""} · USDT ≈ USD</div>`
        : `<div class="fx-info fx-warning">EUR/USD derzeit nicht verfügbar · USD/USDT-Futures werden nicht in Topf 1 eingerechnet.</div>`)
    : "";

  const futureSummary = `<div class="future-risk-summary">
    <span>Equity <strong>${money(dashboard.totals.futuresEquity)}</strong></span>
    <span>Gross Exposure <strong>${money(dashboard.totals.futuresExposure)}</strong></span>
    <span>Eff. Hebel <strong>${num(dashboard.totals.futuresEffectiveLeverage, 2)}×</strong></span>
    <span>P&amp;L <strong>${money(dashboard.totals.futuresPnl)}</strong></span>
  </div>`;

  host.innerHTML = `<div class="future-box"><h3>Futures</h3>${futureSummary}${fxInfo}` +
    dashboard.futures.map(f => {
      const converted = f.currency === "EUR" ? "" : (f.equityEur == null
        ? `<br><small class="fx-warning">EUR-Gegenwert nicht verfügbar</small>`
        : `<br><small>EUR-Gegenwert: Margin ${money(f.equityEur)} · Exposure ${money(f.exposureEur)} · P&amp;L ${money(f.pnlEur)}</small>`);
      return `<div class="position">
        <div><strong>${escapeHtml(f.name)} · ${num(f.leverage, 2)}×</strong><br>
        <small>Margin ${moneyIn(f.equity, f.currency)} · Exposure ${moneyIn(f.exposure, f.currency)} · P&amp;L ${moneyIn(f.pnl, f.currency)}${f.note ? " · " + escapeHtml(f.note) : ""}</small>${converted}</div>
        <div class="row"><button class="secondary edit-future" data-id="${escapeHtml(f.id)}">Bearbeiten</button><button class="danger delete-future" data-id="${escapeHtml(f.id)}">Löschen</button></div>
      </div>`;
    }).join("") + `</div>`;

  document.querySelectorAll(".edit-future").forEach(button => button.addEventListener("click", () => {
    const future = dashboard.futures.find(f => f.id === button.dataset.id);
    if (!future) return;
    editingFutureId = future.id;
    $("futureName").value = future.name || "";
    $("futureCurrency").value = future.currency || "EUR";
    $("futureEquity").value = future.equity ?? "";
    $("futureLeverage").value = future.leverage ?? (future.equity ? future.exposure / future.equity : 1);
    $("futurePnl").value = future.pnl ?? "";
    $("futureNote").value = future.note || "";
    $("addFutureBtn").textContent = "Änderungen speichern";
    $("cancelFutureEditBtn").classList.remove("hidden");
    openManagementFor("futureName");
  }));

  document.querySelectorAll(".delete-future").forEach(button => button.addEventListener("click", async () => {
    const future = dashboard.futures.find(f => f.id === button.dataset.id);
    const name = future?.name || "Diesen Future";
    if (!window.confirm(`„${name}“ wirklich löschen?`)) return;
    await api(`/api/futures/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
    if (editingFutureId === button.dataset.id) resetFutureForm();
    await loadDashboard();
  }));
}

function renderCredits() {
  const revolving = dashboard.credits.filter(c => c.type === "revolving");
  const firefish = dashboard.credits.filter(c => c.type === "firefish");

  $("creditUsed").textContent = `${money(dashboard.totals.freeCreditLiquidity)} frei`;
  $("creditSummary").innerHTML =
    `<span>Firefish frei: <strong>${money(dashboard.totals.firefishAvailable)}</strong></span>` +
    `<span>Rahmenkredite frei: <strong>${money(dashboard.totals.creditsAvailable)}</strong></span>`;

  const sourceText = c => c.source === "parqet"
    ? (c.sourceFound
        ? `Parqet: ${escapeHtml(c.sourcePortfolioName || c.portfolioId || "")} → ${escapeHtml(c.sourceHoldingName || c.holdingId || "")}`
        : `Parqet: Quelle nicht gefunden`)
    : (c.source === "firefish-csv" ? "Firefish CSV" : "manuell");

  const utilizationBar = (used, limit, label) => {
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    const width = Math.min(100, Math.max(0, pct));
    const over = pct > 100;
    return `<div class="utilization${over ? " over-limit" : ""}" title="${escapeHtml(label)}: ${num(pct, 1)} %">
      <div class="utilization-head"><span>${escapeHtml(label)}</span><strong>${num(pct, 1)} %</strong></div>
      <div class="utilization-track"><div class="utilization-fill" style="width:${width}%"></div></div>
    </div>`;
  };

  const creditRow = c => {
    const details = c.type === "firefish"
      ? `${escapeHtml(c.status || "ACTIVE")} · ${moneyIn(c.activeAmount, c.currency || "EUR")}`
      : `Genutzt ${money(c.activeAmount)} / Limit ${money(c.limit)} · verfügbar ${money(Math.max(0, c.limit - c.activeAmount))}`;
    const utilization = c.type === "revolving" && c.limit > 0
      ? utilizationBar(c.activeAmount, c.limit, "Auslastung")
      : "";

    return `<div class="position">
      <div>
        <strong>${escapeHtml(c.name)}</strong><br>
        <small>${details} · ${num(c.rate)} % p.a.${c.firefishLoanId ? ` · Loan ${escapeHtml(c.firefishLoanId)}` : ""}${c.startDate ? ` · ${escapeHtml(c.startDate)} → ${escapeHtml(c.maturityDate || "–")}` : ""} · ${sourceText(c)}${c.note ? " · " + escapeHtml(c.note) : ""}</small>
        ${utilization}
      </div>
      <div class="row">
        ${c.source === "firefish-csv" ? "" : `<button class="secondary edit-credit" data-id="${escapeHtml(c.id)}">Bearbeiten</button>`}
        <button class="danger delete-credit" data-id="${escapeHtml(c.id)}">Löschen</button>
      </div>
    </div>`;
  };

  const el = $("credits");
  el.classList.toggle("empty", dashboard.credits.length === 0);
  el.innerHTML = dashboard.credits.length ? `
    <div class="credit-group">
      <div class="credit-group-head">
        <h3>Firefish</h3>
      </div>
      <div class="mini-summary credit-summary-highlight">
        <span>BTC-Basis: <strong>${money(dashboard.totals.bitcoinTotalValue)}</strong> (${dashboard.totals.bitcoinPositionCount} Position${dashboard.totals.bitcoinPositionCount === 1 ? "" : "en"})</span>
        <span>Für Firefish: <strong>${num(dashboard.totals.firefishBorrowPercent)} %</strong></span>
        <span>Collateral-Basis: <strong>${num(dashboard.totals.firefishCollateralBtc, 8)} BTC</strong></span>
        <span>Ziel-LTV: <strong>${num(dashboard.totals.firefishTargetLtv)} %</strong></span>
        <span>Strategischer LTV: <strong>${num(dashboard.totals.firefishCurrentLtv)} %</strong></span>
        <span>Strategischer LTV nach Planung: <strong>${num(dashboard.totals.firefishPlannedLtv)} %</strong></span>
        <span>Aktiv gesamt: <strong>${money(dashboard.totals.firefishActive)}</strong></span>
        <span>Geplant: <strong>${money(dashboard.totals.firefishPlanned)}</strong></span>
        <span>Strategisches Kreditlimit: <strong>${money(dashboard.totals.firefishTotalLimit)}</strong></span>
        <span>Freie Kapazität: <strong>${money(dashboard.totals.firefishAvailable)}</strong></span>
        <span>Nach Planung: <strong>${money(dashboard.totals.firefishAvailableAfterPlanning)}</strong></span>
      </div>
      ${dashboard.totals.firefishTotalLimit > 0 ? utilizationBar(dashboard.totals.firefishActive, dashboard.totals.firefishTotalLimit, "Firefish-Auslastung") : ""}
      ${firefish.length ? firefish.map(creditRow).join("") : `<div class="empty">Keine aktiven Firefish-Kredite</div>`}
    </div>
    <div class="credit-group">
      <h3>Rahmenkredite</h3>
      <div class="mini-summary credit-summary-highlight">
        <span>Genutzt gesamt: <strong>${money(dashboard.totals.creditsUsed)}</strong></span>
        <span>Gesamtrahmen: <strong>${money(dashboard.totals.creditsLimit)}</strong></span>
        <span>Verfügbar: <strong>${money(dashboard.totals.creditsAvailable)}</strong></span>
      </div>
      ${revolving.length ? revolving.map(creditRow).join("") : `<div class="empty">Keine Rahmenkredite</div>`}
    </div>` : "Keine Kredite eingetragen";

  document.querySelectorAll(".edit-credit").forEach(button => {
    button.addEventListener("click", async () => {
      const credit = dashboard.credits.find(c => c.id === button.dataset.id);
      if (!credit) return;
      editingCreditId = credit.id;
      $("creditName").value = credit.name || "";
      $("creditType").value = credit.type || "revolving";
      $("creditSource").value = credit.source === "parqet" ? "parqet" : "manual";
      $("creditStatus").value = credit.status || (credit.type === "firefish" ? "ACTIVE" : "PLANNED");
      $("creditCurrency").value = credit.currency || "EUR";
      $("creditStartDate").value = credit.startDate || "";
      $("creditMaturityDate").value = credit.maturityDate || "";
      $("creditPortfolioId").value = credit.portfolioId || "";
      if (credit.source === "parqet" && credit.portfolioId) {
        await loadCreditHoldings(credit.portfolioId, credit.holdingId || "");
      }
      $("creditUsedInput").value = credit.activeAmount ?? "";
      $("creditLimit").value = credit.limit ?? "";
      $("creditRate").value = credit.rate ?? "";
      $("creditNote").value = credit.note || "";
      updateCreditForm();
      $("addCreditBtn").textContent = "Änderungen speichern";
      $("cancelCreditEditBtn").classList.remove("hidden");
      openManagementFor("creditName");
    });
  });

  document.querySelectorAll(".delete-credit").forEach(button => {
    button.addEventListener("click", async () => {
      const credit = dashboard.credits.find(c => c.id === button.dataset.id);
      const name = credit?.name || "Diesen Kredit";
      if (!window.confirm(`„${name}“ wirklich löschen?`)) return;
      await api(`/api/credits/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      if (editingCreditId === button.dataset.id) resetCreditForm();
      await loadDashboard();
    });
  });
}
function renderHoldings() {
  const host = $("holdingsTable");
  if (!dashboard.holdings.length) { host.innerHTML = "<p>Keine aktiven Holdings gefunden.</p>"; return; }
  host.innerHTML = `<table><thead><tr><th>Position</th><th>Typ</th><th>Wert</th><th>Topf</th></tr></thead><tbody>` +
    dashboard.holdings.map(h => `<tr>
      <td><strong>${escapeHtml(h.name)}</strong><br><small>${escapeHtml(h.symbol || h.isin || h.id)}</small></td>
      <td>${escapeHtml(h.type)}</td>
      <td>${money(h.currentValue)}</td>
      <td><select class="bucket-select" data-id="${escapeHtml(h.id)}">
        <option value="" ${h.bucket==null?"selected":""}>Nicht zugeordnet</option>
        <option value="1" ${Number(h.bucket)===1?"selected":""}>Topf 1</option>
        <option value="2" ${Number(h.bucket)===2?"selected":""}>Topf 2</option>
        <option value="3" ${Number(h.bucket)===3?"selected":""}>Topf 3</option>
      </select></td>
    </tr>`).join("") + "</tbody></table>";
  document.querySelectorAll(".bucket-select").forEach(s => s.addEventListener("change", async () => {
    await api("/api/assign", {method:"POST", body:JSON.stringify({holdingId:s.dataset.id, bucket:s.value ? Number(s.value) : null})});
    await loadDashboard();
  }));
}

function populateCreditPortfolios() {
  const select = $("creditPortfolioId");
  if (!select || !dashboard?.portfolios) return;

  const current = select.value;
  const allowedIds = new Set(dashboard.portfolioIds || []);
  const profilePortfolios = dashboard.portfolios.filter(p => allowedIds.has(p.id));

  select.innerHTML = `<option value="">Portfolio auswählen</option>` +
    profilePortfolios.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.currency || currency)})</option>`
    ).join("");

  if ([...select.options].some(o => o.value === current)) {
    select.value = current;
  } else {
    select.value = "";
    $("creditHoldingId").innerHTML = `<option value="">Position auswählen</option>`;
  }
}

async function loadCreditHoldings(portfolioId, selectedHoldingId = "") {
  const select = $("creditHoldingId");
  select.innerHTML = `<option value="">Position auswählen</option>`;
  if (!portfolioId) return;

  const data = await api(`/api/portfolio-holdings/${encodeURIComponent(portfolioId)}`);
  select.innerHTML = `<option value="">Position auswählen</option>` +
    (data.holdings || []).map(h =>
      `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)} · ${money(h.currentValue)}</option>`
    ).join("");
  if ([...select.options].some(o => o.value === selectedHoldingId)) {
    select.value = selectedHoldingId;
  }
}

function updateCreditForm() {
  const type = $("creditType").value;
  const isFirefish = type === "firefish";

  // Firefish wird entweder manuell geplant/gepflegt oder separat per CSV importiert.
  // Eine Parqet-Quelle ist für Firefish deshalb kein gültiger Zustand.
  if (isFirefish && $("creditSource").value === "parqet") {
    $("creditSource").value = "manual";
    $("creditPortfolioId").value = "";
    $("creditHoldingId").innerHTML = `<option value="">Position auswählen</option>`;
  }

  const source = $("creditSource").value;
  const isParqet = !isFirefish && source === "parqet";

  $("creditAmountLabel").firstChild.textContent = isFirefish ? "Kreditbetrag" : "Genutzt";
  $("creditUsedInput").disabled = isParqet;
  $("creditUsedInput").placeholder = isParqet ? "wird aus Parqet gelesen" : (isFirefish ? "12000" : "8000");
  $("creditSourceLabel").classList.toggle("hidden", isFirefish);
  $("creditPortfolioLabel").classList.toggle("hidden", !isParqet);
  $("creditHoldingLabel").classList.toggle("hidden", !isParqet);
  $("creditLimitLabel").classList.toggle("hidden", isFirefish);

  ["creditStatusLabel","creditCurrencyLabel","creditStartDateLabel","creditMaturityDateLabel"]
    .forEach(id => $(id).classList.toggle("hidden", !isFirefish));
}

function resetCreditForm() {
  editingCreditId = null;
  ["creditName","creditUsedInput","creditLimit","creditRate","creditNote"].forEach(id => {
    $(id).value = "";
  });
  $("creditType").value = "revolving";
  $("creditSource").value = "manual";
  $("creditStatus").value = "PLANNED";
  $("creditCurrency").value = "EUR";
  $("creditStartDate").value = "";
  $("creditMaturityDate").value = "";
  $("creditPortfolioId").value = "";
  $("creditHoldingId").innerHTML = `<option value="">Position auswählen</option>`;
  updateCreditForm();
  $("addCreditBtn").textContent = "Kredit speichern";
  $("cancelCreditEditBtn").classList.add("hidden");
}

function resetFutureForm() {

  editingFutureId = null;

  [
    "futureName",
    "futureEquity",
    "futureLeverage",
    "futurePnl",
    "futureNote"
  ].forEach(id => {
    $(id).value = "";
  });

  $("futureCurrency").value = "EUR";
  $("addFutureBtn").textContent = "Future speichern";
  $("cancelFutureEditBtn").classList.add("hidden");
}

function renderPortfolioChoices(containerId, portfolios, selectedIds = []) {
  const selected = new Set(selectedIds || []);
  const host = $(containerId);
  host.innerHTML = portfolios.map(p => `
    <label class="portfolio-choice">
      <input type="checkbox" value="${escapeHtml(p.id)}" ${selected.has(p.id) ? "checked" : ""}>
      <span>${escapeHtml(p.name)} <small>(${escapeHtml(p.currency)})</small></span>
    </label>
  `).join("");
}

function checkedPortfolioIds(containerId) {
  return [...$(containerId).querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
}

async function loadPortfolios() {
  const data = await api("/api/portfolios");
  const selectedIds = dashboard?.portfolioIds || [];
  renderPortfolioChoices("portfolioChoices", data.items || [], selectedIds);
  $("portfolioPicker").classList.remove("hidden");
}

async function loadProfilePortfolioOptions() {
  const data = await api("/api/portfolios");
  portfolioCatalog = data.items || [];
  renderPortfolioChoices("newProfilePortfolioChoices", portfolioCatalog, []);
  await loadProfiles();
}

function renderDataFreshness() {
  const el = $("dataFreshness");
  if (!el || !dashboard) return;

  const parqetTime = dashboard.parqetUpdatedAt
    ? new Date(dashboard.parqetUpdatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : "–";

  const fx = dashboard.fx || {};
  let fxText = "nicht benötigt";
  if (dashboard.futures?.some(f => f.currency !== "EUR")) {
    fxText = fx.date ? `${fx.date}${fx.stale ? " (Cache)" : ""}` : "nicht verfügbar";
  }

  el.textContent = `Datenstand · Parqet ${parqetTime} · ECB ${fxText}`;
}

function renderActiveProfilePortfolioManager(active) {
  const host = $("activeProfilePortfolioChoices");
  if (!host) return;

  const existing = new Set(active?.portfolioIds || []);
  const base = active?.portfolioIds?.[0];

  host.innerHTML = portfolioCatalog.map(p => `
    <label class="portfolio-choice${p.id === base ? " already-linked" : ""}">
      <input type="checkbox" value="${escapeHtml(p.id)}"
        ${existing.has(p.id) ? "checked" : ""}
        ${p.id === base ? "disabled" : ""}>
      <span>${escapeHtml(p.name)} <small>(${escapeHtml(p.currency)})</small>${p.id === base ? " · Basis" : ""}</span>
    </label>
  `).join("");
}

async function loadProfiles() {
  const data = await api("/api/profiles");
  const select = $("profileSelect");
  select.innerHTML = data.profiles.map(p =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
  ).join("");
  select.value = data.activeProfileId;

  const active = data.profiles.find(p => p.id === data.activeProfileId);
  if ($("activeProfileName")) $("activeProfileName").textContent = active?.name || "–";
  if ($("linkedPortfolioNames")) {
    const names = (active?.portfolioIds || []).map(id =>
      portfolioCatalog.find(p => p.id === id)?.name || id
    );
    $("linkedPortfolioNames").textContent = names.length ? names.join(" · ") : "Keine";
  }

  // Wenn die Portfolio-Pflege gerade aufgeklappt ist, muss sie beim
  // Profilwechsel/Neuanlegen ebenfalls sofort auf das aktive Profil wechseln.
  if ($("managePortfoliosArea") && !$("managePortfoliosArea").classList.contains("hidden")) {
    renderActiveProfilePortfolioManager(active);
  }

  return data;
}

$("profileSelect").addEventListener("change", async () => {
  try {
    await api(`/api/profiles/${encodeURIComponent($("profileSelect").value)}/activate`, { method: "POST" });
    dashboard = null;
    editingCreditId = null;
    editingFutureId = null;
    resetCreditForm();
    resetFutureForm();
    clearDashboardView();
    clearProfileSettingsView();
    const loaded = await loadDashboard();
    if (loaded) notice("Profil gewechselt.");
  } catch (e) { notice(e.message, true); await loadProfiles(); }
});

$("addProfileBtn").addEventListener("click", async () => {
  const name = $("newProfileName").value.trim();
  const portfolioIds = checkedPortfolioIds("newProfilePortfolioChoices");
  if (!name) return notice("Bitte einen Profilnamen eingeben.", true);
  if (!portfolioIds.length) return notice("Bitte mindestens ein Parqet-Portfolio für das neue Profil auswählen.", true);
  try {
    await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name, portfolioIds })
    });

    $("newProfileName").value = "";

    if (!portfolioCatalog.length) {
      const data = await api("/api/portfolios");
      portfolioCatalog = data.items || [];
    }
    renderPortfolioChoices("newProfilePortfolioChoices", portfolioCatalog, []);

    dashboard = null;
    editingCreditId = null;
    editingFutureId = null;
    resetCreditForm();
    resetFutureForm();
    clearDashboardView();

    await loadProfiles();
    await loadDashboard();
    notice("Neues Profil wurde angelegt und aktiviert.");
  } catch (e) { notice(e.message, true); }
});

$("managePortfoliosBtn").addEventListener("click", async () => {
  try {
    if (!portfolioCatalog.length) {
      const d = await api("/api/portfolios");
      portfolioCatalog = d.items || [];
    }

    const ps = await api("/api/profiles");
    const active = ps.profiles.find(p => p.id === ps.activeProfileId);

    $("managePortfoliosArea").classList.toggle("hidden");
    if (!$("managePortfoliosArea").classList.contains("hidden")) {
      renderActiveProfilePortfolioManager(active);
    }
  } catch(e) { notice(e.message, true); }
});
$("saveProfilePortfoliosBtn").addEventListener("click", async () => {
  const portfolioIds=[...$("activeProfilePortfolioChoices").querySelectorAll('input[type="checkbox"]')].filter(i=>i.checked).map(i=>i.value);
  try {
    await api(`/api/profiles/${encodeURIComponent($("profileSelect").value)}/portfolios`,{method:"PUT",body:JSON.stringify({portfolioIds})});
    $("managePortfoliosArea").classList.add("hidden"); await loadProfiles(); await loadDashboard(); notice("Portfolio-Zuordnung aktualisiert.");
  } catch(e){notice(e.message,true);}
});

$("renameProfileBtn").addEventListener("click", async () => {
  const select = $("profileSelect");
  const currentName = select.options[select.selectedIndex]?.text || "";
  const name = window.prompt("Neuer Profilname:", currentName);
  if (!name?.trim()) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(select.value)}`, {
      method: "PUT", body: JSON.stringify({ name: name.trim() })
    });
    await loadProfiles();
    notice("Profil wurde umbenannt.");
  } catch (e) { notice(e.message, true); }
});

$("deleteProfileBtn").addEventListener("click", async () => {
  const select = $("profileSelect");
  const name = select.options[select.selectedIndex]?.text || "dieses Profil";
  if (!window.confirm(`Profil "${name}" wirklich löschen?\n\nAlle lokalen Zuordnungen, Futures, Kredite und Einstellungen dieses Profils werden gelöscht.`)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(select.value)}`, { method: "DELETE" });
    await loadProfiles();
    await loadDashboard();
    notice("Profil wurde gelöscht.");
  } catch (e) { notice(e.message, true); }
});

function clearProfileSettingsView() {
  $("monthlyNeed").value = "";
  $("targetMonths").value = "";
  $("pot2Multiplier").value = "";
  $("firefishBorrowPercent").value = "";
  $("firefishTargetLtv").value = "";
}

function clearDashboardView() {
  ["bucket1","bucket2","bucket3","futureBlock","credits","holdingsTable","targetModel1","targetModel2","targetModel3"].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = "";
  });
  ["total1","total2","total3","assignedAssets","freeCreditLiquidity","creditUsed"].forEach(id => {
    const el = $(id);
    if (el) el.textContent = "–";
  });
  ["share1","share2","share3"].forEach(id => {
    const el = $(id);
    if (el) el.textContent = "–";
  });
  ["allocation1","allocation2","allocation3"].forEach(id => {
    const el = $(id);
    if (el) el.style.width = "0%";
  });
  const creditSummary = $("creditSummary");
  if (creditSummary) creditSummary.innerHTML = "";
  const freshness = $("dataFreshness");
  if (freshness) freshness.textContent = "Datenstand · Parqet – · ECB –";
}

function showParqetDisconnected(message = "Parqet-Verbindung getrennt. Bitte neu verbinden.") {
  dashboard = null;
  clearDashboardView();
  clearProfileSettingsView();
  $("disconnectBtn").classList.add("hidden");
  $("connectBtn").textContent = "Mit Parqet verbinden";
  $("parqetConnectionStatus").classList.remove("connected");
  $("parqetConnectionStatus").classList.add("disconnected");
  $("parqetConnectionStatusText").textContent = "Parqet getrennt";
  notice(message, true);
}

async function loadDashboard() {
  notice("");
  try {
    await loadProfiles();
    dashboard = await api(`/api/dashboard?_=${Date.now()}`);
    if (dashboard.needsPortfolio) {
      clearDashboardView();
      await loadPortfolios();
      return false;
    }

    renderLoadedDashboard();
    return true;
  } catch (e) {
    if (e.code === "PARQET_RECONNECT_REQUIRED" || e.status === 401) {
      showParqetDisconnected("Die Parqet-Autorisierung ist abgelaufen oder wurde widerrufen. Bitte Parqet neu verbinden.");
      return false;
    }

    if (e.status === 403) {
      dashboard = await api(`/api/dashboard?local=1&_=${Date.now()}`);
      renderLoadedDashboard();

      notice(
        "Für dieses Profil sind aktuell nicht alle benötigten Parqet-Portfolios freigegeben. " +
        "Parqet-Istdaten werden deshalb nicht angezeigt; lokale Planungsdaten bleiben verfügbar. " +
        "Bitte Parqet neu verbinden oder die Portfolio-Zuordnung des Profils anpassen.",
        true
      );
      return false;
    }
    dashboard = null;
    clearDashboardView();
    clearProfileSettingsView();
    notice(e.message, true);
    return false;
  }
}

function renderLoadedDashboard() {
  currency = dashboard.currency || "EUR";
  $("portfolioPicker").classList.add("hidden");

  populateCreditPortfolios();
  updateCreditForm();

  $("firefishBorrowPercent").value = dashboard.settings?.firefishBorrowPercent ?? "";
  $("firefishTargetLtv").value = dashboard.settings?.firefishTargetLtv ?? 30;
  $("monthlyNeed").value = dashboard.settings?.monthlyNeed || "";
  $("targetMonths").value = dashboard.settings?.targetMonths || "";
  $("pot2Multiplier").value = dashboard.settings?.pot2Multiplier ?? 2;

  renderDataFreshness();
  renderOverview();
  renderBucket(1);
  renderBucket(2);
  renderBucket(3);
  renderTargetModels();
  renderFutures();
  renderCredits();
  renderHoldings();
}

function showFirstRunWelcome(show) {
  $("firstRunWelcome").classList.toggle("hidden", !show);
  $("appHeader").classList.toggle("hidden", show);
  $("appMain").classList.toggle("hidden", show);
}

async function showFirstRunStage(connected) {
  showFirstRunWelcome(true);
  $("firstRunConnectStage").classList.toggle("hidden", connected);
  $("firstRunPortfolioStage").classList.toggle("hidden", !connected);
  $("setupStep1").classList.toggle("done", connected);
  $("setupStep2").classList.toggle("active", connected);

  if (connected) {
    const data = await api("/api/portfolios");
    renderPortfolioChoices("firstRunPortfolioChoices", data.items || [], []);
  }
}

async function init() {
  try {
    const status = await api("/api/status");
    currency = status.currency || "EUR";
    $("connectBtn").textContent = status.connected ? "Parqet neu verbinden" : "Mit Parqet verbinden";
    $("disconnectBtn").classList.toggle("hidden", !status.connected);
    $("parqetConnectionStatus").classList.toggle("connected", status.connected);
    $("parqetConnectionStatus").classList.toggle("disconnected", !status.connected);
    $("parqetConnectionStatusText").textContent = status.connected ? "Parqet verbunden" : "Parqet getrennt";
    if (!status.configured) {
      showFirstRunWelcome(false);
      notice("PARQET_CLIENT_ID fehlt. Bitte .env bzw. Startumgebung konfigurieren.", true);
      return;
    }
    if (status.firstRun) {
      await showFirstRunStage(status.connected);
      return;
    }
    showFirstRunWelcome(false);
    if (!status.connected) {
      await loadDashboard();
      notice(`Noch nicht mit Parqet verbunden. Lokale SLM-Daten bleiben verfügbar. Redirect-URI: ${status.redirectUri}`);
      return;
    }
    await loadDashboard();
  } catch (e) { notice(e.message, true); }
}
$("connectBtn").addEventListener("click", () => location.href="/auth/parqet");
$("firstRunConnectBtn").addEventListener("click", () => location.href="/auth/parqet");

$("completeFirstRunBtn").addEventListener("click", async () => {
  const portfolioIds = checkedPortfolioIds("firstRunPortfolioChoices");
  if (!portfolioIds.length) return notice("Bitte mindestens ein Portfolio auswählen.", true);

  const button = $("completeFirstRunBtn");
  try {
    button.disabled = true;
    button.textContent = "Richte ein …";

    await api("/api/setup/complete", {
      method: "POST",
      body: JSON.stringify({ portfolioIds })
    });

    $("setupStep2").classList.remove("active");
    $("setupStep2").classList.add("done");
    $("setupStep3").classList.add("done");
    showFirstRunWelcome(false);

    await loadDashboard();
    notice("Ersteinrichtung abgeschlossen. Profil „Default“ ist aktiv.");
  } catch (e) {
    notice(e.message, true);
    button.disabled = false;
    button.textContent = "Einrichtung abschließen";
  }
});

$("disconnectBtn").addEventListener("click", async () => {
  const ok = window.confirm(
    "Parqet-Verbindung wirklich trennen?\n\nLokale Profile, Zuordnungen, Futures und Kredite bleiben erhalten. Nur die lokale OAuth-Verbindung zu Parqet wird entfernt."
  );
  if (!ok) return;

  try {
    await api("/api/disconnect", { method: "POST" });
    dashboard = null;
    $("disconnectBtn").classList.add("hidden");
    $("connectBtn").textContent = "Mit Parqet verbinden";
    $("parqetConnectionStatus").classList.remove("connected");
    $("parqetConnectionStatus").classList.add("disconnected");
    $("parqetConnectionStatusText").textContent = "Parqet getrennt";
    notice("Parqet-Verbindung wurde getrennt. Lokale Planungsdaten bleiben erhalten.");
  } catch (e) {
    notice(e.message, true);
  }
});


$("refreshBtn").addEventListener("click", async () => {
  const button = $("refreshBtn");
  const oldText = button.textContent;

  button.disabled = true;
  button.textContent = "Aktualisiere …";

  try {
    await loadDashboard();

    button.textContent =
      "Aktualisiert " +
      new Date().toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

    setTimeout(() => {
      button.textContent = oldText;
    }, 3000);

  } catch (e) {
    button.textContent = "Fehler";

    setTimeout(() => {
      button.textContent = oldText;
    }, 3000);

  } finally {
    button.disabled = false;
  }
});

$("selectPortfolioBtn").addEventListener("click", async () => {
  const portfolioIds = checkedPortfolioIds("portfolioChoices");
  if (!portfolioIds.length) return notice("Bitte mindestens ein Portfolio auswählen.", true);
  await api("/api/select-portfolios", { method:"POST", body:JSON.stringify({ portfolioIds }) });
  $("portfolioPicker").classList.add("hidden");
  await loadDashboard();
});


$("addFutureBtn").addEventListener("click", async () => {

  try {
    //console.log("editingFutureId:", editingFutureId);
    await api("/api/futures", {
      method: "POST",
      body: JSON.stringify({

        id: editingFutureId,

        name: $("futureName").value,
        currency: $("futureCurrency").value,
        equity: $("futureEquity").value,
        leverage: $("futureLeverage").value,
        pnl: $("futurePnl").value,
        note: $("futureNote").value

      })
    });

    resetFutureForm();
    await loadDashboard();

  } catch (e) {

    notice(e.message, true);

  }

});


$("cancelFutureEditBtn")
  .addEventListener("click", resetFutureForm);

$("saveTargetSettingsBtn").addEventListener("click", async () => {
  const button = $("saveTargetSettingsBtn");
  const originalText = "Zielmodell speichern";
  try {
    button.disabled = true; button.textContent = "Speichere …";
    await api("/api/settings/targets", { method: "POST", body: JSON.stringify({ monthlyNeed: $("monthlyNeed").value, targetMonths: $("targetMonths").value, pot2Multiplier: $("pot2Multiplier").value }) });
    await loadDashboard();
    button.textContent = "Gespeichert ✓";
    notice(`Zielmodell gespeichert: ${money(dashboard.targetModel?.monthlyNeed || 0)} / Monat · ${num(dashboard.targetModel?.targetMonths || 0, 0)} Monate · Topf 2 ${num(dashboard.targetModel?.pot2Multiplier || 0, 1)}×.`);
    setTimeout(() => { button.textContent = originalText; button.disabled = false; }, 1400);
  } catch (e) { button.textContent = originalText; button.disabled = false; notice(e.message, true); }
});

$("saveFirefishSettingsBtn").addEventListener("click", async () => {
  const button = $("saveFirefishSettingsBtn");
  const originalText = "Parameter speichern";
  try {
    button.disabled = true;
    button.textContent = "Speichere …";

    await api("/api/settings/firefish", {
      method: "POST",
      body: JSON.stringify({
        borrowPercent: $("firefishBorrowPercent").value,
        targetLtv: $("firefishTargetLtv").value
      })
    });

    await loadDashboard();

    button.textContent = "Gespeichert ✓";
    notice(`Firefish-Parameter gespeichert: ${num(dashboard.settings?.firefishBorrowPercent || 0, 1)} % BTC-Anteil · ${num(dashboard.settings?.firefishTargetLtv || 0, 1)} % Ziel-LTV.`);

    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1400);
  } catch (e) {
    button.textContent = originalText;
    button.disabled = false;
    notice(e.message, true);
  }
});

$("importFirefishBtn").addEventListener("click", () => {
  $("firefishCsvFile").value = "";
  $("firefishCsvFile").click();
});

$("firefishCsvFile").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const csv = await file.text();
    const replace = window.confirm(
      "Firefish CSV importieren.\n\nOK = frühere CSV-Importe dieses Profils ersetzen (manuelle Firefish-Kredite bleiben erhalten)\nAbbrechen = nur neue Loan IDs importieren"
    );
    const mode = replace ? "replace" : "new";
    const result = await api("/api/credits/firefish/import", {
      method: "POST",
      body: JSON.stringify({ csv, mode })
    });
    await loadDashboard();
    notice(mode === "replace"
      ? `${result.imported} Firefish-Kredite aus CSV übernommen.`
      : `${result.imported} neue Firefish-Kredite importiert${result.skipped ? `, ${result.skipped} bekannte Loan IDs übersprungen` : ""}.`);
  } catch (e) {
    notice(e.message, true);
  }
});

$("addCreditBtn").addEventListener("click", async () => {

  try {

    await api("/api/credits", {
      method: "POST",
      body: JSON.stringify({

        id: editingCreditId,
        name: $("creditName").value,
        type: $("creditType").value,
        source: $("creditSource").value,
        portfolioId: $("creditPortfolioId").value,
        holdingId: $("creditHoldingId").value,
        activeAmount: $("creditUsedInput").value,
        limit: $("creditLimit").value,
        rate: $("creditRate").value,
        status: $("creditStatus").value,
        currency: $("creditCurrency").value,
        startDate: $("creditStartDate").value,
        maturityDate: $("creditMaturityDate").value,
        note: $("creditNote").value

      })
    });

    resetCreditForm();
    await loadDashboard();

  } catch (e) {

    notice(e.message, true);

  }

});


$("cancelCreditEditBtn")
  .addEventListener("click", resetCreditForm);


$("shutdownAppBtn").addEventListener("click", async () => {
  const ok = window.confirm(
    "Strategic Liquidity Manager wirklich beenden?\n\n" +
    "Der lokale Server wird beendet. Zum erneuten Start die Anwendung wieder über das Menü bzw. launch.cmd öffnen."
  );
  if (!ok) return;

  const button = $("shutdownAppBtn");
  button.disabled = true;
  button.textContent = "Beende …";
  try {
    await api("/api/app/shutdown", { method: "POST" });
    document.body.innerHTML = `<main class="shell"><section class="panel"><h2>Strategic Liquidity Manager beendet</h2><p>Der lokale Server wurde beendet. Dieses Browserfenster kann jetzt geschlossen werden.</p></section></main>`;
  } catch (e) {
    button.disabled = false;
    button.textContent = "Anwendung beenden";
    notice(e.message, true);
  }
});

$("exportConfigBtn").addEventListener("click", async () => {
  try {
    const backup = await api("/api/config/export");
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `parqet-risk-pots-backup-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    notice("Konfiguration wurde exportiert.");
  } catch (e) {
    notice(e.message, true);
  }
});

$("importConfigBtn").addEventListener("click", () => {
  $("importConfigFile").value = "";
  $("importConfigFile").click();
});

$("importConfigFile").addEventListener("change", async () => {
  const file = $("importConfigFile").files?.[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== "parqet-risk-pots-backup" || backup?.version !== 1 || !backup?.data) {
      throw new Error("Die Datei ist kein unterstütztes Risk-Pots-Backup.");
    }
    const assignments = Object.keys(backup.data.assignments || {}).length;
    const futures = Array.isArray(backup.data.futures) ? backup.data.futures.length : 0;
    const credits = Array.isArray(backup.data.credits) ? backup.data.credits.length : 0;
    const exportedAt = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString("de-DE") : "unbekannt";

    const ok = window.confirm(
      `Risk-Pots-Konfiguration wiederherstellen?\n\n` +
      `Backup vom: ${exportedAt}\n` +
      `Zuordnungen: ${assignments}\nFutures: ${futures}\nKredite: ${credits}\n\n` +
      `Die aktuelle lokale Konfiguration wird vollständig ersetzt. OAuth-Tokens bleiben unverändert.`
    );
    if (!ok) return;

    await api("/api/config/import", { method: "POST", body: JSON.stringify(backup) });
    resetFutureForm();
    resetCreditForm();
    await loadDashboard();
    notice("Konfiguration wurde erfolgreich wiederhergestellt.");
  } catch (e) {
    notice(`Import fehlgeschlagen: ${e.message}`, true);
  } finally {
    $("importConfigFile").value = "";
  }
});

$("toggleManagementBtn").addEventListener("click", async () => {
  const area = $("managementArea");
  const button = $("toggleManagementBtn");
  const willShow = area.classList.contains("hidden");

  area.classList.toggle("hidden", !willShow);
  button.setAttribute("aria-expanded", String(willShow));
  button.textContent = willShow
    ? "Verwaltung ausblenden ▲"
    : "Verwaltung anzeigen ▼";

  if (willShow) {
    try { await loadProfilePortfolioOptions(); }
    catch (e) { notice(e.message, true); }
  }
});
$("creditType").addEventListener("change", updateCreditForm);
$("creditType").addEventListener("change", updateCreditForm);
$("creditSource").addEventListener("change", () => {
  updateCreditForm();
  if ($("creditSource").value !== "parqet") {
    $("creditHoldingId").innerHTML = `<option value="">Position auswählen</option>`;
  }
});
$("creditPortfolioId").addEventListener("change", async () => {
  try {
    await loadCreditHoldings($("creditPortfolioId").value);
  } catch (e) { notice(e.message, true); }
});

init();
