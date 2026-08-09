(function () {
  const charts = {};
  window.ttWebCharts = charts;

  // Eight categorical slots, assigned in fixed order and never cycled. Validated
  // against this dashboard's white panel surface on the adjacent pairlist that
  // lines, bars and stacks use: worst CVD ΔE 9.1 (protan), worst normal-vision
  // ΔE 19.6. The previous set put claude-opus-5 (#0f766e) and claude-sonnet-5
  // (#0e7490) at ΔE 5.8 — the same legend, indistinguishable to full colour
  // vision — and paired violet with blue at ΔE 0.4 under deuteranopia.
  // Slots 3, 4 and 5 fall below 3:1 against white, so any chart that reaches
  // them owes the reader direct labels or a table view beside it.
  const palette = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  // A ninth series is not a generated hue: callers fold the tail into "Other".
  const OTHER_COLOR = "#8a8a80";
  const rangeDays = { "7d": 7, "30d": 30, "90d": 90, "6m": 180, "1y": 365, "2y": 730 };

  // Absolute timestamps are rendered in the timezone the server (this machine)
  // currently resolves from its OS/TZ setting — never a hardcoded zone, and never
  // the browser's own zone (which can be a stale value cached at browser startup).
  // The server reads the live setting per request, so the display can't drift from
  // the actual system configuration. Until the server's zone is fetched, fall back
  // to the browser's local zone.
  let serverTimeZone = null;

  let _timezonePromise = null;
  function ensureTimezone() {
    if (!_timezonePromise) {
      _timezonePromise = fetch(new URL("/api/timezone", window.location.origin))
        .then((response) => (response.ok ? response.json() : null))
        .then((json) => {
          if (json && typeof json.timezone === "string") {
            serverTimeZone = json.timezone;
          }
        })
        .catch(() => {});
    }
    return _timezonePromise;
  }

  function fmtAbs(date) {
    const opts = serverTimeZone ? { timeZone: serverTimeZone } : undefined;
    try {
      const main = date.toLocaleString(undefined, opts);
      const part = new Intl.DateTimeFormat("en-US", Object.assign({ timeZoneName: "shortOffset" }, opts))
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName");
      return part ? main + " " + part.value : main;
    } catch (e) {
      return date.toLocaleString();
    }
  }

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

  function autoTimeDim(range) {
    if (range === "all") {
      return "month";
    }
    const days = rangeDays[range] || 30;
    if (days <= 90) {
      return "day";
    }
    if (days <= 365) {
      return "week";
    }
    return "month";
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
    qsa("[data-preserve-range]").forEach((link) => {
      const url = new URL(link.getAttribute("href"), window.location.origin);
      url.searchParams.set("range", range);
      link.href = url.pathname + url.search;
    });
  }

  async function api(path, query) {
    const tzReady = ensureTimezone();
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
    const json = await response.json();
    await tzReady;
    return json;
  }

  function bindShell(load, options) {
    const range = qs("#range");
    const bindRange = !options || options.range !== false;
    const requested = params().get("range");
    if (range && requested) {
      range.value = requested;
    }
    if (range && bindRange) {
      range.addEventListener("change", () => {
        setParam("range", range.value);
        load(false);
      });
    }
    const refresh = qs("#refresh");
    if (refresh) {
      refresh.addEventListener("click", () => withRefresh(refresh, () => load(true)));
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

  // Axis ticks and bar-end labels read as magnitudes, not as digit strings:
  // 20,000,000,000 costs a reader a digit count that "20B" does not.
  function compactNumber(value) {
    const n = Number(value || 0);
    const abs = Math.abs(n);
    if (abs >= 1e9) {
      return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
    }
    if (abs >= 1e6) {
      return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    }
    if (abs >= 1e3) {
      return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    }
    return String(Math.round(n));
  }

  // Values printed at the end of each bar. Three of the eight categorical slots
  // sit below 3:1 against the white panel, and that debt is only discharged by
  // labels the reader can see or a table beside the chart — so horizontal bar
  // charts here carry their values rather than relying on the axis alone.
  // The formatter is captured in a closure rather than read back off
  // `chart.options`: Chart.js resolves option values through a proxy that
  // treats a function as a scriptable option, and looking one up by name from
  // inside the plugin resolves to itself ("Recursion detected").
  function barValueLabels(format) {
    return {
      id: "barValueLabels",
      afterDatasetsDraw(instance) {
        const { ctx } = instance;
        ctx.save();
        // Read the label's face and colour from the stylesheet rather than
        // copying them here: a hard-coded copy silently diverges from the UI
        // labels beside it the next time the visual system changes.
        const rootStyle = getComputedStyle(document.documentElement);
        const numFace = rootStyle.getPropertyValue("--font-sans").trim() ||
          getComputedStyle(document.body).fontFamily;
        ctx.font = "600 12px " + numFace;
        ctx.fillStyle = rootStyle.getPropertyValue("--ink-muted").trim() || "#57616c";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        instance.data.datasets.forEach((set, setIndex) => {
          const meta = instance.getDatasetMeta(setIndex);
          if (meta.hidden) {
            return;
          }
          meta.data.forEach((element, pointIndex) => {
            const value = set.data[pointIndex];
            if (value === null || value === undefined) {
              return;
            }
            ctx.fillText(format(value), element.x + 8, element.y);
          });
        });
        ctx.restore();
      },
    };
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

  function seriesColor(index) {
    return palette[index] || OTHER_COLOR;
  }

  function dataset(label, data, index, extra) {
    return Object.assign(
      {
        label,
        data,
        borderColor: seriesColor(index),
        backgroundColor: seriesColor(index),
        borderWidth: 2,
        // Straight segments: smoothing a cost series draws intermediate values
        // between samples that were never spent.
        tension: 0,
      },
      extra || {}
    );
  }

  const SERIES_LIMIT = palette.length;

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

  function renderOverview(data, selectedRange) {
    qs("#today-cost").textContent = money(data.today.cost_usd);
    qs("#today-tokens").textContent = integer(data.today.tokens) + " tokens";
    qs("#week-cost").textContent = money(data.week.cost_usd);
    if (data.week.window && data.week.window.start && data.week.window.end) {
      const start = new Date(data.week.window.start);
      const end = new Date(data.week.window.end);
      qs("#week-tokens").textContent = `${integer(data.week.tokens)} tokens · 周一 ${fmtAbs(start)} → ${fmtAbs(end)}`;
    } else {
      qs("#week-tokens").textContent = integer(data.week.tokens) + " tokens";
    }
    renderProviderQuota("claude", data.rate_limits.claude);
    renderProviderQuota("codex", data.rate_limits.codex);

    const costHistory = data.cost_over_time || legacyCostHistory(data.daily_cost_30d || []);
    const costGranularity = data.cost_over_time_granularity || "day";
    chart("dailyCost", "daily-cost-chart", {
      type: "line",
      data: {
        labels: costHistory.rows.map((row) => row.x),
        datasets: costHistory.columns.map((column, index) =>
          dataset(agentLabel(column), costHistory.rows.map((row) => row.values[column]), index, {
            fill: false,
            spanGaps: true,
          })
        ),
      },
      options: chartOptions(),
    });
    const costMeta = qs("#cost-over-time-meta");
    if (costMeta) {
      costMeta.textContent = `${rangeLabel(selectedRange || getRange())} · ${costGranularity} buckets · historical rollup`;
    }
    const coverage = qs("#cost-over-time-coverage");
    if (coverage) {
      const earliest = data.rollup_coverage && data.rollup_coverage.earliest_date;
      if (earliest && data.rollup_coverage.partial_before_range) {
        coverage.hidden = false;
        coverage.textContent = `历史自 ${earliest} 起累积；更早未采集。`;
      } else {
        coverage.hidden = true;
        coverage.textContent = "";
      }
    }
    const costLink = qs("#cost-over-time-link");
    if (costLink) {
      const url = new URL("/explore", window.location.origin);
      url.searchParams.set("range", selectedRange || getRange());
      url.searchParams.set("x", costGranularity);
      url.searchParams.set("group", "agent");
      url.searchParams.set("metric", "cost");
      costLink.href = url.pathname + url.search;
    }

    const projects = data.top_projects_week.slice();
    chart("topProjects", "top-projects-chart", {
      type: "bar",
      data: {
        labels: projects.map((row) => projectLabel(row.project)),
        datasets: [dataset("Cost", projects.map((row) => row.cost_usd), 0)],
      },
      options: chartOptions({
        indexAxis: "y",
        // One series: the panel heading already names it, so a legend box would
        // only repeat the title. Bar ends carry the values instead.
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (items) => projects[items[0].dataIndex].project } },
        },
        scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false } } },
        layout: { padding: { right: 64 } },
      }),
      plugins: [barValueLabels(money)],
    });

    // Model mix is a magnitude comparison across models. Stacking eight series
    // onto a single "This month" column made five of them thinner than a pixel
    // while each still claimed a legend entry; ranked horizontal bars let every
    // model be read and compared directly.
    const mix = data.model_mix_month.slice().sort((a, b) => Number(b.tokens) - Number(a.tokens));
    chart("modelMix", "model-mix-chart", {
      type: "bar",
      data: {
        labels: mix.map((row) => row.model),
        datasets: [dataset("Tokens", mix.map((row) => row.tokens), 0)],
      },
      options: chartOptions({
        indexAxis: "y",
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { callback: (value) => compactNumber(value) } },
          y: { ticks: { autoSkip: false } },
        },
        layout: { padding: { right: 64 } },
      }),
      plugins: [barValueLabels(compactNumber)],
    });
  }

  // Project identifiers share a long host-and-owner prefix, so truncating from
  // the left kept "hub.com/" and dropped the part that tells them apart. Keep
  // the trailing segments; the full path stays available in the tooltip.
  function projectLabel(value) {
    const parts = String(value || "").split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return tail.length > 34 ? tail.slice(0, 33) + "…" : tail;
  }

  function legacyCostHistory(rows) {
    return {
      columns: ["claude-code", "codex"],
      rows: rows.map((row) => ({
        x: row.date,
        values: {
          "claude-code": row.claude_cost,
          codex: row.codex_cost,
        },
      })),
    };
  }

  function agentLabel(column) {
    if (column === "claude-code") {
      return "Claude Code";
    }
    if (column === "codex") {
      return "Codex";
    }
    return column || "value";
  }

  function rangeLabel(value) {
    const labels = {
      "7d": "7d",
      "30d": "30d",
      "90d": "90d",
      "6m": "6m",
      "1y": "1y",
      "2y": "2y",
      all: "All history",
    };
    return labels[value] || value || "30d";
  }

  function resetText(epoch) {
    if (!epoch) {
      return "—";
    }
    const resetAt = new Date(epoch * 1000);
    if (resetAt.getTime() < Date.now()) {
      return "reset passed " + fmtAbs(resetAt);
    }
    return "resets " + fmtAbs(resetAt);
  }

  function renderProviderQuota(provider, block) {
    const fiveHour = qs(`#${provider}-five-hour`);
    if (fiveHour) {
      fiveHour.textContent = pct(block?.five_hour_pct);
      qs(`#${provider}-five-reset`).textContent = resetText(block?.five_hour_resets_at);
      qs(`#${provider}-five-updated`).textContent = quotaSourceText(block);
    }
    qs(`#${provider}-seven-day`).textContent = pct(block?.seven_day_pct);
    qs(`#${provider}-seven-reset`).textContent = resetText(block?.seven_day_resets_at);
    qs(`#${provider}-seven-updated`).textContent = quotaSourceText(block);
  }

  function quotaSourceText(block) {
    if (!block || !block.updated_at) {
      return `unavailable · ${block?.unavailable_reason || "no admitted source"}`;
    }
    const source = block.source_machine ? ` · from ${block.source_machine}` : "";
    return updatedText(block.updated_at) + source;
  }

  function renderSyncStatus(status) {
    const coverageElement = qs("#sync-coverage");
    const summaryElement = qs("#sync-summary");
    const machineList = qs("#sync-machines");
    if (!coverageElement || !summaryElement || !machineList || !status) {
      return;
    }
    pageServerInstance = status.instance_id || pageServerInstance;
    const coverage = status.coverage || { admitted: 0, declared: 0 };
    coverageElement.textContent = `coverage ${coverage.admitted}/${coverage.declared}`;
    const included = (status.all_machines || []).join(", ") || "none";
    const warnings = (status.machines || []).filter(
      (machine) => !machine.admitted || machine.stale || machine.availability === "unreachable" || machine.availability === "unknown"
    ).length;
    summaryElement.textContent = status.polling_error
      ? `${status.polling_error} · Last rendered data remains on screen`
      : status.syncing
      ? `Syncing in background · All currently includes ${included}`
      : `${warnings ? warnings + " machine warning(s)" : "All current"} · All includes ${included}`;
    machineList.innerHTML = (status.machines || []).map(renderMachineStatus).join("");
    revealSyncDetailOnTrouble(Boolean(warnings || status.polling_error));
  }

  // The panel opens itself the moment something needs attention, and stays
  // wherever the reader last put it for as long as that condition holds — so a
  // poll every few seconds cannot keep reopening a panel they just closed.
  let syncTroubleLatch = false;

  function revealSyncDetailOnTrouble(inTrouble) {
    const panel = qs("#sync-panel");
    if (!panel) {
      return;
    }
    if (inTrouble && !syncTroubleLatch) {
      panel.open = true;
    }
    syncTroubleLatch = inTrouble;
  }

  function renderMachineStatus(machine) {
    const chips = [];
    chips.push(statusChip(machine.admitted ? "ok" : "bad", machine.admitted ? "included" : "excluded"));
    if (machine.availability) {
      chips.push(statusChip(machine.availability === "reachable" ? "ok" : machine.availability === "never" ? "bad" : "warn", machine.availability));
    }
    if (machine.stale) {
      chips.push(statusChip("warn", "stale"));
    }
    if (machine.syncing) {
      chips.push(statusChip("info", "syncing"));
    }
    const marker = machine.this_machine ? ' <span class="scope-badge">This machine</span>' : "";
    const timestamps = [
      machine.last_sync_ts ? `last sync ${formatDate(machine.last_sync_ts)}` : "last sync never",
      machine.last_attempt_ts ? `last attempt ${formatDate(machine.last_attempt_ts)} (${machine.last_attempt_outcome})` : `last attempt ${machine.last_attempt_outcome || "unknown"}`,
      machine.last_successful_contact_ts ? `last successful contact ${formatDate(machine.last_successful_contact_ts)}` : "successful contact never observed",
      machine.generated_at ? `generated ${formatDate(machine.generated_at)}` : "generated never",
      machine.data_start_date ? `data since ${escapeHtml(machine.data_start_date)}` : "data start unknown",
    ].join(" · ");
    let consequence;
    if (!machine.admitted) {
      const attemptFailed = ["failure", "cleanup_failed", "malformed_result"].includes(machine.last_attempt_outcome);
      const attemptContext = machine.reason
        ? attemptFailed ? `. Latest sync failed: ${machine.reason}` : `. ${machine.reason}`
        : "";
      consequence = `Excluded from All: ${exclusionText(machine)}${attemptContext}`;
    } else if (machine.availability === "unreachable") {
      consequence = `Included in All using the last generation. Sync failed: ${machine.reason || "unreachable"}`;
    } else if (machine.availability === "unknown") {
      consequence = `Included in All using the last generation. Contact status is unknown: ${machine.reason || "no observation in this server process"}`;
    } else if (machine.stale) {
      const attemptContext = machine.reason ? ` Latest sync attempt failed: ${machine.reason}` : "";
      consequence = `Included in All, but this generation is stale.${attemptContext}`;
    } else {
      const attemptContext = machine.reason ? ` Latest sync attempt failed: ${machine.reason}` : "";
      consequence = `Included in All.${attemptContext}`;
    }
    return `<article class="sync-machine ${machine.admitted ? "included" : "excluded"}">
      <div class="sync-machine-title"><strong>${escapeHtml(machine.name)}</strong>${marker}<span class="sync-chips">${chips.join("")}</span></div>
      <div class="sync-machine-time">${timestamps}</div>
      <div class="sync-machine-reason">${escapeHtml(consequence)}</div>
    </article>`;
  }

  function exclusionText(machine) {
    if (machine.availability === "never") {
      return "never synced; no generation is available";
    }
    const labels = {
      machine_config_fingerprint: "machine configuration fingerprint mismatch",
      bucket_timezone: "bucket timezone mismatch",
      generation_id: "generation identity mismatch",
      digest: "generation digest mismatch",
      source_host_identity_collision: "source machine identity collision",
      invalid_generation: "generation validation failed",
      removed_from_config: "machine was removed from configuration during the latest sync",
      no_longer_declared_after_latest_attempt: "machine was targeted by the latest sync but is no longer declared",
    };
    return labels[machine.exclusion_reason] || machine.exclusion_reason || "generation was not admitted";
  }

  function statusChip(kind, text) {
    return `<span class="status-pill ${kind}">${escapeHtml(text)}</span>`;
  }

  async function waitForSyncTerminal(initialStatus, options) {
    const isCurrent = options && typeof options.isCurrent === "function" ? options.isCurrent : () => true;
    const renderIfCurrent = (status) => {
      if (isCurrent()) {
        renderSyncStatus(status);
      }
    };
    let status = initialStatus || await api("/api/sync-status");
    renderIfCurrent(status);
    while (status.syncing) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        status = await api("/api/sync-status");
      } catch (error) {
        status = Object.assign({}, status, {
          syncing: false,
          terminal: false,
          polling_error: `Sync status unavailable: ${error && error.message ? error.message : error}`,
          machines: (status.machines || []).map((machine) => Object.assign({}, machine, { syncing: false })),
        });
        renderIfCurrent(status);
        return status;
      }
      renderIfCurrent(status);
    }
    return status;
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
    // The provider name belongs to the card, not to each row: repeated six
    // times it filled the label column and wrapped every label onto two lines.
    qs("#network-risk").innerHTML = [
      kvRow("Risk score", score),
      kvRow("Type", type),
      kvRow("Marked proxy", markedProxy ? statusPill("warn", "yes") : statusPill("ok", "no")),
      kvRow("Hosting", pub.hosting ? statusPill("warn", "yes") : statusPill("ok", "no")),
      kvRow("Spam score", spamScore),
      kvRow("Spam reports", spamReports),
      kvRow("Last spam report", lastSpamReport),
      kvRow("Proxy envs", envs),
      '<p class="conclusion-note">Risk and type from proxycheck; marked proxy and hosting from ip-api; spam rows from stopforumspam. Proxy envs are read from this machine\'s shell.</p>',
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
    return Number.isNaN(date.getTime()) ? iso : fmtAbs(date);
  }

  // Session rows all carried a full date and zone suffix, which wrapped every
  // row onto a second line for information that is identical down long runs of
  // the table. The date moves to a group heading; the row keeps the time.
  function dayKey(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const opts = serverTimeZone ? { timeZone: serverTimeZone } : undefined;
    try {
      return new Intl.DateTimeFormat(
        "en-CA",
        Object.assign({ year: "numeric", month: "2-digit", day: "2-digit" }, opts)
      ).format(date);
    } catch (e) {
      return date.toISOString().slice(0, 10);
    }
  }

  function timeOfDay(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    const opts = serverTimeZone ? { timeZone: serverTimeZone } : undefined;
    try {
      return new Intl.DateTimeFormat(
        undefined,
        Object.assign({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }, opts)
      ).format(date);
    } catch (e) {
      return date.toLocaleTimeString();
    }
  }

  async function initOverview() {
    const retiredFiveHour = qs("#codex-five-hour");
    const legacyCard = retiredFiveHour && retiredFiveHour.closest(".kpi-card");
    const compatibilityNodes = qs("#codex-five-hour-compat");
    if (legacyCard || compatibilityNodes) {
      (legacyCard || compatibilityNodes).remove();
    }
    let overviewGeneration = 0;
    let renderedOverviewGeneration = 0;
    async function load(force) {
      const generation = ++overviewGeneration;
      const selectedRange = getRange();
      let data;
      try {
        data = await api("/api/overview", { range: selectedRange, force: force ? "1" : undefined });
      } catch (error) {
        if (generation === overviewGeneration) {
          showOverviewLoadError(error);
        }
        return;
      }
      if (generation < renderedOverviewGeneration) {
        return;
      }
      renderedOverviewGeneration = generation;
      const error = qs("#overview-load-error");
      if (error) {
        error.remove();
      }
      renderOverview(data, selectedRange);
      renderSyncStatus(data.sync);
      if (data.sync && data.sync.refresh_pending) {
        if (data.sync.syncing) {
          const terminalStatus = await waitForSyncTerminal(data.sync, {
            isCurrent: () => generation === overviewGeneration,
          });
          if (terminalStatus.polling_error) {
            return;
          }
        }
        if (generation !== overviewGeneration) {
          return;
        }
        const finalData = await api("/api/overview", { range: selectedRange, sync: "0" });
        if (generation < renderedOverviewGeneration) {
          return;
        }
        renderOverview(finalData, selectedRange);
        renderSyncStatus(finalData.sync);
      }
    }
    bindShell(load);
    await load(false);
  }

  function showOverviewLoadError(error) {
    let message = qs("#overview-load-error");
    if (!message) {
      message = document.createElement("p");
      message.id = "overview-load-error";
      message.className = "main error";
      document.body.appendChild(message);
    }
    message.textContent = `Failed to refresh overview: ${error.message || error}`;
  }

  // Every session ever recorded arrived as one unbroken table — 2,512 rows and
  // 162,000 pixels on this machine — with no way to narrow it and a header that
  // scrolled out of sight within a screen. Narrowing comes first because the
  // question is almost always "which session was that", not "show me all".
  const SESSIONS_PAGE_SIZE = 100;
  const sessionsView = { rows: [], page: 0, filters: { agent: "", project: "", model: "" } };
  const SESSION_FILTERS = [
    { key: "agent", select: "#filter-agent", field: "agent_id" },
    { key: "project", select: "#filter-project", field: "project" },
    { key: "model", select: "#filter-model", field: "model" },
  ];

  async function initSessions() {
    async function load() {
      const data = await api("/api/sessions", {
        range: getRange(),
        sort: qs("#sort") ? qs("#sort").value : "time",
        order: "desc",
      });
      sessionsView.rows = data;
      sessionsView.page = 0;
      populateSessionFilters(data);
      renderSessions();
    }
    bindShell(load);
    const sort = qs("#sort");
    if (sort) {
      sort.addEventListener("change", load);
    }
    SESSION_FILTERS.forEach((filter) => {
      const select = qs(filter.select);
      if (select) {
        select.addEventListener("change", () => {
          sessionsView.filters[filter.key] = select.value;
          sessionsView.page = 0;
          renderSessions();
        });
      }
    });
    const prev = qs("#page-prev");
    const next = qs("#page-next");
    if (prev) {
      prev.addEventListener("click", () => turnSessionPage(-1));
    }
    if (next) {
      next.addEventListener("click", () => turnSessionPage(1));
    }
    await load(false);
  }

  function turnSessionPage(step) {
    const total = filteredSessions().length;
    const lastPage = Math.max(0, Math.ceil(total / SESSIONS_PAGE_SIZE) - 1);
    sessionsView.page = Math.min(lastPage, Math.max(0, sessionsView.page + step));
    renderSessions();
    const wrap = qs(".table-wrap.sticky-head");
    if (wrap) {
      wrap.scrollTop = 0;
    }
  }

  // Options come from the rows actually loaded, so a filter can never offer a
  // value that would return nothing. A selection that survives a reload stays
  // selected; one whose value has aged out of the window resets to "all".
  function populateSessionFilters(rows) {
    SESSION_FILTERS.forEach((filter) => {
      const select = qs(filter.select);
      if (!select) {
        return;
      }
      const values = Array.from(new Set(rows.map((row) => row[filter.field]).filter(Boolean))).sort();
      const previous = sessionsView.filters[filter.key];
      const keep = values.includes(previous) ? previous : "";
      const label = select.options[0] ? select.options[0].textContent : "All";
      const labels = optionLabels(filter.key, values);
      select.innerHTML =
        `<option value="">${escapeHtml(label)}</option>` +
        values
          .map((value, index) => `<option value="${escapeHtml(value)}">${escapeHtml(labels[index])}</option>`)
          .join("");
      select.value = keep;
      sessionsView.filters[filter.key] = keep;
    });
  }

  // Shortening a project to its trailing segments can map two different paths
  // onto one label, and an <option> has nowhere to put the full value — the
  // reader would face two identical entries with no way to choose. Where that
  // happens, those entries keep their full path.
  function optionLabels(key, values) {
    if (key !== "project") {
      return values.slice();
    }
    const short = values.map((value) => projectLabel(value));
    const seen = short.reduce((counts, label) => {
      counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {});
    return short.map((label, index) => (seen[label] > 1 ? values[index] : label));
  }

  function filteredSessions() {
    return sessionsView.rows.filter((row) =>
      SESSION_FILTERS.every((filter) => {
        const wanted = sessionsView.filters[filter.key];
        return !wanted || row[filter.field] === wanted;
      })
    );
  }

  function renderSessions() {
    const tbody = qs("#sessions-body");
    const matched = filteredSessions();
    const start = sessionsView.page * SESSIONS_PAGE_SIZE;
    const pageRows = matched.slice(start, start + SESSIONS_PAGE_SIZE);
    // Dates only group meaningfully while the list is in time order; sorted by
    // cost or tokens the days interleave and a heading would assert an order
    // the table does not have.
    const grouped = (qs("#sort") ? qs("#sort").value : "time") === "time";
    let lastDay = null;

    tbody.innerHTML = "";
    pageRows.forEach((row) => {
      const day = dayKey(row.started_at);
      if (grouped && day && day !== lastDay) {
        const heading = document.createElement("tr");
        heading.className = "date-group";
        heading.innerHTML = `<th colspan="7" scope="colgroup">${escapeHtml(day)}</th>`;
        tbody.appendChild(heading);
        lastDay = day;
      }
      const tr = document.createElement("tr");
      tr.className = "session-row";
      tr.dataset.sessionId = row.session_id;
      tr.innerHTML = `
        <td><span class="pill agent-${escapeHtml(row.agent_id)}">${escapeHtml(row.agent_id)}</span></td>
        <td class="project-cell"><span title="${escapeHtml(row.project)}">${escapeHtml(projectLabel(row.project))}</span></td>
        <td class="nowrap">${escapeHtml(row.model)}${row.estimated ? ' <span class="muted">estimated</span>' : ""}</td>
        <td class="nowrap">${grouped ? escapeHtml(timeOfDay(row.started_at)) : formatDate(row.started_at)}</td>
        <td class="numeric">${moneyPrecise(row.cost_usd)}</td>
        <td class="numeric">${integer(row.tokens)}</td>
        <td class="numeric">${integer(row.messages)}</td>
      `;
      tr.addEventListener("click", () => toggleSession(tr));
      tbody.appendChild(tr);
    });

    syncStickyHeaderOffset();
    const filtering = matched.length !== sessionsView.rows.length;
    qs("#session-count").textContent = filtering
      ? `${integer(matched.length)} of ${integer(sessionsView.rows.length)} sessions`
      : `${integer(sessionsView.rows.length)} sessions`;
    renderSessionPager(matched.length, start, pageRows.length);
  }

  // The date headings stick directly beneath the column header, so they need
  // its rendered height — which moves with font metrics and zoom — rather than
  // a constant chosen when the stylesheet was written.
  function syncStickyHeaderOffset() {
    const wrap = qs(".table-wrap.sticky-head");
    const head = wrap && wrap.querySelector("thead");
    if (!wrap || !head) {
      return;
    }
    wrap.style.setProperty("--sessions-head-h", Math.round(head.getBoundingClientRect().height) + "px");
  }

  function renderSessionPager(total, start, shown) {
    const status = qs("#page-status");
    const prev = qs("#page-prev");
    const next = qs("#page-next");
    if (status) {
      status.textContent = total
        ? `Showing ${integer(start + 1)}–${integer(start + shown)} of ${integer(total)}`
        : "No sessions match these filters";
    }
    if (prev) {
      prev.disabled = sessionsView.page === 0;
    }
    if (next) {
      next.disabled = start + shown >= total;
    }
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
          <span>${formatDate(entry.timestamp)}</span>
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

  // Stale-code watch. Static assets are always served fresh, but the Python
  // process freezes its code at boot — a long-lived daemon can serve outdated
  // logic without any visible signal (the worst case: reading wrong data
  // unknowingly). The server self-reports staleness via /api/health.stale; this
  // banner makes it visible on every access path, including a long-open tab or a
  // phone on the Tailnet that never went through `tt-web open`.
  let pageWebSignature = null;
  let pageServerInstance = null;
  async function pollFreshness() {
    try {
      const url = new URL("/api/health", window.location.origin);
      url.searchParams.set("asset_watch", "1");
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const json = await res.json();
      if (pageWebSignature && json.web_signature && json.web_signature !== pageWebSignature) {
        window.location.reload();
        return;
      }
      pageWebSignature = json.web_signature || pageWebSignature;
      if (pageServerInstance && json.instance_id && json.instance_id !== pageServerInstance) {
        const status = await api("/api/sync-status");
        renderSyncStatus(status);
      }
      pageServerInstance = json.instance_id || pageServerInstance;
      if (json && json.stale) {
        showStaleBanner();
      }
    } catch (e) {
      /* transient; try again next tick */
    }
  }

  function showStaleBanner() {
    if (qs("#stale-banner")) {
      return;
    }
    const banner = document.createElement("div");
    banner.id = "stale-banner";
    banner.className = "stale-banner";
    banner.innerHTML =
      '<span>服务代码已更新，当前页面数据可能来自旧版本。</span>' +
      '<button type="button" id="stale-restart">重启并刷新</button>' +
      '<span class="stale-hint">或在终端运行 <code>tt-web restart</code></span>';
    document.body.insertAdjacentElement("afterbegin", banner);
    const button = qs("#stale-restart", banner);
    if (button) {
      button.addEventListener("click", () => restartAndReload(button));
    }
  }

  async function restartAndReload(button) {
    button.disabled = true;
    button.textContent = "重启中…";
    try {
      const res = await fetch(new URL("/api/restart", window.location.origin), { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (json && json.restarting === false) {
        button.disabled = false;
        button.textContent = "重启失败：新代码有语法错误";
        return;
      }
    } catch (e) {
      /* connection reset is expected: the server is re-exec'ing */
    }
    await waitForHealthy();
    window.location.reload();
  }

  async function waitForHealthy() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const url = new URL("/api/health", window.location.origin);
        url.searchParams.set("asset_watch", "1");
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          if (json && !json.stale) {
            return;
          }
        }
      } catch (e) {
        /* still restarting */
      }
    }
  }

  function startFreshnessWatch() {
    pollFreshness();
    setInterval(pollFreshness, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startFreshnessWatch);
  } else {
    startFreshnessWatch();
  }

  window.TTWeb = {
    api,
    autoTimeDim,
    bindShell,
    chart,
    chartOptions,
    compactNumber,
    dataset,
    getRange,
    integer,
    money,
    moneyPrecise,
    params,
    palette,
    SERIES_LIMIT,
    qsa,
    qs,
    setParam,
    shortText,
    renderSyncStatus,
    waitForSyncTerminal,
    pollFreshness,
    initNetwork,
    initOverview,
    initSessions,
  };
})();
