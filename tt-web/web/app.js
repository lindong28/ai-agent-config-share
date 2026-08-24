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
    renderQuotaAccounts(data.rate_limits);
    // After the quota table, and guarded: a cached copy of the older HTML has no
    // #range-label, and an unguarded write here would throw before the table,
    // charts and sync panel rendered — turning "one card is missing" into a
    // blank page, which is exactly the skew initOverview already handles.
    renderRangeCost(data.range, selectedRange || getRange(), data.rollup_coverage);

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

  // The card's own label carries the window, so the figure stays readable
  // without glancing back at the toolbar to see which range is selected.
  // A payload without `range` predates this field; the card then says so rather
  // than showing a stale or zeroed figure under a live-looking heading.
  function renderRangeCost(range, selectedRange, coverage) {
    const labelEl = qs("#range-label");
    const costEl = qs("#range-cost");
    const tokensEl = qs("#range-tokens");
    if (!labelEl || !costEl || !tokensEl) {
      return;
    }
    const label = rangeLabel(selectedRange);
    labelEl.textContent =
      selectedRange === "all" ? "All-history cost" : `Last ${label} cost`;
    if (!range) {
      costEl.textContent = "—";
      tokensEl.textContent = "not reported by this server";
      return;
    }
    costEl.textContent = money(range.cost_usd);
    // The heading names a window the data may not actually span: this host's
    // rollup starts at a collection date, so "All-history cost" over four months
    // of history is a bigger claim than the number supports. The Cost-over-time
    // panel already discloses the same fact, but it sits a screen below the
    // card — the qualifier has to travel with the figure that makes the claim.
    //
    // Three outcomes, and the test is what coverage actually *told* us, not
    // whether the object arrived. `_rollup_coverage` returns a full dict even
    // when it knows nothing: with an empty rollup DB `earliest_rollup_date()`
    // is null, so it reports `partial_before_range: false, earliest_date: null`
    // — indistinguishable, to a truthy check on the object, from a positive
    // "this window is covered". Keying on the object would then print
    // "All-history cost $0.00 / 0 tokens" unqualified on a host that has simply
    // never rolled up, while B4's panel note stays hidden for the same reason.
    // "We have no data" and "you spent nothing" are the two readings that must
    // never share a rendering.
    const tokens = integer(range.tokens);
    const known =
      coverage && typeof coverage.partial_before_range === "boolean" && coverage.earliest_date;
    if (!known) {
      tokensEl.textContent = `${tokens} tokens · 覆盖范围未知`;
    } else if (coverage.partial_before_range) {
      tokensEl.textContent = `${tokens} tokens · 自 ${coverage.earliest_date} 起累积`;
    } else {
      tokensEl.textContent = `${tokens} tokens`;
    }
  }

  function resetText(epoch, nowMs = Date.now()) {
    if (!epoch) {
      return "—";
    }
    const resetAt = new Date(epoch * 1000);
    if (resetAt.getTime() <= nowMs) {
      return "reset passed " + fmtAbs(resetAt);
    }
    return "resets " + fmtAbs(resetAt);
  }

  // An agent keeps one colour everywhere, so these reuse the .pill classes the
  // charts and tables already use rather than introducing a second scheme.
  // Each window owns a fixed column for every row, regardless of which windows a
  // provider reports. Codex has no 5h, so its 5h cell says "n/a" (see
  // quotaWindowCell — an em dash there would mean something else) rather than
  // sliding its 7d leftward: a flowed layout did that, putting Codex's 7d and
  // Claude's 5h in one column and moving the two 7d figures apart, which are the
  // ones that need comparing.
  const QUOTA_WINDOW_7D = { key: "7d", used: "seven_day_used_pct", reset: "seven_day_resets_at" };
  const QUOTA_WINDOW_5H = { key: "5h", used: "five_hour_used_pct", reset: "five_hour_resets_at" };
  // Order here IS the column order on the page and must match the header row in
  // index.html. The shorter window comes first: the 5h figure is the one that
  // decides whether work can continue in the next few minutes, so it is read
  // first and belongs closest to the account it belongs to.
  const QUOTA_COLUMNS = [QUOTA_WINDOW_5H, QUOTA_WINDOW_7D];
  const QUOTA_PRESENCES = ["in_use", "remembered"];
  const QUOTA_PROVIDERS = [
    {
      key: "claude",
      label: "Claude",
      pill: "agent-claude-code",
      // Same order as QUOTA_COLUMNS. Placement does not read this list — the
      // column a value lands in comes from its own spec — but the collapsed
      // group's "worst usage" pill breaks an exact tie by taking the first
      // window here, and that tie should break the way the columns read.
      windows: [QUOTA_WINDOW_5H, QUOTA_WINDOW_7D],
    },
    // Codex reports no 5h window in current sessions, so its 5h cell says so
    // rather than carrying a value.
    { key: "codex", label: "Codex", pill: "agent-codex", windows: [QUOTA_WINDOW_7D] },
  ];

  function quotaPresence(account) {
    // Older API payloads have no presence field and contain only live data, so
    // retain the prior rendering instead of matching nothing and emptying the
    // table.
    return account.presence === undefined ? "in_use" : account.presence;
  }

  function renderQuotaAccounts(rateLimits) {
    const table = qs("#quota-accounts");
    if (!table) {
      return;
    }
    // Only the bodies are ours; the header row is in the markup.
    Array.from(table.tBodies).forEach((body) => body.remove());

    // Presence is the outer loop: provider-first rendering would put a
    // remembered Claude account above an in-use Codex account. Unattributed
    // rows are current admission data too: singles render with their provider,
    // while collapsed groups sit at the end of this live pass.
    QUOTA_PRESENCES.forEach((presence) => {
      QUOTA_PROVIDERS.forEach((provider) => {
        const block = rateLimits?.[provider.key];
        const accounts = block?.accounts || [];
        if (!accounts.length) {
          if (presence === "in_use") {
            table.appendChild(quotaUnavailableBody(provider, block?.unavailable_reason));
          }
          return;
        }
        const matching = accounts.filter((a) => quotaPresence(a) === presence);
        const named = matching.filter((a) => a.account_state === "known");
        const unknown = matching.filter((a) => a.account_state !== "known");
        if (named.length) {
          table.appendChild(quotaBody(provider, named));
        }
        if (presence === "in_use" && unknown.length === 1) {
          table.appendChild(quotaBody(provider, unknown));
        }
      });

      // Rows without an account are one per machine, not one per account. Keep
      // larger groups collapsed, but still inside the live section so no
      // current machine can fall below a remembered account.
      if (presence === "in_use") {
        QUOTA_PROVIDERS.forEach((provider) => {
          const accounts = rateLimits?.[provider.key]?.accounts || [];
          const unknown = accounts.filter(
            (a) => quotaPresence(a) === "in_use" && a.account_state !== "known",
          );
          if (unknown.length > 1) {
            table.appendChild(quotaUnknownBody(provider, unknown));
          }
        });
      }
    });
  }

  function quotaBody(provider, accounts) {
    const body = document.createElement("tbody");
    accounts.forEach((account) => body.appendChild(quotaAccountRow(provider, account)));
    return body;
  }

  function quotaAccountRow(provider, account) {
    const row = document.createElement("tr");
    row.className = "quota-row";
    row.dataset.presence = quotaPresence(account);
    if (quotaPresence(account) === "remembered") {
      row.classList.add("remembered");
    }
    if (account.account_state === "known" && typeof account.account_id === "string" && account.account_id) {
      row.dataset.provider = provider.key;
      row.dataset.accountId = account.account_id;
      if (typeof account.updated_at === "string" && account.updated_at) {
        row.dataset.observedAt = account.updated_at;
      }
    }
    if (account.account_state !== "known") {
      row.classList.add("unattributed");
    }
    const stale = quotaIsStale(account.updated_at);
    if (stale) {
      // Deliberately carries no styling — the pill in the Updated cell marks
      // staleness where it applies. This is the machine-readable half, which
      // the pill's wording is not: keep it even though no CSS rule selects it.
      row.classList.add("stale");
    }

    row.appendChild(quotaProviderCell(provider, account));
    row.appendChild(quotaPlanCell(account));
    row.appendChild(quotaAccountCell(provider, account));
    QUOTA_COLUMNS.forEach((spec) => row.appendChild(quotaWindowCell(provider, spec, account)));
    row.appendChild(quotaMachinesCell(account));
    row.appendChild(quotaUpdatedCell(account, stale));
    return row;
  }

  function quotaProviderCell(provider, account) {
    const cell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "quota-provider-cell";
    wrap.appendChild(quotaProviderPill(provider));
    if (quotaPresence(account) === "remembered") {
      const marker = document.createElement("span");
      marker.className = "status-pill quota-history-marker";
      marker.textContent = "已登出";
      wrap.appendChild(marker);
    }
    cell.appendChild(wrap);
    return cell;
  }

  function quotaPlanCell(account) {
    const cell = document.createElement("td");
    if (!account.account_plan) {
      cell.textContent = "—";
      return cell;
    }
    const plan = document.createElement("span");
    plan.className = "status-pill info";
    plan.textContent = quotaPlanLabel(account.account_plan);
    cell.appendChild(plan);
    if (quotaPlanSourcesDisagree(account)) {
      // The whole claim in visible text, not in a title. A hover is not a
      // channel on touch or from the keyboard, and the reader who needs this
      // is precisely the one who would otherwise read the row as a single
      // observation — so the words "不一致" and both sources are in the cell.
      const mismatch = document.createElement("span");
      mismatch.className = "quota-plan-mismatch";
      mismatch.textContent =
        `plan 不一致 · 配额读数 ${quotaPlanLabel(account.reading_plan)}` +
        ` / 机器凭据 ${quotaPlanLabel(account.credential_plan)}`;
      mismatch.title = "两者取自不同来源，无法判断哪一个更旧。";
      cell.appendChild(mismatch);
    }
    return cell;
  }

  // Whether the row's two plan facts are both present and disagree.
  //
  // Three states, not two, and the third one is why this reads the two raw
  // fields rather than comparing `account_plan` against the credential: a
  // reading that carries no plan falls back to the credential one, which would
  // make a lone source compare equal to itself and be indistinguishable from
  // two sources that agree. Signed out, an unreadable credential file and an
  // API-key machine leave one source; a remembered row and an exporter older
  // than this field leave none. Fewer than two either way, so nothing is
  // compared.
  //
  // The page stays silent for it, as it does for agreement — but silence here
  // is the absence of a claim, not a claim of agreement, and the two states
  // remain distinguishable in the payload for anyone who needs them apart.
  // See ADR 20260822-586a.
  function quotaPlanSourcesDisagree(account) {
    if (account.account_state !== "known") {
      return false;
    }
    const reading = account.reading_plan;
    const credential = account.credential_plan;
    if (typeof reading !== "string" || !reading) {
      return false;
    }
    if (typeof credential !== "string" || !credential) {
      return false;
    }
    return reading !== credential;
  }

  function quotaAccountCell(provider, account) {
    const cell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "quota-account-cell";

    const name = document.createElement("span");
    name.className = "quota-account-label";
    name.textContent = quotaAccountName(account);
    wrap.appendChild(name);

    if (quotaPresence(account) === "remembered") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quota-account-remove";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除 ${quotaAccountName(account)} 的记录`);
      remove.addEventListener("click", () => removeRememberedAccount(remove, provider, account));
      wrap.appendChild(remove);
    }
    cell.appendChild(wrap);
    return cell;
  }

  function quotaRemovalReading(account) {
    const sevenDay = quotaUsage(account.seven_day_used_pct);
    if (sevenDay.known) {
      return `7d 已用 ${sevenDay.used}%`;
    }
    const fiveHour = quotaUsage(account.five_hour_used_pct);
    if (fiveHour.known) {
      return `5h 已用 ${fiveHour.used}%`;
    }
    return "最后读数不可用";
  }

  function removeRenderedAccount(providerKey, accountId, observedAt) {
    const table = qs("#quota-accounts");
    if (!table) {
      return;
    }
    Array.from(table.children).forEach((section) => {
      Array.from(section.children).forEach((row) => {
        if (
          row.dataset.provider === providerKey &&
          row.dataset.accountId === accountId &&
          row.dataset.presence === "remembered" &&
          row.dataset.observedAt === observedAt
        ) {
          row.remove();
        }
      });
    });
  }

  async function removeRememberedAccount(button, provider, account) {
    const accountName = quotaAccountName(account);
    const observedAt = formatDate(account.updated_at);
    const confirmed = window.confirm(
      `移除 ${accountName} 的记录？\n` +
        `最后观测 ${observedAt}，${quotaRemovalReading(account)}。\n` +
        "此操作不可恢复。"
    );
    if (!confirmed) {
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch(new URL("/api/account-memory/remove", window.location.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: provider.key,
          account_id: account.account_id,
          observed_at: account.updated_at,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert(payload.error || `移除失败（HTTP ${response.status}）`);
        button.disabled = false;
        return;
      }
      removeRenderedAccount(provider.key, account.account_id, account.updated_at);
    } catch (error) {
      window.alert(`移除失败：${error && error.message ? error.message : error}`);
      button.disabled = false;
    }
  }

  // Usage bands. High usage means little headroom, so these decide when the page
  // stops being neutral about the number under it. Colour never carries this
  // alone — a low-quota row also says so in words, for readers who cannot see
  // the difference.
  const QUOTA_BAND_LOW = 25;
  const QUOTA_BAND_CRITICAL = 10;

  // One definition, used by the row and by the collapsed group's summary. Two
  // copies would let a machine be styled critical in one place and unflagged in
  // the other, which is exactly the case the collapse creates.
  function quotaUsage(usedPct) {
    // Out of range is unknown, not clamped. These come from another machine's
    // block, which the schema only checks is an object — clamping 105 would
    // render "0%" under an "almost out" pill and raise an alarm out of a bad
    // value.
    const known =
      typeof usedPct === "number" && Number.isFinite(usedPct) && usedPct >= 0 && usedPct <= 100;
    if (!known) {
      return { known: false, used: null, band: "" };
    }
    // Banded on the number the reader sees, not the one behind it: values that
    // both print "90%" must not carry different words.
    const used = Math.round(usedPct);
    const band = used > 100 - QUOTA_BAND_CRITICAL ? "critical" : used > 100 - QUOTA_BAND_LOW ? "low" : "";
    return { known: true, used, band };
  }

  function quotaBandPill(band, text) {
    const pill = document.createElement("span");
    pill.className = `status-pill ${band === "critical" ? "bad" : "warn"}`;
    pill.textContent = text;
    return pill;
  }

  function quotaWindowCell(provider, spec, account) {
    const cell = document.createElement("td");
    cell.className = "numeric quota-window-cell";

    // Matched by key, not object identity: identity holds only while every
    // provider's `windows` points at these same literals, and the day one is
    // built from copies this branch would stamp "reports no 5h window" over a
    // perfectly good reading — it fails toward a confident false statement.
    if (!provider.windows.some((window) => window.key === spec.key)) {
      // "n/a", not the em dash used for a missing reading. This provider has no
      // such window at all, which is a different fact from "we have no number",
      // and one glyph in two weights does not carry that difference — not for a
      // screen reader, and not for anyone who cannot hover a tooltip.
      cell.classList.add("not-applicable");
      cell.textContent = "n/a";
      cell.title = `${provider.label} reports no ${spec.key} window`;
      return cell;
    }

    const { known, used, band } = quotaUsage(account[spec.used]);
    const renderedAtMs = Date.now();
    const resetEpoch = account[spec.reset];
    const resetState = quotaResetState(resetEpoch, renderedAtMs);
    const rememberedHistoricalWindow =
      quotaPresence(account) === "remembered" && resetState !== "future";
    if (band) {
      cell.classList.add(band);
    }

    const line = document.createElement("div");
    line.className = "quota-window-line";

    const amount = document.createElement("span");
    amount.className = "quota-window-value";
    amount.textContent = known ? `${used}%` : "—";
    if (known) {
      amount.title = `${used}% of this window used`;
    }
    line.appendChild(amount);

    if (known) {
      line.appendChild(quotaMeter(used));
    }
    // The frozen usage value and meter remain facts after their own window has
    // reset, or when its reset is unknown; withdrawing the pill does not infer
    // that current usage is zero.
    // The pill is a present-tense warning, and D4 explicitly narrows contract
    // G4b for this historical case rather than accidentally omitting an alert.
    // A missing reset is not evidence that the old window is still running.
    if (band && !rememberedHistoricalWindow) {
      line.appendChild(quotaBandPill(band, band === "critical" ? "almost out" : "running low"));
    }
    cell.appendChild(line);

    const reset = document.createElement("div");
    reset.className = "quota-window-reset";
    reset.textContent = quotaPresence(account) === "remembered" && resetState === "unknown"
      ? "reset unknown"
      : quotaResetText(resetEpoch, resetState, renderedAtMs);
    if (resetState !== "unknown") {
      reset.title = resetText(resetEpoch, renderedAtMs);
    }
    cell.appendChild(reset);
    if (rememberedHistoricalWindow) {
      const observed = document.createElement("div");
      observed.className = "quota-window-observed";
      observed.textContent = `观测于 ${formatDate(account.updated_at)}`;
      cell.appendChild(observed);
    }
    return cell;
  }

  // Fills with what is used — the column reads "7d used", and a bar running the
  // other way would pair a long bar with a small number. Both encode usage, so
  // a nearly full bar means little quota remains.
  function quotaMeter(usedPct) {
    const track = document.createElement("span");
    track.className = "quota-meter";
    // Presentational: the adjacent text already states the value, and a second
    // announcement of the same number is noise on a screen reader.
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "quota-meter-fill";
    fill.style.setProperty("--quota-fill", String(usedPct / 100));
    track.appendChild(fill);
    return track;
  }

  // A reset time is read to answer "how long must I wait", so it says exactly
  // that — a duration, at every scale. A clock time would need the reader to
  // subtract, and is ambiguous the moment the reset is not today: "resets 11:32"
  // on one that is 18 hours out reads as this morning, already past. The full
  // timestamp stays on the title attribute for anyone who wants the wall clock.
  function quotaResetText(epoch, resetState, nowMs) {
    if (resetState === "unknown") {
      return "—";
    }
    if (resetState === "passed") {
      return "window reset";
    }
    const deltaMs = epoch * 1000 - nowMs;
    // Each unit is chosen from the value it will actually print, so rounding
    // cannot carry a figure past its own unit — 59.6 minutes says "1h", not
    // "60m". Never "in 0m": the state closest to relief must not read empty.
    const minutes = Math.max(1, Math.round(deltaMs / 60000));
    if (minutes < 60) {
      return `resets in ${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      return `resets in ${hours}h`;
    }
    return `resets in ${Math.round(hours / 24)}d`;
  }

  function quotaResetState(epoch, nowMs) {
    if (typeof epoch !== "number" || !Number.isFinite(epoch)) {
      return "unknown";
    }
    return epoch * 1000 <= nowMs ? "passed" : "future";
  }

  function quotaMachinesCell(account) {
    const cell = document.createElement("td");
    const names = account.machines || [];
    if (!names.length) {
      cell.textContent = "—";
      return cell;
    }
    names.forEach((name, index) => {
      if (index) {
        cell.appendChild(document.createTextNode(" · "));
      }
      const node = document.createElement("span");
      node.textContent = name;
      // Which of these is the machine in front of the reader. Without it, three
      // rows of e-mail addresses do not say which account this session spends.
      if (name === account.this_machine) {
        node.className = "quota-machine-self";
        node.appendChild(document.createTextNode(" (this machine)"));
      }
      cell.appendChild(node);
    });
    return cell;
  }

  function quotaUpdatedCell(account, stale) {
    const cell = document.createElement("td");
    cell.className = "quota-updated-cell";
    if (quotaPresence(account) === "remembered") {
      cell.appendChild(document.createTextNode(`最后观测 ${formatDate(account.updated_at)}`));
      const note = document.createElement("span");
      note.className = "quota-history-note";
      note.textContent = "最后观测值，不代表当前状态";
      cell.appendChild(note);
      return cell;
    }
    cell.appendChild(document.createTextNode(updatedText(account.updated_at)));
    if (stale) {
      const warn = document.createElement("span");
      warn.className = "status-pill warn";
      warn.textContent = "may predate a sign-in change";
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(warn);
    }
    return cell;
  }

  // Plan tiers arrive as the provider's own identifiers. Known ones get the name
  // the provider bills them under; anything unrecognised is shown as it came,
  // because inventing a label for a tier we do not know is worse than a raw one.
  const QUOTA_PLAN_LABELS = {
    default_claude_max_20x: "Max 20×",
    default_claude_max_5x: "Max 5×",
    default_claude_pro: "Pro",
    prolite: "Pro Lite",
    pro: "Pro",
    plus: "Plus",
    team: "Team",
    enterprise: "Enterprise",
  };

  function quotaPlanLabel(plan) {
    return QUOTA_PLAN_LABELS[plan] || plan;
  }

  function quotaAccountName(account) {
    if (typeof account.account_label === "string" && account.account_label) {
      return account.account_label;
    }
    if (typeof account.account_id === "string" && account.account_id) {
      return `account ${account.account_id.slice(0, 8)}`;
    }
    const machines = (account.machines || []).join(" · ");
    // Two ways to have no account, with different remedies. Telling someone to
    // update a machine that is already current sends them after the wrong thing.
    if (account.account_state === "signed_out") {
      return machines ? `not signed in on ${machines}` : "not signed in";
    }
    return machines ? `account unknown — update tt-web on ${machines}` : "account unknown";
  }

  // Old enough that the reading may predate whatever the machine is signed into
  // now. Attribution assumes the latest reading belongs to the current account,
  // so age is the reader's only cue that the assumption is stretched.
  const QUOTA_STALE_MS = 6 * 60 * 60 * 1000;

  function quotaIsStale(updatedAt) {
    const observed = Date.parse(updatedAt);
    return Number.isFinite(observed) && Date.now() - observed > QUOTA_STALE_MS;
  }

  function quotaProviderPill(provider) {
    const pill = document.createElement("span");
    pill.className = `pill ${provider.pill}`;
    pill.textContent = provider.label;
    return pill;
  }

  function quotaUnknownBody(provider, accounts) {
    const body = document.createElement("tbody");
    body.className = "quota-unknown";

    const summary = document.createElement("tr");
    summary.className = "quota-row unattributed quota-summary";

    const head = document.createElement("td");
    head.colSpan = 3;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "quota-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.appendChild(quotaProviderPill(provider));
    const label = document.createElement("span");
    label.className = "quota-account-label";
    label.textContent = quotaUnknownSummaryText(accounts);
    toggle.appendChild(label);
    // Collapsed rows are hidden in CSS, which puts them out of reach of the
    // browser's find-in-page. `hidden="until-found"` is the platform answer to
    // exactly that and was tried here: it computes `content-visibility: hidden`
    // on the rows, and they stay fully laid out at 81px each — that property has
    // no effect on `display: table-row`, which establishes no independent
    // formatting context. Leaving it in would have made the collapse a no-op.
    // What is left is the summary row naming every machine in the group, so the
    // names stay findable even though the figures beside them do not.
    toggle.addEventListener("click", () => {
      const open = body.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    head.appendChild(toggle);
    summary.appendChild(head);

    // Collapsing must not swallow the one thing the reader has to act on. A
    // machine at 96% used is still at 96% used when it has no account stamp, and
    // "the fleet is behind on updates" is exactly when that happens.
    //
    // The pill goes in the column of the window it came from. In a table the
    // column IS the claim: a 5h figure parked under "7d used" is read as a 7d
    // figure, which is the misalignment this whole change exists to remove.
    const worst = quotaWorstUsage(provider, accounts);
    QUOTA_COLUMNS.forEach((spec) => {
      const cell = document.createElement("td");
      cell.className = "numeric";
      if (worst && worst.spec === spec) {
        cell.appendChild(quotaBandPill(worst.band, `${worst.used}% used on ${worst.machine}`));
      }
      summary.appendChild(cell);
    });

    const machines = document.createElement("td");
    machines.textContent = accounts.flatMap((a) => a.machines || []).join(" · ");
    summary.appendChild(machines);
    summary.appendChild(document.createElement("td"));

    body.appendChild(summary);
    accounts.forEach((account) => body.appendChild(quotaAccountRow(provider, account)));
    return body;
  }

  // Each state names the machines it applies to, because the remedies differ:
  // one needs tt-web updated, the other needs someone to sign in. A summary that
  // says only "N machines report no account" sends the reader to neither.
  function quotaUnknownSummaryText(accounts) {
    const byState = (state) =>
      accounts.filter((a) => a.account_state === state).flatMap((a) => a.machines || []);
    const clauses = [];
    const unstamped = byState("unstamped");
    const signedOut = byState("signed_out");
    if (unstamped.length) {
      clauses.push(`update tt-web on ${unstamped.join(", ")}`);
    }
    if (signedOut.length) {
      clauses.push(`not signed in on ${signedOut.join(", ")}`);
    }
    const total = accounts.flatMap((a) => a.machines || []).length;
    return clauses.length
      ? `${total} machines without an account — ${clauses.join("; ")}`
      : `${total} machines without an account`;
  }

  function quotaWorstUsage(provider, accounts) {
    let worst = null;
    accounts.forEach((account) => {
      provider.windows.forEach((spec) => {
        const { known, used, band } = quotaUsage(account[spec.used]);
        if (!known || !band) {
          return;
        }
        if (!worst || used > worst.used) {
          // `spec` travels with the value: the caller places the pill in that
          // window's own column, and a figure under the wrong header is a
          // wrong figure.
          worst = { spec, used, band, machine: (account.machines || []).join(", ") || "unknown" };
        }
      });
    });
    return worst;
  }

  function quotaUnavailableBody(provider, reason) {
    const body = document.createElement("tbody");
    const row = document.createElement("tr");
    row.className = "quota-row unattributed";

    const head = document.createElement("td");
    head.colSpan = 3;
    const wrap = document.createElement("div");
    wrap.className = "quota-account-cell";
    wrap.appendChild(quotaProviderPill(provider));
    const label = document.createElement("span");
    label.className = "quota-account-label";
    label.textContent = "unavailable";
    wrap.appendChild(label);
    head.appendChild(wrap);
    row.appendChild(head);

    const detail = document.createElement("td");
    detail.colSpan = 4;
    detail.className = "quota-updated-cell";
    detail.textContent = reason || "no admitted source";
    row.appendChild(detail);

    body.appendChild(row);
    return body;
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
    // Same cache-skew guard, one generation on: a cached copy of the old page
    // has the per-provider quota cards but no #quota-accounts to render into,
    // which would leave those cards frozen at their placeholder forever.
    if (!qs("#quota-accounts")) {
      const legacyGrid = qs(".kpi-grid.quota");
      if (legacyGrid) {
        // Say why the section is empty. Removing the cards without a word leaves
        // a titled hole, which reads as "no quota" rather than "reload me".
        const note = document.createElement("p");
        note.className = "quota-scope";
        note.textContent = "Quota needs a reload of this page (cached older version).";
        legacyGrid.replaceWith(note);
      }
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
  const sessionsView = {
    rows: [],
    page: 0,
    status: "loading",
    filters: { agent: "", project: "", model: "" },
  };
  let sessionsGeneration = 0;
  const SESSION_FILTERS = [
    { key: "agent", select: "#filter-agent", field: "agent_id" },
    { key: "project", select: "#filter-project", field: "project" },
    { key: "model", select: "#filter-model", field: "model" },
  ];

  async function initSessions() {
    async function load() {
      const generation = ++sessionsGeneration;
      sessionsView.status = "loading";
      renderSessionState("loading");
      try {
        const data = await api("/api/sessions", {
          range: getRange(),
          sort: qs("#sort") ? qs("#sort").value : "time",
          order: "desc",
        });
        if (!isValidSessionsPayload(data)) {
          throw new Error("Sessions response contained invalid rows.");
        }
        if (generation !== sessionsGeneration) {
          return;
        }
        sessionsView.rows = data;
        sessionsView.page = 0;
        populateSessionFilters(data);
        sessionsView.status = "ready";
        setSessionFiltersDisabled(false);
        renderSessions();
      } catch (error) {
        if (generation !== sessionsGeneration) {
          return;
        }
        sessionsView.status = "error";
        renderSessionState("error", `Failed to load sessions: ${error.message || error}`, load);
      }
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
          if (sessionsView.status !== "ready") {
            return;
          }
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
    if (sessionsView.status !== "ready") {
      return;
    }
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

  function setSessionFiltersDisabled(disabled) {
    SESSION_FILTERS.forEach((filter) => {
      const select = qs(filter.select);
      if (select) {
        select.disabled = disabled;
      }
    });
  }

  function isValidSessionsPayload(data) {
    const textFields = ["session_id", "agent_id", "project", "model", "started_at"];
    const numberFields = ["tokens", "messages"];
    return (
      Array.isArray(data) &&
      data.every(
        (row) =>
          row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          textFields.every((field) => typeof row[field] === "string" && row[field]) &&
          numberFields.every((field) => Number.isFinite(row[field])) &&
          (row.cost_usd === null || Number.isFinite(row.cost_usd)) &&
          typeof row.estimated === "boolean"
      )
    );
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
    const filtering = matched.length !== sessionsView.rows.length;
    if (!pageRows.length) {
      renderSessionState("empty", filtering ? "No sessions match these filters." : "No sessions in this range.");
      qs("#session-count").textContent = filtering
        ? `0 of ${integer(sessionsView.rows.length)} sessions`
        : "0 sessions";
      return;
    }
    // Dates only group meaningfully while the list is in time order; sorted by
    // cost or tokens the days interleave and a heading would assert an order
    // the table does not have.
    const grouped = (qs("#sort") ? qs("#sort").value : "time") === "time";
    let lastDay = null;

    tbody.innerHTML = "";
    tbody.setAttribute("aria-busy", "false");
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
    qs("#session-count").textContent = filtering
      ? `${integer(matched.length)} of ${integer(sessionsView.rows.length)} sessions`
      : `${integer(sessionsView.rows.length)} sessions`;
    renderSessionPager(matched.length, start, pageRows.length);
  }

  function renderSessionState(state, message, load) {
    const tbody = qs("#sessions-body");
    if (!tbody) {
      return;
    }
    tbody.innerHTML = "";
    tbody.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    if (state === "loading" || state === "error") {
      setSessionFiltersDisabled(true);
    }
    const row = document.createElement("tr");
    row.dataset.sessionState = state;
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = state === "error" ? "error" : "empty-state";
    const text = message || "Loading sessions…";
    cell.appendChild(document.createTextNode(text));
    if (state === "error" && load) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", load);
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(retry);
    }
    row.appendChild(cell);
    tbody.appendChild(row);

    const count = qs("#session-count");
    if (count) {
      count.textContent = state === "loading" ? "Loading…" : state === "error" ? "Sessions unavailable" : "0 sessions";
    }
    const status = qs("#page-status");
    if (status) {
      status.textContent = text;
    }
    const prev = qs("#page-prev");
    const next = qs("#page-next");
    if (prev) {
      prev.disabled = true;
    }
    if (next) {
      next.disabled = true;
    }
    syncStickyHeaderOffset();
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
