(function () {
  const charts = {};
  window.ttWebCharts = charts;

  const palette = ["#0f766e", "#2563eb", "#b7791f", "#be4458", "#4d7c0f", "#7c3aed", "#0e7490", "#a16207"];

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function params() {
    return new URLSearchParams(window.location.search);
  }

  function getRange() {
    const select = qs("#range");
    return (select && select.value) || params().get("range") || "30d";
  }

  function setParam(key, value) {
    const next = params();
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    const query = next.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : ""));
    updateNavLinks();
  }

  function updateNavLinks() {
    const range = getRange();
    qsa("[data-nav]").forEach((link) => {
      const url = new URL(link.getAttribute("href"), window.location.origin);
      url.searchParams.set("range", range);
      link.href = url.pathname + url.search;
      const current = url.pathname === window.location.pathname;
      link.setAttribute("aria-current", current ? "page" : "false");
    });
  }

  async function api(path, query) {
    const url = new URL(path, window.location.origin);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => url.searchParams.append(key, item));
      } else if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  function bindShell(load) {
    const range = qs("#range");
    const requested = params().get("range");
    if (range && requested) {
      range.value = requested;
    }
    if (range) {
      range.addEventListener("change", () => {
        setParam("range", range.value);
        load();
      });
    }
    const refresh = qs("#refresh");
    if (refresh) {
      refresh.addEventListener("click", () => withRefresh(refresh, load));
    }
    updateNavLinks();
  }

  async function withRefresh(button, load) {
    const label = button.textContent;
    const wasDisabled = button.disabled;
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    button.textContent = "⟳ Refreshing";
    try {
      await load();
    } finally {
      button.textContent = label;
      button.setAttribute("aria-busy", "false");
      button.disabled = wasDisabled;
    }
  }

  function money(value) {
    if (value === null || value === undefined) {
      return "—";
    }
    return "$" + Number(value).toFixed(2);
  }

  function moneyPrecise(value) {
    if (value === null || value === undefined) {
      return "—";
    }
    return "$" + Number(value).toFixed(4);
  }

  function integer(value) {
    return Number(value || 0).toLocaleString();
  }

  function pct(value) {
    if (value === null || value === undefined) {
      return "—";
    }
    return Math.round(Number(value)) + "%";
  }

  function shortText(value, length) {
    const text = String(value || "");
    if (text.length <= length) {
      return text;
    }
    return "…" + text.slice(text.length - length + 1);
  }

  function chart(key, canvasId, config) {
    const canvas = qs("#" + canvasId);
    if (!canvas || !window.Chart) {
      return null;
    }
    if (charts[key]) {
      charts[key].destroy();
    }
    charts[key] = new Chart(canvas, config);
    return charts[key];
  }

  function dataset(label, data, index, extra) {
    return Object.assign(
      {
        label,
        data,
        borderColor: palette[index % palette.length],
        backgroundColor: palette[index % palette.length],
        borderWidth: 2,
        tension: 0.25,
      },
      extra || {}
    );
  }

  function chartOptions(extra) {
    return Object.assign(
      {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom" },
          tooltip: { enabled: true },
        },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true },
        },
      },
      extra || {}
    );
  }

  function renderOverview(data) {
    qs("#today-cost").textContent = money(data.today.cost_usd);
    qs("#today-tokens").textContent = integer(data.today.tokens) + " tokens";
    qs("#week-cost").textContent = money(data.week.cost_usd);
    qs("#week-tokens").textContent = integer(data.week.tokens) + " tokens";
    renderProviderQuota("claude", data.rate_limits.claude);
    renderProviderQuota("codex", data.rate_limits.codex);

    chart("dailyCost", "daily-cost-chart", {
      type: "line",
      data: {
        labels: data.daily_cost_30d.map((row) => row.date),
        datasets: [
          dataset("Claude Code", data.daily_cost_30d.map((row) => row.claude_cost), 0, { fill: false }),
          dataset("Codex", data.daily_cost_30d.map((row) => row.codex_cost), 1, { fill: false }),
        ],
      },
      options: chartOptions(),
    });

    chart("topProjects", "top-projects-chart", {
      type: "bar",
      data: {
        labels: data.top_projects_week.map((row) => shortText(row.project, 42)),
        datasets: [dataset("Cost", data.top_projects_week.map((row) => row.cost_usd), 2)],
      },
      options: chartOptions({ indexAxis: "y" }),
    });

    chart("modelMix", "model-mix-chart", {
      type: "bar",
      data: {
        labels: ["This month"],
        datasets: data.model_mix_month.slice(0, 8).map((row, index) =>
          dataset(row.model, [row.tokens], index, { stack: "tokens" })
        ),
      },
      options: chartOptions({ scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }),
    });
  }

  function resetText(epoch) {
    if (!epoch) {
      return "—";
    }
    const resetAt = new Date(epoch * 1000);
    if (resetAt.getTime() < Date.now()) {
      return "reset passed " + resetAt.toLocaleString();
    }
    return "resets " + resetAt.toLocaleString();
  }

  function renderProviderQuota(provider, block) {
    qs(`#${provider}-five-hour`).textContent = pct(block?.five_hour_pct);
    qs(`#${provider}-five-reset`).textContent = resetText(block?.five_hour_resets_at);
    qs(`#${provider}-seven-day`).textContent = pct(block?.seven_day_pct);
    qs(`#${provider}-seven-reset`).textContent = resetText(block?.seven_day_resets_at);

    const updated = updatedText(block?.updated_at);
    qs(`#${provider}-five-updated`).textContent = updated;
    qs(`#${provider}-seven-updated`).textContent = updated;
  }

  function updatedText(iso) {
    if (!iso) {
      return "no data";
    }
    const updatedAt = new Date(iso).getTime();
    if (Number.isNaN(updatedAt)) {
      return "no data";
    }
    const diffMs = Date.now() - updatedAt;
    if (diffMs < 0) {
      return "just now";
    }
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) {
      return "just now";
    }
    if (mins < 60) {
      return `updated ${mins}m ago`;
    }
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
      return `updated ${hours}h ago`;
    }
    return `updated ${Math.floor(hours / 24)}d ago`;
  }

  async function initNetwork() {
    async function load(force) {
      try {
        const data = await api("/api/network", force ? { force: "1" } : {});
        renderNetwork(data, () => load(true));
      } catch (error) {
        renderNetwork({
          error: error && error.message ? error.message : String(error),
          verdict: "unknown",
        }, () => load(true));
      }
    }
    const refresh = qs("#refresh");
    if (refresh) {
      refresh.addEventListener("click", () => withRefresh(refresh, () => load(true)));
    }
    updateNavLinks();
    await load(false);
  }

  function renderNetwork(data, retry) {
    renderNetworkBanner(data);
    if (data.installed === false) {
      renderNetworkError({
        title: "ip-check is not installed. Run tt-web/install.sh.",
        message: data.hint || data.error || "Install the ip-check wrapper before using /network.",
        docs: true,
      }, retry);
      setNetworkCardsUnavailable("ip-check is not installed.");
      return;
    }
    if (data.error) {
      renderNetworkError({
        title: "Network check failed",
        message: data.error,
        retry: true,
      }, retry);
      setNetworkCardsUnavailable("Network check failed.");
      return;
    }
    clearNetworkError();
    renderLocalNetwork(data);
    renderPublicNetwork(data);
    renderRiskNetwork(data);
    renderTimezoneNetwork(data);
    renderConclusions(data);
  }

  function renderNetworkBanner(data) {
    const banner = qs("#network-banner");
    const verdict = qs("#network-verdict");
    const updated = qs("#network-updated");
    const level = data.verdict || "unknown";
    banner.className = `verdict-banner ${level === "high" ? "high" : level === "low" ? "low" : level === "proxy-in-use" ? "proxy-in-use" : "unknown"}`;
    if (data.installed === false) {
      verdict.textContent = "—";
      updated.textContent = "Cause: ip-check is not installed";
      return;
    } else if (data.error) {
      verdict.textContent = "—";
      updated.textContent = `Cause: ${data.error}`;
      return;
    } else if (level === "high") {
      verdict.textContent = "High risk for Claude use";
    } else if (level === "proxy-in-use") {
      verdict.textContent = "Claude usable, but proxy is in use";
    } else if (level === "low") {
      verdict.textContent = "Low risk for Claude use";
    } else {
      verdict.textContent = "Network status unknown";
    }
    updated.textContent = data.timestamp ? `Last updated ${formatDate(data.timestamp)}` : "—";
  }

  function renderNetworkError(error, retry) {
    const panel = qs("#network-error");
    if (!panel) {
      return;
    }
    const docsLink = error.docs ? '<a href="/ip-check-docs">Docs</a>' : "";
    const retryButton = error.retry ? '<button type="button" data-network-retry>Retry</button>' : "";
    const actions = [docsLink, retryButton].filter(Boolean).join("");
    panel.hidden = false;
    panel.innerHTML = [
      `<h2>${escapeHtml(error.title)}</h2>`,
      `<p>${escapeHtml(error.message || "Unknown error")}</p>`,
      actions ? `<div class="network-error-actions">${actions}</div>` : "",
    ].join("");
    const button = panel.querySelector("[data-network-retry]");
    if (button && retry) {
      button.addEventListener("click", () => withRefresh(button, retry));
    }
  }

  function clearNetworkError() {
    const panel = qs("#network-error");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  function setNetworkCardsUnavailable(message) {
    const html = `<div class="section-failure">${escapeHtml(message)}</div>`;
    ["local", "public", "risk", "timezone", "conclusion"].forEach((id) => {
      qs(`#network-${id}`).innerHTML = html;
    });
  }

  function renderLocalNetwork(data) {
    const local = data.local;
    if (!local) {
      renderSectionFailure("#network-local", data, "local");
      return;
    }
    const ipv6 = local.ipv6_leaked ? statusPill("bad", local.ipv6 || "leaked") : statusPill("ok", "disabled");
    const dns = local.dns && local.dns.length ? local.dns.map(renderDns).join("") : "—";
    qs("#network-local").innerHTML = [
      kvRow("LAN IP", escapeHtml(local.lan_ip || "—")),
      kvRow("IPv6", ipv6),
      kvRow("DNS servers", `<div class="dns-list">${dns}</div>`),
      kvRow("DNS region", local.dns_has_cn ? statusPill("bad", "CN resolver detected") : statusPill("ok", "no CN resolver")),
    ].join("");
  }

  function renderPublicNetwork(data) {
    const pub = data.public;
    if (!pub || pub.ok === false) {
      renderSectionFailure("#network-public", data, "public", pub && pub.error);
      return;
    }
    const location = [pub.country, pub.region, pub.city].filter(Boolean).join(" / ") || "—";
    const timezone = pub.timezone ? `${escapeHtml(pub.timezone)} (${escapeHtml(pub.tz_offset || "—")})` : "—";
    qs("#network-public").innerHTML = [
      kvRow("IP", escapeHtml(pub.ip || "—")),
      kvRow("Location", escapeHtml(location)),
      kvRow("ISP", escapeHtml(pub.isp || "—")),
      kvRow("Org", escapeHtml(pub.org || "—")),
      kvRow("Timezone", timezone),
    ].join("");
  }

  function renderRiskNetwork(data) {
    const pub = data.public || {};
    const risk = data.risk;
    const spam = data.spam;
    const proxyEnvEntries = Object.entries(data.proxy_envs || {});
    const score = risk && risk.score !== null && risk.score !== undefined
      ? statusPill(risk.level === "high" ? "bad" : risk.level === "medium" ? "warn" : "ok", `${risk.score}/100 ${risk.level}`)
      : statusPill("warn", sectionMessage(data, "risk") || "not queried");
    const type = risk && risk.type ? escapeHtml(risk.type) : "—";
    const markedProxy = Boolean(pub.proxy || (risk && risk.marked_proxy));
    const spamParsed = spam && (
      spam.score !== null && spam.score !== undefined ||
      spam.frequency !== null && spam.frequency !== undefined ||
      spam.last_seen
    );
    const spamFallback = spam && spam.raw_lines && spam.raw_lines.length
      ? spam.raw_lines.map(escapeHtml).join("<br>")
      : "";
    const spamScore = spamParsed && spam.score !== null && spam.score !== undefined
      ? statusPill(spam.level === "high" ? "bad" : spam.level === "medium" ? "warn" : "ok", `${spam.score}/100 ${spam.level || ""}`.trim())
      : spamFallback || sectionMessage(data, "spam") || "—";
    const spamReports = spamParsed && spam.frequency !== null && spam.frequency !== undefined
      ? escapeHtml(spam.frequency)
      : "—";
    const lastSpamReport = spamParsed && spam.last_seen ? escapeHtml(spam.last_seen) : "—";
    const envs = proxyEnvEntries.length
      ? proxyEnvEntries.map(([key, value]) => `${escapeHtml(key)} = ${escapeHtml(value)}`).join("<br>")
      : "—";
    qs("#network-risk").innerHTML = [
      kvRow("Risk score (proxycheck)", score),
      kvRow("Type (proxycheck)", type),
      kvRow("Marked proxy (ip-api / proxycheck)", markedProxy ? statusPill("warn", "yes") : statusPill("ok", "no")),
      kvRow("Hosting (ip-api)", pub.hosting ? statusPill("warn", "yes") : statusPill("ok", "no")),
      kvRow("Spam score (stopforumspam)", spamScore),
      kvRow("Spam reports (stopforumspam)", spamReports),
      kvRow("Last spam report", lastSpamReport),
      kvRow("Proxy envs (local shell)", envs),
    ].join("");
  }

  function renderTimezoneNetwork(data) {
    const tz = data.tz_check;
    const pub = data.public || {};
    if (!tz) {
      renderSectionFailure("#network-timezone", data, "tz_check");
      return;
    }
    const match = tz.matched === true
      ? statusPill("ok", tz.match_label || "matched")
      : tz.matched === false
        ? statusPill("bad", tz.match_label || "mismatch")
        : statusPill("warn", "not comparable");
    qs("#network-timezone").innerHTML = [
      kvRow("CLI timezone", `${escapeHtml(tz.cli_tz || "—")} (${escapeHtml(tz.cli_offset || "—")})`),
      kvRow("Public timezone", pub.timezone ? `${escapeHtml(pub.timezone)} (${escapeHtml(pub.tz_offset || "—")})` : "—"),
      kvRow("Match", match),
    ].join("");
  }

  function renderConclusions(data) {
    const items = data.conclusions || [];
    const note = '<p class="conclusion-note">Verdict: HIGH if any of IPv6 leak / CN DNS / risk score &gt;= 70 / TZ mismatch. PROXY-IN-USE if proxy detected but no high signals. Otherwise LOW.</p>';
    if (!items.length) {
      qs("#network-conclusion").innerHTML = `<div class="empty-state">—</div>${note}`;
      return;
    }
    qs("#network-conclusion").innerHTML = `<ul class="conclusion-list">${items.map((item) => {
      const kind = item.level === "bad" ? "bad" : item.level === "warn" ? "warn" : "ok";
      return `<li>${statusPill(kind, item.level)} <span>${escapeHtml(item.text)}</span></li>`;
    }).join("")}</ul>${note}`;
  }

  function renderSectionFailure(selector, data, section, fallback) {
    const message = fallback || sectionMessage(data, section) || "unknown";
    qs(selector).innerHTML = `<div class="section-failure">${statusPill("warn", "Query failed")} ${escapeHtml(message)}</div>`;
  }

  function sectionMessage(data, section) {
    const error = (data.errors || []).find((item) => item.section === section);
    return error && error.message;
  }

  function kvRow(label, value) {
    return `<div class="kv-row"><div class="label">${escapeHtml(label)}</div><div class="value">${value}</div></div>`;
  }

  function renderDns(entry) {
    const country = entry.country ? ` ${statusPill(entry.country === "CN" ? "bad" : "ok", entry.country)}` : "";
    const label = entry.label ? ` <span class="muted">${escapeHtml(entry.label)}</span>` : "";
    return `<div class="dns-row"><span>${escapeHtml(entry.ip)}</span>${label}${country}</div>`;
  }

  function statusPill(kind, text) {
    return `<span class="status-pill ${kind}">${escapeHtml(text)}</span>`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  async function initOverview() {
    async function load() {
      const data = await api("/api/overview", { range: getRange() });
      renderOverview(data);
    }
    bindShell(load);
    await load();
  }

  async function initSessions() {
    async function load() {
      const data = await api("/api/sessions", {
        range: getRange(),
        sort: qs("#sort") ? qs("#sort").value : "time",
        order: "desc",
      });
      renderSessions(data);
    }
    bindShell(load);
    const sort = qs("#sort");
    if (sort) {
      sort.addEventListener("change", load);
    }
    await load();
  }

  function renderSessions(rows) {
    const tbody = qs("#sessions-body");
    tbody.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.className = "session-row";
      tr.dataset.sessionId = row.session_id;
      tr.innerHTML = `
        <td><span class="pill">${escapeHtml(row.agent_id)}</span></td>
        <td>${escapeHtml(shortText(row.project, 54))}</td>
        <td>${escapeHtml(row.model)}${row.estimated ? ' <span class="muted">推算</span>' : ""}</td>
        <td>${new Date(row.started_at).toLocaleString()}</td>
        <td class="numeric">${moneyPrecise(row.cost_usd)}</td>
        <td class="numeric">${integer(row.tokens)}</td>
        <td class="numeric">${integer(row.messages)}</td>
      `;
      tr.addEventListener("click", () => toggleSession(tr));
      tbody.appendChild(tr);
    });
    qs("#session-count").textContent = integer(rows.length) + " sessions";
  }

  async function toggleSession(row) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains("turn-detail")) {
      next.remove();
      return;
    }
    qsa(".turn-detail").forEach((detail) => detail.remove());
    const detail = await api("/api/session/" + encodeURIComponent(row.dataset.sessionId));
    const tr = document.createElement("tr");
    tr.className = "turn-detail";
    tr.innerHTML = `<td colspan="7">${renderTurnList(detail.entries)}</td>`;
    row.after(tr);
  }

  function renderTurnList(entries) {
    const items = entries
      .map(
        (entry) => `<li>
          <span>${new Date(entry.timestamp).toLocaleString()}</span>
          <span>${escapeHtml(entry.model)}</span>
          <span>${integer(entry.input_tokens)} in</span>
          <span>${integer(entry.output_tokens)} out</span>
          <span>${moneyPrecise(entry.cost_usd)}</span>
        </li>`
      )
      .join("");
    return `<ul class="turn-list">${items}</ul>`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.TTWeb = {
    api,
    bindShell,
    chart,
    chartOptions,
    dataset,
    getRange,
    integer,
    money,
    moneyPrecise,
    params,
    palette,
    qsa,
    qs,
    setParam,
    shortText,
    initNetwork,
    initOverview,
    initSessions,
  };
})();
