(function () {
  const presets = {
    "daily-cost": { x: "day", group: "agent", metric: "cost" },
    "project-cost": { x: "project", group: "none", metric: "cost" },
    "model-tokens": { x: "model", group: "agent", metric: "total" },
    "agent-project": { x: "agent", group: "project", metric: "cost" },
    cache: { x: "day", group: "agent", metric: "cache_read" },
  };

  const timeDims = new Set(["day", "week", "month"]);
  const filterNames = ["agent", "project", "model", "machine"];
  const filterAllLabels = { agent: "All agents", project: "All projects", model: "All models", machine: "All machines" };
  let xDimPinned = false;
  let loadGeneration = 0;

  async function init() {
    const controls = ["#x-dim", "#group-dim", "#metric", "#range"].map((selector) => TTWeb.qs(selector));
    applyQuery();
    async function load(force) {
      const generation = ++loadGeneration;
      const before = await TTWeb.api("/api/sync-status");
      if (!isCurrentLoad(generation)) return;
      await loadFilterOptions(force, undefined, generation);
      if (!isCurrentLoad(generation)) return;
      await loadPivot(false, undefined, generation);
      if (!isCurrentLoad(generation)) return;
      let status = await TTWeb.api("/api/sync-status");
      if (!isCurrentLoad(generation)) return;
      TTWeb.renderSyncStatus(status);
      if (status.syncing) {
        status = await TTWeb.waitForSyncTerminal(status, {
          isCurrent: () => isCurrentLoad(generation),
        });
        if (!isCurrentLoad(generation)) return;
        if (status.polling_error) return;
      }
      if (force || status.completed_at !== before.completed_at) {
        await loadFilterOptions(false, false, generation);
        if (!isCurrentLoad(generation)) return;
        await loadPivot(false, false, generation);
      }
    }
    TTWeb.bindShell(load, { range: false });
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
          await load(false);
        });
      }
    });
    TTWeb.qsa("[data-filter-control]").forEach((control) => {
      control.addEventListener("change", async () => {
        syncQuery();
        await load(false);
      });
    });
    TTWeb.qsa(".preset-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const preset = presets[button.dataset.preset];
        TTWeb.qs("#x-dim").value = preset.x;
        TTWeb.qs("#group-dim").value = preset.group;
        TTWeb.qs("#metric").value = preset.metric;
        xDimPinned = true;
        syncQuery();
        await load(false);
      });
    });
    await load(false);
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

  function isCurrentLoad(generation) {
    return generation === loadGeneration;
  }

  async function loadFilterOptions(force, allowSync, generation) {
    const options = await TTWeb.api("/api/pivot-filters", {
      range: TTWeb.getRange(),
      force: force ? "1" : undefined,
      sync: allowSync === false ? "0" : undefined,
    });
    if (generation !== undefined && !isCurrentLoad(generation)) {
      return;
    }
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

  async function loadPivot(force, allowSync, generation) {
    const x = TTWeb.qs("#x-dim").value;
    const group = TTWeb.qs("#group-dim").value;
    const metric = TTWeb.qs("#metric").value;
    const range = TTWeb.getRange();
    TTWeb.qs("#pivot-status").textContent = "Loading";
    const data = await TTWeb.api(
      "/api/pivot",
      Object.assign({ x, group, metric, range, force: force ? "1" : undefined, sync: allowSync === false ? "0" : undefined }, selectedFilters())
    );
    if (generation !== undefined && !isCurrentLoad(generation)) {
      return;
    }
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

  // A chart that quietly shows fewer series than the data has reads as if it
  // showed all of them, so say what was left out and where to find it.
  function renderSeriesLimitNote(plotted, columnCount) {
    const note = TTWeb.qs("#pivot-series-note");
    if (!note) {
      return;
    }
    if (plotted.dropped > 0) {
      note.hidden = false;
      // Not "the N smallest": ranking counts a null as zero, and for cost a
      // null is either no activity or an unknown price. A series nobody could
      // price therefore ranks at the bottom whatever it actually cost, so the
      // note states the basis instead of asserting a size order it cannot know.
      note.textContent = `Charting ${TTWeb.SERIES_LIMIT} of ${columnCount} series, ranked by known cost. The other ${plotted.dropped} are not plotted, and a series whose pricing tt-web does not know ranks low here regardless of what it actually cost — for the same reason the remainder cannot be pooled into an "Other" line. Every series is listed in the table below.`;
      return;
    }
    note.hidden = true;
    note.textContent = "";
  }

  // The palette has a fixed number of slots and no ninth hue to hand out, so a
  // grouping that produces more series than that (group by model, typically)
  // cannot draw them all. What happens to the remainder depends on the metric.
  //
  // For token and message metrics the server writes 0 for a bucket a column had
  // no activity in, so the tail sums cleanly into one "Other" line.
  //
  // Cost is different: `aggregators.pivot` writes null both when a column had no
  // activity in that bucket AND when it had activity whose price tt-web does not
  // know. Those two are indistinguishable by the time they reach us, so summing
  // the non-null members would publish a figure that silently omits real spend
  // and still reads as a complete total. Rather than fabricate that number, the
  // smallest columns are left out of the chart and the omission is stated; the
  // table below the chart continues to list every column, unknowns included.
  function foldColumnsToSeriesLimit(data, metric) {
    const seriesOf = (column) => data.rows.map((row) => row.values[column]);
    const columns = data.columns.map((key) => ({ key, series: seriesOf(key) }));
    if (columns.length <= TTWeb.SERIES_LIMIT) {
      return { columns, dropped: 0, folded: 0 };
    }
    const total = (series) => series.reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0);
    const ranked = columns.slice().sort((a, b) => total(b.series) - total(a.series));

    if (metric === "cost") {
      return {
        columns: ranked.slice(0, TTWeb.SERIES_LIMIT),
        dropped: columns.length - TTWeb.SERIES_LIMIT,
        folded: 0,
      };
    }

    const head = ranked.slice(0, TTWeb.SERIES_LIMIT - 1);
    const tail = ranked.slice(TTWeb.SERIES_LIMIT - 1);
    const merged = data.rows.map((row, rowIndex) =>
      tail.reduce((sum, column) => sum + Number(column.series[rowIndex] || 0), 0)
    );
    return {
      columns: head.concat([{ other: true, label: `Other (${tail.length})`, series: merged }]),
      dropped: 0,
      folded: tail.length,
    };
  }

  function renderChart(data, x, metric) {
    if (hasNoPivotData(data)) {
      // Clear the note here too, or an empty chart keeps claiming it is
      // plotting a subset of series that are no longer on screen.
      renderSeriesLimitNote({ dropped: 0 }, 0);
      renderEmptyChart();
      return;
    }
    setChartEmptyState(false);
    const type = chartType(x);
    const xLabels = data.rows.map((row) => displayLabel(row.x, x));
    const plotted = foldColumnsToSeriesLimit(data, metric);
    renderSeriesLimitNote(plotted, data.columns.length);
    const datasets = plotted.columns.map((column, index) => {
      if (column.other) {
        return TTWeb.dataset(column.label, column.series, index, {
          fill: false,
          spanGaps: true,
          fullLabel: column.label,
        });
      }
      const label = displayLabel(column.key, TTWeb.qs("#group-dim").value);
      return TTWeb.dataset(label.text, column.series, index, {
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
    // The table leads with the row the reader came for. On every other x
    // dimension that is already the largest total; on a time axis it is the
    // most recent bucket, which the server orders last because the chart above
    // needs its axis running forward. Reversing here rather than in `data.rows`
    // keeps the chart on the chronological order it requires.
    const orderedRows = timeDims.has(xDim) ? data.rows.slice().reverse() : data.rows;
    const body = orderedRows
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
