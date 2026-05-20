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
    button.setAttribute("aria-busy", "true");
    button.textContent = "⟳ Refreshing";
    try {
      await load();
    } finally {
      button.textContent = label;
      button.setAttribute("aria-busy", "false");
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
    initOverview,
    initSessions,
  };
})();
