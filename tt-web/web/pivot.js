(function () {
  const presets = {
    "daily-cost": { x: "day", group: "agent", metric: "cost" },
    "project-cost": { x: "project", group: "none", metric: "cost" },
    "model-tokens": { x: "model", group: "agent", metric: "total" },
    "agent-project": { x: "agent", group: "project", metric: "cost" },
    cache: { x: "day", group: "agent", metric: "cache_read" },
  };

  const timeDims = new Set(["day", "week", "month"]);
  const filterNames = ["agent", "project", "model"];
  const filterAllLabels = { agent: "All agents", project: "All projects", model: "All models" };
  let xDimPinned = false;

  async function init() {
    const controls = ["#x-dim", "#group-dim", "#metric", "#range"].map((selector) => TTWeb.qs(selector));
    applyQuery();
    await loadFilterOptions(false);
    async function load(force) {
      if (force) {
        await loadFilterOptions(true);
      }
      await loadPivot(force);
    }
    TTWeb.bindShell(load);
    controls.forEach((control) => {
      if (control) {
        control.addEventListener("change", async () => {
          if (control.id === "range" && !xDimPinned) {
            setValue("#x-dim", TTWeb.autoTimeDim(control.value));
          }
          if (control.id === "x-dim") {
            xDimPinned = true;
          }
          syncQuery();
          if (control.id === "range") {
            await loadFilterOptions(false);
          }
          loadPivot(false);
        });
      }
    });
    TTWeb.qsa("[data-filter-control]").forEach((control) => {
      control.addEventListener("change", () => {
        syncQuery();
        loadPivot(false);
      });
    });
    TTWeb.qsa(".preset-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const preset = presets[button.dataset.preset];
        TTWeb.qs("#x-dim").value = preset.x;
        TTWeb.qs("#group-dim").value = preset.group;
        TTWeb.qs("#metric").value = preset.metric;
        xDimPinned = true;
        syncQuery();
        loadPivot(false);
      });
    });
    await loadPivot(false);
  }

  function applyQuery() {
    const query = TTWeb.params();
    const range = query.get("range") || "30d";
    xDimPinned = query.has("x");
    setValue("#x-dim", query.get("x") || TTWeb.autoTimeDim(range));
    setValue("#group-dim", query.get("group") || "agent");
    setValue("#metric", query.get("metric") || "cost");
    setValue("#range", range);
    applyFilterQuery();
  }

  function setValue(selector, value) {
    const control = TTWeb.qs(selector);
    if (control) {
      control.value = value;
    }
  }

  async function loadFilterOptions(force) {
    const options = await TTWeb.api("/api/pivot-filters", {
      range: TTWeb.getRange(),
      force: force ? "1" : undefined,
    });
    filterNames.forEach((name) => populateFilter(name, options[name] || []));
    applyFilterQuery();
  }

  function populateFilter(name, values) {
    const select = TTWeb.qs(`#${name}-filter`);
    if (!select) {
      return;
    }
    const selected = desiredFilterValue(name);
    const allValues = values.slice();
    if (selected && !allValues.includes(selected)) {
      allValues.push(selected);
    }
    select.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = filterAllLabels[name];
    select.appendChild(allOption);
    allValues.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.value = selected || "";
    select.disabled = false;
  }

  function desiredFilterValue(name) {
    return TTWeb.params().get(name) || (TTWeb.qs(`#${name}-filter`) && TTWeb.qs(`#${name}-filter`).value) || "";
  }

  function applyFilterQuery() {
    const query = TTWeb.params();
    filterNames.forEach((name) => {
      setValue(`#${name}-filter`, query.get(name) || "");
    });
  }

  function syncQuery() {
    TTWeb.setParam("x", TTWeb.qs("#x-dim").value);
    TTWeb.setParam("group", TTWeb.qs("#group-dim").value);
    TTWeb.setParam("metric", TTWeb.qs("#metric").value);
    TTWeb.setParam("range", TTWeb.qs("#range").value);
    syncFilterQuery();
  }

  function syncFilterQuery() {
    const url = new URL(window.location.href);
    filterNames.forEach((name) => url.searchParams.delete(name));
    Object.entries(selectedFilters()).forEach(([name, value]) => {
      url.searchParams.set(name, value);
    });
    window.history.replaceState(null, "", url.pathname + url.search);
  }

  function selectedFilters() {
    const filters = {};
    filterNames.forEach((name) => {
      const control = TTWeb.qs(`#${name}-filter`);
      const value = control ? control.value : "";
      if (value) {
        filters[name] = value;
      }
    });
    return filters;
  }

  async function loadPivot(force) {
    const x = TTWeb.qs("#x-dim").value;
    const group = TTWeb.qs("#group-dim").value;
    const metric = TTWeb.qs("#metric").value;
    const range = TTWeb.getRange();
    TTWeb.qs("#pivot-status").textContent = "Loading";
    const data = await TTWeb.api(
      "/api/pivot",
      Object.assign({ x, group, metric, range, force: force ? "1" : undefined }, selectedFilters())
    );
    renderChart(data, x, metric);
    renderTable(data, metric);
    TTWeb.qs("#pivot-status").textContent = hasNoPivotData(data) ? "No data" : chartType(x) + " chart";
    TTWeb.qs("#pivot-count").textContent = TTWeb.integer(data.rows.length) + " rows";
  }

  function chartType(x) {
    return timeDims.has(x) ? "line" : "bar";
  }

  function hasNoPivotData(data) {
    return !data.rows.length || !data.columns.length;
  }

  function renderChart(data, x, metric) {
    if (hasNoPivotData(data)) {
      renderEmptyChart();
      return;
    }
    setChartEmptyState(false);
    const type = chartType(x);
    const xLabels = data.rows.map((row) => displayLabel(row.x, x));
    const datasets = data.columns.map((column, index) => {
      const label = displayLabel(column, TTWeb.qs("#group-dim").value);
      return TTWeb.dataset(label.text, data.rows.map((row) => row.values[column]), index, {
        fill: false,
        spanGaps: true,
        fullLabel: label.fullLabel,
      });
    });
    TTWeb.chart("pivot", "pivot-chart", {
      type,
      data: {
        labels: xLabels.map((label) => label.text),
        datasets,
      },
      options: TTWeb.chartOptions({
        indexAxis: type === "bar" ? "y" : "x",
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              title(items) {
                if (!items.length) {
                  return "";
                }
                const label = xLabels[items[0].dataIndex];
                return label ? label.fullLabel : "";
              },
              label(context) {
                const value = context.raw;
                const label = context.dataset.fullLabel || context.dataset.label;
                return `${label}: ${formatValue(value, metric)}`;
              },
            },
          },
        },
      }),
    });
  }

  function renderEmptyChart() {
    if (window.ttWebCharts && window.ttWebCharts.pivot) {
      window.ttWebCharts.pivot.destroy();
      delete window.ttWebCharts.pivot;
    }
    const canvas = TTWeb.qs("#pivot-chart");
    if (canvas) {
      const context = canvas.getContext("2d");
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    setChartEmptyState(true);
  }

  function setChartEmptyState(show) {
    const canvas = TTWeb.qs("#pivot-chart");
    if (!canvas) {
      return;
    }
    const box = canvas.closest(".chart-box");
    if (!box) {
      return;
    }
    let empty = TTWeb.qs("#pivot-chart-empty", box);
    if (!empty) {
      empty = document.createElement("div");
      empty.id = "pivot-chart-empty";
      empty.className = "empty-state chart-empty-state";
      empty.textContent = "— no data";
      box.appendChild(empty);
    }
    empty.hidden = !show;
    canvas.hidden = show;
  }

  function renderTable(data, metric) {
    const table = TTWeb.qs("#pivot-table");
    const xDim = TTWeb.qs("#x-dim").value;
    const groupDim = TTWeb.qs("#group-dim").value;
    const header = ["<thead><tr><th>X</th>"]
      .concat(data.columns.map((column) => {
        const label = displayLabel(column, groupDim);
        return `<th class="numeric" title="${escapeHtml(label.fullLabel)}">${escapeHtml(label.text)}</th>`;
      }))
      .concat(["</tr></thead>"])
      .join("");
    if (hasNoPivotData(data)) {
      renderEmptyTable(table, header, data.columns.length + 1);
      return;
    }
    const body = data.rows
      .map((row) => {
        const xLabel = displayLabel(row.x, xDim);
        const cells = data.columns
          .map((column) => `<td class="numeric">${formatValue(row.values[column], metric)}</td>`)
          .join("");
        return `<tr><td title="${escapeHtml(xLabel.fullLabel)}">${escapeHtml(xLabel.text)}</td>${cells}</tr>`;
      })
      .join("");
    table.innerHTML = header + `<tbody>${body}</tbody>`;
  }

  function renderEmptyTable(table, header, colspan) {
    table.innerHTML = `${header}<tbody><tr><td class="empty-state" colspan="${colspan}">— no data</td></tr></tbody>`;
  }

  function displayLabel(value, dim) {
    const fullLabel = String(value || "");
    if (dim !== "project") {
      return { text: fullLabel, fullLabel };
    }
    return { text: projectDisplayLabel(value), fullLabel };
  }

  function projectDisplayLabel(value) {
    const text = String(value || "");
    if (!text.startsWith("/") || text === "Other") {
      return text;
    }
    const parts = text.split("/").filter(Boolean);
    if (parts.length <= 2) {
      return parts.join("/");
    }
    return parts.slice(-2).join("/");
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
