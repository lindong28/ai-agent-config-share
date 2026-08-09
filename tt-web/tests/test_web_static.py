import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebStaticTests(unittest.TestCase):
    def test_overview_shows_only_codex_weekly_quota(self):
        html = (ROOT / "web" / "index.html").read_text()

        self.assertIn(">Codex 7d<", html)
        self.assertNotIn(">Codex 5h<", html)
        self.assertIn(">Claude 5h<", html)
        self.assertIn(">Claude 7d<", html)

    def test_overview_keeps_the_latest_successful_response(self):
        js = (ROOT / "web" / "app.js").read_text()

        self.assertIn("overviewGeneration", js)
        self.assertIn("renderedOverviewGeneration", js)
        self.assertIn("generation < renderedOverviewGeneration", js)
        self.assertIn("overview-load-error", js)

    def test_new_javascript_removes_the_visible_legacy_codex_card(self):
        js = (ROOT / "web" / "app.js").read_text()

        self.assertIn('qs("#codex-five-hour")', js)
        self.assertIn('closest(".kpi-card")', js)

    def test_overview_side_panel_links_preserve_selected_range(self):
        html = (ROOT / "web" / "index.html").read_text()

        self.assertIn('href="/explore?x=project&group=none&metric=cost"', html)
        self.assertIn('href="/explore?x=model&group=agent&metric=total"', html)
        self.assertEqual(html.count("data-preserve-range"), 2)

    def test_sessions_retention_note_describes_mixed_source_retention(self):
        html = (ROOT / "web" / "sessions.html").read_text()

        # The invariant is that the note gives a different window per source
        # rather than one figure covering both. The earlier wording carried it
        # in mixed Chinese and English; the wording is now English throughout.
        self.assertIn("Only sessions whose raw logs still exist are listed", html)
        self.assertIn("roughly 30 days for Claude Code", html)
        self.assertIn("often longer for Codex", html)

    def test_g2_explore_has_four_single_select_filter_controls(self):
        html = (ROOT / "web" / "explore.html").read_text()

        for name, label, all_label in [
            ("agent", "Agent filter", "All agents"),
            ("project", "Project filter", "All projects"),
            ("model", "Model filter", "All models"),
            ("machine", "Machine filter", "All machines"),
        ]:
            with self.subTest(name=name):
                self.assertIn(f'<label for="{name}-filter">{label}</label>', html)
                self.assertIn(f'id="{name}-filter"', html)
                self.assertIn(f'data-filter-control="{name}"', html)
                self.assertIn(f'aria-label="{label}"', html)
                self.assertIn(f'<option value="">{all_label}</option>', html)
        self.assertNotIn("multiple", html)
        self.assertNotIn("size=\"2\"", html)
        self.assertNotIn("size=\"4\"", html)
        self.assertNotIn("clear-filters", html)
        self.assertNotIn("filter-summary", html)
        self.assertNotIn('data-filter-control="machine"', (ROOT / "web" / "index.html").read_text())

    def test_pivot_js_wires_filter_controls_to_url_and_api(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        self.assertIn('filterNames = ["agent", "project", "model", "machine"]', js)
        self.assertIn("applyFilterQuery()", js)
        self.assertIn("syncFilterQuery()", js)
        self.assertIn("selectedFilters()", js)
        self.assertIn('query.get(name)', js)
        self.assertIn('url.searchParams.set(name, value)', js)
        self.assertNotIn('query.getAll(name)', js)
        self.assertNotIn('url.searchParams.append(name, value)', js)
        self.assertIn("Object.assign({ x, group, metric, range", js)

    def test_g4_status_surface_and_refresh_terminal_polling_are_present(self):
        overview = (ROOT / "web" / "index.html").read_text()
        explore = (ROOT / "web" / "explore.html").read_text()
        app = (ROOT / "web" / "app.js").read_text()

        for html in (overview, explore):
            self.assertIn('aria-label="Machine sync status"', html)
            self.assertIn('id="sync-coverage"', html)
            self.assertIn('id="sync-machines"', html)
        for token in (
            "coverage ${coverage.admitted}/${coverage.declared}",
            "Excluded from All",
            "Included in All using the last generation",
            "unreachable",
            "never",
            "stale",
            "waitForSyncTerminal",
        ):
            self.assertIn(token, app)

    def test_g7_sessions_and_network_are_marked_this_machine_only(self):
        for filename in ("sessions.html", "network.html"):
            html = (ROOT / "web" / filename).read_text()
            with self.subTest(filename=filename):
                self.assertIn("This machine", html)
                self.assertIn("this machine only", html)

    def test_pivot_js_shortens_project_labels_but_keeps_full_title(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        self.assertIn("displayLabel(value, dim)", js)
        self.assertIn("projectDisplayLabel(value)", js)
        self.assertIn("fullLabel", js)
        self.assertIn("title=", js)

    def test_explore_explains_codex_cost_estimates(self):
        html = (ROOT / "web" / "explore.html").read_text()

        self.assertIn("Codex cost is estimated from GPT-5 pricing when exact billing is not present", html)
        self.assertIn("GLM-5.1/5.2 cost is estimated from bundled GLM-5 pricing", html)

    def test_pivot_js_renders_explicit_empty_states(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        self.assertIn("hasNoPivotData(data)", js)
        self.assertIn("renderEmptyChart()", js)
        self.assertIn("renderEmptyTable(table", js)
        self.assertIn("no data", js)
        self.assertIn("colspan", js)

    def test_pivot_table_leads_with_the_newest_time_bucket(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        # The server orders time buckets forward because the chart's axis needs
        # them that way; the table reverses its own copy so the newest row is
        # not several screens down. Reversing `data.rows` in place instead
        # would drag the chart's axis backwards with it.
        self.assertIn("timeDims.has(xDim) ? data.rows.slice().reverse() : data.rows", js)
        self.assertIn("const body = orderedRows", js)


if __name__ == "__main__":
    unittest.main()
