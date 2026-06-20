import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebStaticTests(unittest.TestCase):
    def test_overview_side_panel_links_preserve_selected_range(self):
        html = (ROOT / "web" / "index.html").read_text()

        self.assertIn('href="/explore?x=project&group=none&metric=cost"', html)
        self.assertIn('href="/explore?x=model&group=agent&metric=total"', html)
        self.assertEqual(html.count("data-preserve-range"), 2)

    def test_sessions_retention_note_describes_mixed_source_retention(self):
        html = (ROOT / "web" / "sessions.html").read_text()

        self.assertIn("Sessions 只显示仍存在的原始日志", html)
        self.assertIn("Claude 通常约 30 天", html)
        self.assertIn("Codex 可能更久", html)
        self.assertNotIn("原始日志保留约 ~30 天", html)

    def test_explore_has_agent_project_model_filter_controls(self):
        html = (ROOT / "web" / "explore.html").read_text()

        for name, label, all_label in [
            ("agent", "Agent filter", "All agents"),
            ("project", "Project filter", "All projects"),
            ("model", "Model filter", "All models"),
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

    def test_pivot_js_wires_filter_controls_to_url_and_api(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        self.assertIn('filterNames = ["agent", "project", "model"]', js)
        self.assertIn("applyFilterQuery()", js)
        self.assertIn("syncFilterQuery()", js)
        self.assertIn("selectedFilters()", js)
        self.assertIn('query.get(name)', js)
        self.assertIn('url.searchParams.set(name, value)', js)
        self.assertNotIn('query.getAll(name)', js)
        self.assertNotIn('url.searchParams.append(name, value)', js)
        self.assertIn("Object.assign({ x, group, metric, range", js)

    def test_pivot_js_shortens_project_labels_but_keeps_full_title(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        self.assertIn("displayLabel(value, dim)", js)
        self.assertIn("projectDisplayLabel(value)", js)
        self.assertIn("fullLabel", js)
        self.assertIn("title=", js)

    def test_explore_explains_codex_cost_estimates(self):
        html = (ROOT / "web" / "explore.html").read_text()

        self.assertIn("Codex cost is 推算 from GPT-5 pricing when exact billing is not present.", html)
        self.assertIn("GLM-5.1/5.2 cost is 推算 from bundled GLM-5 pricing.", html)

    def test_pivot_js_renders_explicit_empty_states(self):
        js = (ROOT / "web" / "pivot.js").read_text()

        self.assertIn("hasNoPivotData(data)", js)
        self.assertIn("renderEmptyChart()", js)
        self.assertIn("renderEmptyTable(table", js)
        self.assertIn("no data", js)
        self.assertIn("colspan", js)


if __name__ == "__main__":
    unittest.main()
