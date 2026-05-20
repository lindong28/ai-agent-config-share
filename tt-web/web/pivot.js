(function () {
  const presets = {
    "daily-cost": { x: "day", group: "agent", metric: "cost" },
    "project-cost": { x: "project", group: "none", metric: "cost" },
    "model-tokens": { x: "model", group: "agent", metric: "total" },
    "agent-project": { x: "agent", group: "project", metric: "cost" },
    cache: { x: "day", group: "agent", metric: "cache_read" },
  };

  const timeDims = new Set(["day", "week", "month"]);

  async function init() {
    const controls = ["#x-dim", "#group-dim", "#metric", "#range"].map((selector) => TTWeb.qs(selector));
    applyQuery();
    async function load() {
      await loadPivot();
    }
    TTWeb.bindShell(load);
    controls.forEach((control) => {
      if (control) {
        control.addEventListener("change", () => {
          syncQuery();
          loadPivot();
        });
      }
    });
    TTWeb.qsa(".preset-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const preset = presets[button.dataset.preset];
        TTWeb.qs("#x-dim").value = preset.x;
        TTWeb.qs("#group-dim").value = preset.group;
        TTWeb.qs("#metric").value = preset.metric;
        syncQuery();
        loadPivot();
      });
    });
    await loadPivot();
  }

  function applyQuery() {
    const query = TTWeb.params();
    setValue("#x-dim", query.get("x") || "day");
    setValue("#group-dim", query.get("group") || "agent");
    setValue("#metric", query.get("metric") || "cost");
    setValue("#range", query.get("range") || "30d");
  }

  function setValue(selector, value) {
    const control = TTWeb.qs(selector);
    if (control) {
      control.value = value;
    }
  }

  function syncQuery() {
    TTWeb.setParam("x", TTWeb.qs("#x-dim").value);
    TTWeb.setParam("group", TTWeb.qs("#group-dim").value);
    TTWeb.setParam("metric", TTWeb.qs("#metric").value);
    TTWeb.setParam("range", TTWeb.qs("#range").value);
  }

  async function loadPivot() {
    const x = TTWeb.qs("#x-dim").value;
    const group = TTWeb.qs("#group-dim").value;
    const metric = TTWeb.qs("#metric").value;
    const range = TTWeb.getRange();
    TTWeb.qs("#pivot-status").textContent = "Loading";
    const data = await TTWeb.api("/api/pivot", { x, group, metric, range });
    renderChart(data, x, metric);
    renderTable(data, metric);
    TTWeb.qs("#pivot-status").textContent = chartType(x) + " chart";
    TTWeb.qs("#pivot-count").textContent = TTWeb.integer(data.rows.length) + " rows";
  }

  function chartType(x) {
    return timeDims.has(x) ? "line" : "bar";
  }

  function renderChart(data, x, metric) {
    const type = chartType(x);
    const datasets = data.columns.map((column, index) =>
      TTWeb.dataset(column, data.rows.map((row) => row.values[column]), index, {
        fill: false,
        spanGaps: true,
      })
    );
    TTWeb.chart("pivot", "pivot-chart", {
      type,
      data: {
        labels: data.rows.map((row) => TTWeb.shortText(row.x, 48)),
        datasets,
      },
      options: TTWeb.chartOptions({
        indexAxis: type === "bar" ? "y" : "x",
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context.raw;
                return `${context.dataset.label}: ${formatValue(value, metric)}`;
              },
            },
          },
        },
      }),
    });
  }

  function renderTable(data, metric) {
    const table = TTWeb.qs("#pivot-table");
    const header = ["<thead><tr><th>X</th>"]
      .concat(data.columns.map((column) => `<th class="numeric">${escapeHtml(column)}</th>`))
      .concat(["</tr></thead>"])
      .join("");
    const body = data.rows
      .map((row) => {
        const cells = data.columns
          .map((column) => `<td class="numeric">${formatValue(row.values[column], metric)}</td>`)
          .join("");
        return `<tr><td>${escapeHtml(row.x)}</td>${cells}</tr>`;
      })
      .join("");
    table.innerHTML = header + `<tbody>${body}</tbody>`;
  }

  function formatValue(value, metric) {
    if (metric === "cost") {
      return TTWeb.moneyPrecise(value);
    }
    if (value === null || value === undefined) {
      return "—";
    }
    return TTWeb.integer(value);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.TTWebPivot = { init, chartType };
})();
