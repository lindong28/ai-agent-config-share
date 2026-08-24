import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebStaticTests(unittest.TestCase):
    def test_overview_shows_only_codex_weekly_quota(self):
        """Codex reports no 5h window, so no Codex row may offer a value there.

        Every row emits every column so they align; which of them a provider
        actually has is a membership test, and the cell for one it does not have
        says so rather than sitting empty like missing data.
        """
        js = (ROOT / "web" / "app.js").read_text()

        claude = self.quota_provider_config(js, "claude")
        codex = self.quota_provider_config(js, "codex")

        self.assertIn("QUOTA_WINDOW_5H", claude)
        self.assertIn("QUOTA_WINDOW_7D", claude)
        self.assertNotIn("QUOTA_WINDOW_5H", codex)
        self.assertIn("QUOTA_WINDOW_7D", codex)
        # The config constrains rendering only if the renderer reads it. Without
        # these, a row that emitted a value for every column would leave the
        # assertions above true while every Codex row grew a 5h figure.
        self.assertIn("QUOTA_COLUMNS.forEach((spec) => row.appendChild(quotaWindowCell", js)
        # "n/a" and the em dash are different facts: no such window at all, vs
        # no reading for one that exists. One glyph in two weights carries
        # neither to a screen reader nor to anyone who cannot hover a tooltip.
        self.assertIn('cell.textContent = "n/a"', js)
        self.assertIn("window.key === spec.key", js)
        self.assertIn("reports no ${spec.key} window", js)

    def test_overview_range_card_names_the_window_it_reports(self):
        """A cost figure whose window comes from a control elsewhere on the page
        has to carry that window in its own heading, and must not claim a wider
        one than the stored history covers.

        Driven through renderRangeCost rather than grepped: the label is built,
        not literal, and the coverage qualifier appears only for some payloads.
        """
        script = r'''
const fs = require("fs");

function makeNode() {
  return { textContent: "" };
}

const nodes = {
  "#range-label": makeNode(),
  "#range-cost": makeNode(),
  "#range-tokens": makeNode(),
};

global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  body: { appendChild() {} },
  addEventListener() {},
  querySelector(selector) { return nodes[selector] || null; },
  querySelectorAll() { return []; },
  createElement() { return makeNode(); },
};

const source = fs.readFileSync("web/app.js", "utf8").replace(
  "window.TTWeb = {",
  "window.TTWeb = { renderRangeCost,",
);
eval(source);

const spend = { cost_usd: 54057.3423242, tokens: 68056341922 };

function read(range, selected, coverage) {
  Object.values(nodes).forEach((node) => { node.textContent = ""; });
  window.TTWeb.renderRangeCost(range, selected, coverage);
  return {
    label: nodes["#range-label"].textContent,
    cost: nodes["#range-cost"].textContent,
    tokens: nodes["#range-tokens"].textContent,
  };
}

const partial = { earliest_date: "2026-04-21", partial_before_range: true };
const complete = { earliest_date: "2026-04-21", partial_before_range: false };

process.stdout.write(JSON.stringify({
  thirtyDays: read(spend, "30d", complete),
  allHistory: read(spend, "all", complete),
  allHistoryPartial: read(spend, "all", partial),
  noCoverage: read(spend, "30d", null),
  // What `_rollup_coverage` returns on a host that has never rolled up:
  // a full dict that knows nothing. The zeros are what such a host reports.
  emptyRollup: read({ cost_usd: 0, tokens: 0 }, "all",
    { earliest_date: null, range_start: null, partial_before_range: false }),
  // Positively partial but with no date to name — no current producer emits
  // this, but the branch must not read it as "covered".
  partialNoDate: read(spend, "all", { partial_before_range: true, earliest_date: null }),
  legacyPayload: read(undefined, "30d", complete),
}));
'''
        html = (ROOT / "web" / "index.html").read_text()
        # The stub below answers to these three selector strings whatever the
        # markup says, so the behavioural half of this test passes even if an id
        # is renamed. Pin them here, as #quota-accounts already is.
        for element_id in ("range-label", "range-cost", "range-tokens"):
            self.assertIn(f'id="{element_id}"', html)

        result = subprocess.run(
            ["node", "-e", script], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)

        # The heading, not the toolbar, says which window the figure covers.
        self.assertEqual(payload["thirtyDays"]["label"], "Last 30d cost")
        self.assertEqual(payload["allHistory"]["label"], "All-history cost")
        self.assertEqual(payload["thirtyDays"]["cost"], "$54057.34")

        # "All history" is the widest claim on the page and the one this host
        # cannot honour: the rollup starts at a collection date. The qualifier
        # travels with the figure rather than living a screen below it.
        self.assertNotIn("2026-04-21", payload["allHistory"]["tokens"])
        self.assertIn("2026-04-21", payload["allHistoryPartial"]["tokens"])
        self.assertIn("68,056,341,922 tokens", payload["allHistoryPartial"]["tokens"])
        # Silence about coverage is not a report of full coverage. The branch
        # keys on what coverage said, not on whether the object arrived — the
        # producer returns a full dict even when it knows nothing.
        self.assertNotIn("2026-04-21", payload["noCoverage"]["tokens"])
        self.assertIn("覆盖范围未知", payload["noCoverage"]["tokens"])
        self.assertIn("覆盖范围未知", payload["partialNoDate"]["tokens"])
        self.assertNotIn("覆盖范围未知", payload["thirtyDays"]["tokens"])

        # An empty rollup DB is the case that matters most, because its numbers
        # are zeros: "we collected nothing" must not render as "you spent
        # nothing ever" under the widest heading the page can show.
        self.assertEqual(payload["emptyRollup"]["label"], "All-history cost")
        self.assertEqual(payload["emptyRollup"]["cost"], "$0.00")
        self.assertIn("覆盖范围未知", payload["emptyRollup"]["tokens"])

        # A server that predates the field must not leave a live-looking heading
        # over a zero or a stale figure.
        self.assertEqual(payload["legacyPayload"]["cost"], "—")
        self.assertNotIn("tokens", payload["legacyPayload"]["tokens"])

    def test_overview_quota_is_a_table_with_a_column_per_window(self):
        """Alignment across rows is what the reader compares on. A table gives
        it by construction; the card layout it replaced needed fixed CSS slots
        to simulate it, and got it wrong by 260px before that."""
        html = (ROOT / "web" / "index.html").read_text()
        js = (ROOT / "web" / "app.js").read_text()
        prose = " ".join(html.split())

        self.assertIn('<table id="quota-accounts"', prose)
        header = re.search(r"<thead>\s*<tr>(.*?)</tr>\s*</thead>", prose).group(1)
        self.assertEqual(
            re.findall(r">([^<]+)</th>", header),
            ["Provider", "Plan", "Account", "5h used", "7d used", "Machines", "Updated"],
        )
        # Two files decide one thing. The header row is static markup; the cells
        # under it are emitted in QUOTA_COLUMNS order. Reorder one and every
        # figure lands under the wrong heading with nothing failing — the values
        # are all still there, just relabelled.
        columns = re.search(r"const QUOTA_COLUMNS = \[([^\]]+)\]", js).group(1)
        self.assertEqual(
            [name.strip() for name in columns.split(",") if name.strip()],
            ["QUOTA_WINDOW_5H", "QUOTA_WINDOW_7D"],
        )
        self.assertIn("renderQuotaAccounts", js)
        # A value belongs under the header of the window it came from. The
        # collapsed group's highest-usage pill was placed in the second cell
        # regardless of which window produced it, so a 5h figure could sit under
        # "7d used" — in a table the column is the claim.
        self.assertIn("worst.spec === spec", js)
        # The one thing the numbers cannot say for themselves: rows are per
        # account and must not be added up.
        self.assertIn("quota is metered per account", prose)
        self.assertIn("rows are never added together", prose)

    def test_overview_quota_reads_as_consumption(self):
        """The section states what has been used directly, without making the
        reader invert a remaining percentage before comparing accounts."""
        html = (ROOT / "web" / "index.html").read_text()
        js = (ROOT / "web" / "app.js").read_text()
        prose = " ".join(html.split())

        self.assertIn("Quota Used", prose)
        self.assertNotIn("Quota remaining", prose)
        # The figure in the cell is the rounded source usage, not its inverse.
        self.assertIn("`${used}%`", js)
        self.assertIn("const used = Math.round(usedPct)", js)
        # The bar must run the same way as the number beside it. Filling with
        # what remains would pair a long bar with a small used percentage.
        self.assertIn("quotaMeter(used)", js)

    def test_overview_quota_flags_low_headroom_in_words_not_only_colour(self):
        """A row the reader must act on has to survive for a reader who cannot
        see the colour it is drawn in."""
        js = (ROOT / "web" / "app.js").read_text()

        self.assertIn("running low", js)
        self.assertIn("almost out", js)
        self.assertIn("QUOTA_BAND_CRITICAL", js)
        self.assertIn("QUOTA_BAND_LOW", js)

    def test_the_plan_cell_states_a_disagreement_and_stays_silent_otherwise(self):
        """Three states, and only one of them is ever asserted on the page.

        The row's plan and its quota figures come from one event; the
        credential file is a separate clock. One event, not one
        observation — a figure whose window has since reset is rewritten
        to zero while the plan keeps what the event reported. When the two plans disagree the cell says so
        — in words, in the cell, not only in a hover — because otherwise the
        row reads as one observation and the reader has no way to tell.

        Having nothing to compare against renders the same as agreement — the
        page asserts nothing in either case, and putting a permanent caveat on
        every Claude row (whose reading never carries a plan) would be noise,
        not information. What must not collapse is the payload: the two states
        stay tellable apart there, which `test_account_identity` pins. Here
        the fixtures only have to prove the marker itself does not misfire on
        any of them — signed out, an unreadable credential file, an API-key
        machine, a remembered row, an exporter older than the field.

        The comparison reads the two raw plans, never the derived one: with
        `account_plan` on the left the credential-only case would compare the
        credential against itself and could never disagree, which looks
        identical to working correctly.
        """
        script = r'''
const fs = require("fs");

function makeNode(tagName = "div") {
  let ownText = "";
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    attributes: {},
    children: [],
    style: { values: {}, setProperty(name, value) { this.values[name] = String(value); } },
    listeners: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
  node.classList = {
    add(...names) {
      const values = new Set(node.className.split(/\s+/).filter(Boolean));
      names.forEach((name) => values.add(name));
      node.className = Array.from(values).join(" ");
    },
    contains(name) { return node.className.split(/\s+/).includes(name); },
  };
  Object.defineProperty(node, "textContent", {
    get() { return ownText + node.children.map((child) => child.textContent || "").join(""); },
    set(value) { ownText = String(value); node.children = []; },
  });
  return node;
}

function descendants(node) {
  return [node].concat(node.children.flatMap((child) => descendants(child)));
}

global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  body: makeNode("body"),
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tagName) { return makeNode(tagName); },
  createTextNode(text) { const node = makeNode("#text"); node.textContent = text; return node; },
};

const source = fs.readFileSync("web/app.js", "utf8").replace(
  "window.TTWeb = {",
  "window.TTWeb = { quotaPlanCell,",
);
eval(source);

function reading(account) {
  const cell = window.TTWeb.quotaPlanCell(account);
  const marker = descendants(cell)
    .filter((node) => node.className.split(/\s+/).includes("quota-plan-mismatch"))[0];
  return {
    text: cell.textContent,
    marker: marker ? { text: marker.textContent, title: marker.title || "" } : null,
  };
}

const known = {
  account_id: "acct-1",
  account_label: "a@b.c",
  account_state: "known",
  presence: "in_use",
};

process.stdout.write(JSON.stringify({
  disagree: reading({
    ...known, account_plan: "pro", reading_plan: "pro", credential_plan: "prolite",
  }),
  agree: reading({
    ...known, account_plan: "pro", reading_plan: "pro", credential_plan: "pro",
  }),
  // Only the credential has a plan, and the derived value copies it. Comparing
  // account_plan against the credential here would compare "prolite" with
  // itself — silent for the wrong reason, and indistinguishable from working.
  credentialOnly: reading({
    ...known, account_plan: "prolite", reading_plan: null, credential_plan: "prolite",
  }),
  readingOnly: reading({
    ...known, account_plan: "pro", reading_plan: "pro", credential_plan: null,
  }),
  // An older exporter sends neither raw field, and its account_plan still
  // carries the old meaning — the credential plan. Using "pro" here would
  // pin nothing: it is the value the new semantics produce.
  olderExporter: reading({ ...known, account_plan: "prolite" }),
  // Both of these mirror what the exporter can actually emit. Signed out means
  // no account object, so there is no credential plan to carry; unstamped means
  // a block old enough to have no account key at all, which cannot have these
  // fields either. Fixtures that gave them a credential plan would have pinned
  // the account_state guard against a shape no producer reaches.
  signedOut: reading({
    ...known,
    account_state: "signed_out",
    account_plan: "pro",
    reading_plan: "pro",
    credential_plan: null,
  }),
  unstamped: reading({ ...known, account_state: "unstamped", account_plan: "prolite" }),
  remembered: reading({
    ...known,
    presence: "remembered",
    account_plan: "pro",
    reading_plan: null,
    credential_plan: null,
  }),
  planless: reading({ ...known, account_plan: null, credential_plan: "prolite" }),
  nonString: reading({
    ...known, account_plan: "pro", reading_plan: "pro", credential_plan: 7,
  }),
}));
'''
        result = subprocess.run(
            ["node", "-e", script], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)

        # Disagreement is stated, with both values, and both are named in
        # readable text rather than left to the reader to infer from a badge.
        disagree = payload["disagree"]
        self.assertIsNotNone(disagree["marker"])
        visible = disagree["marker"]["text"]
        # The claim itself, not two values left side by side for the reader to
        # draw the conclusion from — and in the cell, because a title is not a
        # channel on touch or from the keyboard.
        self.assertIn("不一致", visible)
        # Both sources named where they are read, so the visible text stands on
        # its own: which value came from the reading, which from the machine.
        self.assertIn("Pro Lite", visible)
        self.assertIn("Pro", visible)
        self.assertIn("读数", visible)
        self.assertIn("凭据", visible)
        # The claim is that they differ, not that one of them is stale: which
        # is older is not knowable from the pair, and the sample that prompted
        # this had the reading newer than the credential file.
        for word in ("早于", "过期", "陈旧", "stale"):
            self.assertNotIn(word, disagree["marker"]["title"])

        # Every other state is silent — and silence here is not a claim of
        # agreement, which is exactly why none of them may raise the marker.
        for case in (
            "agree",
            "credentialOnly",
            "readingOnly",
            "olderExporter",
            "signedOut",
            "unstamped",
            "remembered",
            "nonString",
        ):
            with self.subTest(case=case):
                self.assertIsNone(payload[case]["marker"])

        # No plan at all keeps the existing placeholder (ux-contract G4c);
        # a credential-side plan does not get promoted into the empty slot.
        self.assertEqual(payload["planless"]["text"], "—")

    def test_remembered_quota_rows_are_historical_without_changing_live_alerts(self):
        """A frozen reading is historical context, not a present-tense alarm.

        The same remembered account exercises both sides of its own reset time.
        Live rows are the negative control: their provider/plan badges, stale
        warning and usage warning remain exactly where the existing UI put them.
        """
        script = r'''
const fs = require("fs");

function makeNode(tagName = "div") {
  let ownText = "";
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    attributes: {},
    children: [],
    style: {
      values: {},
      setProperty(name, value) { this.values[name] = String(value); },
    },
    listeners: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
  node.classList = {
    add(...names) {
      const values = new Set(node.className.split(/\s+/).filter(Boolean));
      names.forEach((name) => values.add(name));
      node.className = Array.from(values).join(" ");
    },
    contains(name) { return node.className.split(/\s+/).includes(name); },
  };
  Object.defineProperty(node, "textContent", {
    get() { return ownText + node.children.map((child) => child.textContent || "").join(""); },
    set(value) { ownText = String(value); node.children = []; },
  });
  Object.defineProperty(node, "cells", {
    get() { return node.children.filter((child) => child.tagName === "TD"); },
  });
  return node;
}

function descendants(node) {
  return [node].concat(node.children.flatMap((child) => descendants(child)));
}

function byClass(node, name) {
  return descendants(node).filter((item) => item.className.split(/\s+/).includes(name));
}

global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  body: makeNode("body"),
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tagName) { return makeNode(tagName); },
  createTextNode(text) { const node = makeNode("#text"); node.textContent = text; return node; },
};

const source = fs.readFileSync("web/app.js", "utf8").replace(
  "window.TTWeb = {",
  "window.TTWeb = { quotaAccountRow, quotaWindowCell, resetText,",
);
eval(source);

const now = 2000000000;
Date.now = () => now * 1000;
const futureReset = now + 3600;
const pastReset = now - 3600;
const provider = {
  key: "claude",
  label: "Claude",
  pill: "agent-claude-code",
  windows: [
    { key: "7d", used: "seven_day_used_pct", reset: "seven_day_resets_at" },
    { key: "5h", used: "five_hour_used_pct", reset: "five_hour_resets_at" },
  ],
};
const base = {
  account_id: "historical-account",
  account_label: "history@example.test",
  account_plan: "default_claude_max_20x",
  account_state: "known",
  presence: "remembered",
  // Deliberately unequal, and both still above the "almost out" threshold: with
  // one figure in both windows every assertion below reads the same whichever
  // column each landed in, so the fixture that looks like it guards placement
  // guards nothing. The two values are what make the column order observable.
  five_hour_used_pct: 96,
  five_hour_resets_at: futureReset,
  seven_day_used_pct: 91,
  seven_day_resets_at: futureReset,
  updated_at: "2026-08-20T07:53:00Z",
  machines: [],
  this_machine: null,
};

function reading(row) {
  const windows = row.cells.slice(3, 5);
  return {
    cellCount: row.cells.length,
    rowClass: row.className,
    providerText: row.cells[0].textContent,
    providerPillClass: byClass(row.cells[0], "pill")[0]?.className || "",
    planText: row.cells[1].textContent,
    accountText: row.cells[2].textContent,
    warningTexts: byClass(row, "status-pill")
      .map((node) => node.textContent)
      .filter((text) => text === "running low" || text === "almost out"),
    staleWarningCount: descendants(row)
      .filter((node) => node.textContent === "may predate a sign-in change").length,
    historyMarkerCount: descendants(row).filter((node) => node.textContent === "已登出").length,
    historyNoteCount: descendants(row)
      .filter((node) => node.textContent === "最后观测值，不代表当前状态").length,
    observedTexts: byClass(row, "quota-window-observed").map((node) => node.textContent),
    amounts: windows.map((cell) => byClass(cell, "quota-window-value")[0]?.textContent || null),
    fills: windows.map((cell) => byClass(cell, "quota-meter-fill")[0]?.style.values["--quota-fill"] || null),
    resets: windows.map((cell) => {
      const reset = byClass(cell, "quota-window-reset")[0];
      return reset ? { text: reset.textContent, title: reset.title || "" } : null;
    }),
  };
}

function windowReading(cell) {
  const reset = byClass(cell, "quota-window-reset")[0];
  return {
    warningTexts: byClass(cell, "status-pill")
      .map((node) => node.textContent)
      .filter((text) => text === "running low" || text === "almost out"),
    observedTexts: byClass(cell, "quota-window-observed").map((node) => node.textContent),
    amount: byClass(cell, "quota-window-value")[0]?.textContent || null,
    fill: byClass(cell, "quota-meter-fill")[0]?.style.values["--quota-fill"] || null,
    reset: reset ? { text: reset.textContent, title: reset.title || "" } : null,
  };
}

const rememberedFuture = reading(window.TTWeb.quotaAccountRow(provider, base));
const rememberedPast = reading(window.TTWeb.quotaAccountRow(provider, {
  ...base,
  five_hour_resets_at: pastReset,
  seven_day_resets_at: pastReset,
}));
const rememberedUnknown = reading(window.TTWeb.quotaAccountRow(provider, {
  ...base,
  five_hour_resets_at: null,
  seven_day_resets_at: null,
}));
const livePast = reading(window.TTWeb.quotaAccountRow(provider, {
  ...base,
  presence: "in_use",
  machines: ["macbook"],
  this_machine: "macbook",
  five_hour_resets_at: pastReset,
  seven_day_resets_at: pastReset,
}));
const planless = reading(window.TTWeb.quotaAccountRow(provider, {
  ...base,
  presence: "in_use",
  account_plan: null,
  updated_at: "2099-01-01T00:00:00Z",
}));

let boundaryClockReads = 0;
Date.now = () => {
  boundaryClockReads += 1;
  return boundaryClockReads === 1 ? now * 1000 - 1 : now * 1000 + 1;
};
const rememberedBoundary = windowReading(window.TTWeb.quotaWindowCell(
  provider,
  provider.windows[0],
  { ...base, seven_day_resets_at: now },
));
Date.now = () => now * 1000;

process.stdout.write(JSON.stringify({
  rememberedFuture,
  rememberedPast,
  rememberedUnknown,
  rememberedBoundary,
  boundaryClockReads,
  livePast,
  planless,
  futureTitle: window.TTWeb.resetText(futureReset),
  pastTitle: window.TTWeb.resetText(pastReset),
  boundaryTitle: window.TTWeb.resetText(now, now * 1000 - 1),
}));
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        future = payload["rememberedFuture"]
        past = payload["rememberedPast"]
        unknown = payload["rememberedUnknown"]
        boundary = payload["rememberedBoundary"]
        live = payload["livePast"]

        self.maxDiff = None
        self.assertEqual(
            {
                "F1 unknown reset": {
                    "warnings": unknown["warningTexts"],
                    "reset_texts": [reset["text"] for reset in unknown["resets"]],
                    "observed_count": len(unknown["observedTexts"]),
                },
                "F2 boundary reset": {
                    "warnings": boundary["warningTexts"],
                    "reset_text": boundary["reset"]["text"],
                    "observed_count": len(boundary["observedTexts"]),
                    "clock_reads": payload["boundaryClockReads"],
                },
            },
            {
                "F1 unknown reset": {
                    "warnings": [],
                    "reset_texts": ["reset unknown", "reset unknown"],
                    "observed_count": 2,
                },
                "F2 boundary reset": {
                    "warnings": ["almost out"],
                    "reset_text": "resets in 1m",
                    "observed_count": 0,
                    "clock_reads": 1,
                },
            },
        )

        self.assertEqual(future["cellCount"], 7)
        self.assertEqual(future["providerText"], "Claude已登出")
        self.assertIn("agent-claude-code", future["providerPillClass"])
        self.assertEqual(future["planText"], "Max 20×")
        self.assertIn("history@example.test", future["accountText"])
        self.assertEqual(payload["planless"]["planText"], "—")

        for remembered in (future, past, unknown):
            self.assertIn("remembered", remembered["rowClass"])
            self.assertIn("stale", remembered["rowClass"])
            self.assertEqual(remembered["historyMarkerCount"], 1)
            self.assertEqual(remembered["historyNoteCount"], 1)
            self.assertEqual(remembered["staleWarningCount"], 0)
            # 5h first, then 7d — the fixture's two windows carry different
            # values, so this pair fails if the columns are ever swapped without
            # the header being swapped with them.
            self.assertEqual(remembered["amounts"], ["96%", "91%"])
            self.assertEqual(remembered["fills"], ["0.96", "0.91"])

        self.assertEqual(future["warningTexts"], ["almost out", "almost out"])
        self.assertTrue(all(reset["text"].startswith("resets in ") for reset in future["resets"]))
        self.assertEqual(
            [reset["title"] for reset in future["resets"]],
            [payload["futureTitle"], payload["futureTitle"]],
        )

        self.assertEqual(past["warningTexts"], [])
        self.assertEqual([reset["text"] for reset in past["resets"]], ["window reset", "window reset"])
        self.assertEqual(
            [reset["title"] for reset in past["resets"]],
            [payload["pastTitle"], payload["pastTitle"]],
        )
        self.assertEqual(len(past["observedTexts"]), 2)
        self.assertTrue(all(text.startswith("观测于 ") for text in past["observedTexts"]))

        self.assertEqual(unknown["warningTexts"], [])
        self.assertEqual([reset["text"] for reset in unknown["resets"]], ["reset unknown"] * 2)
        self.assertEqual([reset["title"] for reset in unknown["resets"]], [""] * 2)
        self.assertEqual(len(unknown["observedTexts"]), 2)
        self.assertTrue(all(text.startswith("观测于 ") for text in unknown["observedTexts"]))

        self.assertEqual(boundary["warningTexts"], ["almost out"])
        self.assertEqual(
            boundary["reset"],
            {"text": "resets in 1m", "title": payload["boundaryTitle"]},
        )
        self.assertEqual(boundary["observedTexts"], [])
        self.assertEqual(payload["boundaryClockReads"], 1)

        self.assertNotIn("remembered", live["rowClass"])
        self.assertIn("stale", live["rowClass"])
        self.assertEqual(live["providerText"], "Claude")
        self.assertEqual(live["planText"], "Max 20×")
        self.assertEqual(live["warningTexts"], ["almost out", "almost out"])
        self.assertEqual(live["staleWarningCount"], 1)
        self.assertEqual(live["historyMarkerCount"], 0)
        self.assertEqual(live["historyNoteCount"], 0)
        self.assertEqual(live["observedTexts"], [])

        css = (ROOT / "web" / "styles.css").read_text()
        self.assertIn(".quota-row.remembered", css)
        self.assertIn(".quota-history-note", css)

    def test_overview_renders_all_live_accounts_before_any_remembered_account(self):
        """Rendered live rows include a collapsed unattributed group."""
        script = r'''
const fs = require("fs");

function makeNode(tagName = "div") {
  let ownText = "";
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    style: { setProperty() {} },
    listeners: {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
      }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
  node.classList = {
    add(...names) {
      const values = new Set(node.className.split(/\s+/).filter(Boolean));
      names.forEach((name) => values.add(name));
      node.className = Array.from(values).join(" ");
    },
    toggle(name) {
      const values = new Set(node.className.split(/\s+/).filter(Boolean));
      const enabled = !values.has(name);
      enabled ? values.add(name) : values.delete(name);
      node.className = Array.from(values).join(" ");
      return enabled;
    },
  };
  Object.defineProperty(node, "textContent", {
    get() { return ownText + node.children.map((child) => child.textContent || "").join(""); },
    set(value) { ownText = String(value); node.children = []; },
  });
  Object.defineProperty(node, "tBodies", {
    get() { return node.children.filter((child) => child.tagName === "TBODY"); },
  });
  Object.defineProperty(node, "cells", {
    get() { return node.children.filter((child) => child.tagName === "TD"); },
  });
  return node;
}

const table = makeNode("table");
global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  body: makeNode("body"),
  addEventListener() {},
  querySelector(selector) { return selector === "#quota-accounts" ? table : null; },
  querySelectorAll() { return []; },
  createElement(tagName) { return makeNode(tagName); },
  createTextNode(text) { const node = makeNode("#text"); node.textContent = text; return node; },
};

const source = fs.readFileSync("web/app.js", "utf8").replace(
  "window.TTWeb = {",
  "window.TTWeb = { renderQuotaAccounts,",
);
eval(source);

function account(id, state, machines, presence) {
  const row = {
    account_id: id,
    account_label: id ? `${id}@example.test` : null,
    account_plan: null,
    account_state: state,
    five_hour_used_pct: 10,
    five_hour_resets_at: 4102444800,
    seven_day_used_pct: 20,
    seven_day_resets_at: 4102444800,
    updated_at: "2099-01-01T00:00:00Z",
    machines,
    this_machine: null,
  };
  if (presence !== undefined) row.presence = presence;
  return row;
}

function renderedRows() {
  return table.tBodies.flatMap((body) => body.children
    .filter((row) => row.tagName === "TR")
    .map((row) => ({
      bodyClass: body.className,
      presence: row.dataset.presence || null,
      accountId: row.dataset.accountId || null,
      columnTotal: row.cells.reduce((total, cell) => total + (cell.colSpan || 1), 0),
    })));
}

window.TTWeb.renderQuotaAccounts({
  claude: {
    accounts: [
      account(null, "unstamped", ["legacy-a"], "in_use"),
      account(null, "signed_out", ["legacy-b"], "in_use"),
      account("remembered-claude", "known", [], "remembered"),
    ],
    unavailable_reason: null,
  },
  codex: {
    accounts: [account("live-codex", "known", ["macbook"], "in_use")],
    unavailable_reason: null,
  },
});
const mixed = renderedRows();

window.TTWeb.renderQuotaAccounts({
  claude: {
    accounts: [account("old-server-claude", "known", ["macbook"])],
    unavailable_reason: null,
  },
  codex: {
    accounts: [account(null, "signed_out", ["macmini"])],
    unavailable_reason: null,
  },
});
const missingPresence = renderedRows();

window.TTWeb.renderQuotaAccounts({
  claude: { accounts: [], unavailable_reason: "missing Claude" },
  codex: { accounts: [], unavailable_reason: "missing Codex" },
});
const unavailable = renderedRows();

process.stdout.write(JSON.stringify({ mixed, missingPresence, unavailable }));
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)

        mixed = payload["mixed"]
        ordered_presence = [row["presence"] for row in mixed if row["presence"]]
        with self.subTest("collapsed unattributed live group"):
            self.assertEqual(
                ordered_presence,
                ["in_use", "in_use", "in_use", "remembered"],
            )
            collapsed = [row for row in mixed if "quota-unknown" in row["bodyClass"]]
            self.assertEqual(len(collapsed), 3)
            self.assertEqual(
                [row["presence"] for row in collapsed],
                [None, "in_use", "in_use"],
            )
        with self.subTest("old server payload without presence"):
            self.assertEqual(
                [row["presence"] for row in payload["missingPresence"]],
                ["in_use", "in_use"],
            )
        for state in (payload["mixed"], payload["missingPresence"], payload["unavailable"]):
            with self.subTest("every rendered row spans seven columns"):
                self.assertTrue(state)
                self.assertEqual({row["columnTotal"] for row in state}, {7})

    def test_only_remembered_rows_offer_confirmed_removal(self):
        script = r'''
const fs = require("fs");

function makeNode(tagName = "div") {
  let ownText = "";
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    children: [],
    parentNode: null,
    style: { setProperty() {} },
    listeners: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
      }
    },
    setAttribute(name, value) { this[name] = String(value); },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
  node.classList = { add(...names) { node.className += ` ${names.join(" ")}`; } };
  Object.defineProperty(node, "textContent", {
    get() { return ownText + node.children.map((child) => child.textContent || "").join(""); },
    set(value) { ownText = String(value); node.children = []; },
  });
  return node;
}

function findButtons(node) {
  return (node.tagName === "BUTTON" ? [node] : []).concat(
    node.children.flatMap((child) => findButtons(child))
  );
}

const confirmMessages = [];
const confirmResults = [false, true, true, true];
const fetchCalls = [];
const quotaTable = makeNode("table");
let finishRemoval;
global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
  confirm(message) { confirmMessages.push(message); return confirmResults.shift(); },
  alert() {},
};
global.fetch = (url, options) => {
  fetchCalls.push({ url: String(url), options });
  return new Promise((resolve) => {
    finishRemoval = () => resolve({
      ok: true,
      status: 200,
      async json() {
        return { account_label: "old@example.test", observed_at: "2026-08-20T07:53:00Z" };
      },
    });
  });
};
global.document = {
  readyState: "loading",
  body: makeNode("body"),
  addEventListener() {},
  querySelector(selector) { return selector === "#quota-accounts" ? quotaTable : null; },
  querySelectorAll() { return []; },
  createElement(tagName) { return makeNode(tagName); },
  createTextNode(text) { const node = makeNode("#text"); node.textContent = text; return node; },
};

const source = fs.readFileSync("web/app.js", "utf8").replace(
  "window.TTWeb = {",
  "window.TTWeb = { quotaAccountRow, formatDate,",
);
eval(source);

const account = {
  account_id: "old-account",
  account_label: "old@example.test",
  account_plan: "pro",
  account_state: "known",
  presence: "remembered",
  five_hour_used_pct: 12,
  five_hour_resets_at: 4102444800,
  seven_day_used_pct: 24,
  seven_day_resets_at: 4102444800,
  updated_at: "2026-08-20T07:53:00Z",
  machines: [],
  this_machine: null,
};
const provider = { key: "claude", label: "Claude", pill: "agent-claude-code", windows: [
  { key: "7d", used: "seven_day_used_pct", reset: "seven_day_resets_at" },
  { key: "5h", used: "five_hour_used_pct", reset: "five_hour_resets_at" },
] };

(async () => {
  const body = makeNode("tbody");
  quotaTable.appendChild(body);
  const remembered = window.TTWeb.quotaAccountRow(provider, account);
  body.appendChild(remembered);
  const buttons = findButtons(remembered);
  const live = window.TTWeb.quotaAccountRow(provider, { ...account, presence: "in_use" });

  await buttons[0].listeners.click();
  const afterCancel = { connected: remembered.parentNode === body, fetchCount: fetchCalls.length };
  const removal = buttons[0].listeners.click();
  await Promise.resolve();
  body.remove();
  const replacementBody = makeNode("tbody");
  const replacement = window.TTWeb.quotaAccountRow(provider, account);
  replacementBody.appendChild(replacement);
  quotaTable.appendChild(replacementBody);
  finishRemoval();
  await removal;

  const nextBody = makeNode("tbody");
  const nextRemembered = window.TTWeb.quotaAccountRow(provider, account);
  nextBody.appendChild(nextRemembered);
  quotaTable.appendChild(nextBody);
  const nextButtons = findButtons(nextRemembered);
  const liveRemoval = nextButtons[0].listeners.click();
  await Promise.resolve();
  nextBody.remove();
  const liveReplacementBody = makeNode("tbody");
  const liveReplacement = window.TTWeb.quotaAccountRow(
    provider,
    { ...account, presence: "in_use" },
  );
  liveReplacementBody.appendChild(liveReplacement);
  quotaTable.appendChild(liveReplacementBody);
  finishRemoval();
  await liveRemoval;

  const versionBody = makeNode("tbody");
  const versionRemembered = window.TTWeb.quotaAccountRow(provider, account);
  versionBody.appendChild(versionRemembered);
  quotaTable.appendChild(versionBody);
  const versionButtons = findButtons(versionRemembered);
  const versionRemoval = versionButtons[0].listeners.click();
  await Promise.resolve();
  versionBody.remove();
  const newerBody = makeNode("tbody");
  const newerRemembered = window.TTWeb.quotaAccountRow(
    provider,
    { ...account, updated_at: "2026-08-20T09:53:00Z" },
  );
  newerBody.appendChild(newerRemembered);
  quotaTable.appendChild(newerBody);
  finishRemoval();
  await versionRemoval;

  process.stdout.write(JSON.stringify({
    buttonCount: buttons.length,
    liveButtonCount: findButtons(live).length,
    ariaLabel: buttons[0]["aria-label"],
    confirmMessages,
    formattedObservation: window.TTWeb.formatDate(account.updated_at),
    afterCancel,
    afterConfirm: {
      originalConnected: body.parentNode === quotaTable && remembered.parentNode === body,
      replacementConnected: replacementBody.parentNode === quotaTable && replacement.parentNode === replacementBody,
      fetchCount: fetchCalls.length,
    },
    afterLiveRerender: {
      replacementConnected: liveReplacementBody.parentNode === quotaTable && liveReplacement.parentNode === liveReplacementBody,
      buttonCount: findButtons(liveReplacement).length,
      fetchCount: fetchCalls.length,
    },
    afterNewerRerender: {
      replacementConnected: newerBody.parentNode === quotaTable && newerRemembered.parentNode === newerBody,
      fetchCount: fetchCalls.length,
    },
    request: fetchCalls[0],
  }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)

        self.assertEqual(payload["buttonCount"], 1)
        self.assertEqual(payload["liveButtonCount"], 0)
        self.assertIn("old@example.test", payload["ariaLabel"])
        self.assertEqual(payload["afterCancel"], {"connected": True, "fetchCount": 0})
        self.assertEqual(
            payload["afterConfirm"],
            {
                "originalConnected": False,
                "replacementConnected": False,
                "fetchCount": 3,
            },
        )
        self.assertEqual(
            payload["afterLiveRerender"],
            {
                "replacementConnected": True,
                "buttonCount": 0,
                "fetchCount": 3,
            },
        )
        self.assertEqual(
            payload["afterNewerRerender"],
            {"replacementConnected": True, "fetchCount": 3},
        )
        for message in payload["confirmMessages"]:
            self.assertIn("old@example.test", message)
            self.assertIn(payload["formattedObservation"], message)
            self.assertIn("7d 已用 24%", message)
            self.assertIn("不可恢复", message)
        self.assertEqual(
            payload["request"]["url"],
            "http://example.test/api/account-memory/remove",
        )
        self.assertEqual(payload["request"]["options"]["method"], "POST")
        self.assertEqual(
            payload["request"]["options"]["headers"]["Content-Type"],
            "application/json",
        )
        self.assertEqual(
            json.loads(payload["request"]["options"]["body"]),
            {
                "provider": "claude",
                "account_id": "old-account",
                "observed_at": "2026-08-20T07:53:00Z",
            },
        )

    def test_overview_quota_reset_times_are_durations_with_no_zero_case(self):
        """A clock time makes the reader subtract, and is ambiguous the moment
        the reset is not today. Durations answer the question directly — but
        must never round the nearly-there case down to a bare "0h"."""
        js = (ROOT / "web" / "app.js").read_text()

        # The invariant, not the expression that currently carries it: a floor of
        # one minute, and no clock-time formatting left to be ambiguous across a
        # day boundary. Pinning the whole template would fail a rewrite that is
        # still correct.
        self.assertIn("Math.max(1,", js)
        self.assertNotIn("sameServerDay", js)
        self.assertNotIn("fmtClock", js)

    def test_overview_collapsed_unknown_group_still_raises_high_usage(self):
        """Collapsing rows that have no account must not silence them: a machine
        at 96% used is still at 96% used, and 'the fleet is behind on updates' is
        exactly when it has no account stamp."""
        js = (ROOT / "web" / "app.js").read_text()

        self.assertIn("quotaWorstUsage", js)
        self.assertIn("% used on ${worst.machine}", js)
        # Each state names its own machines: one needs tt-web updated, the other
        # needs someone to sign in, and one lumped sentence serves neither.
        self.assertIn("update tt-web on ${unstamped.join", js)
        self.assertIn("not signed in on ${signedOut.join", js)

    @staticmethod
    def quota_provider_config(js, key):
        """The QUOTA_PROVIDERS entry for one provider, as source text."""
        start = js.index('key: "%s"' % key)
        return js[start : js.index("]", start)]

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

    def test_sessions_table_has_an_immediate_loading_state(self):
        html = " ".join((ROOT / "web" / "sessions.html").read_text().split())

        self.assertIn('<tbody id="sessions-body" aria-busy="true">', html)
        self.assertIn('data-session-state="loading"', html)
        self.assertIn("Loading sessions…", html)
        self.assertIn('<button id="page-prev" type="button" disabled>', html)
        self.assertIn('<button id="page-next" type="button" disabled>', html)

    def test_sessions_loader_distinguishes_loading_empty_error_and_retry(self):
        js = (ROOT / "web" / "app.js").read_text()

        self.assertIn('renderSessionState("loading")', js)
        self.assertIn('renderSessionState("empty"', js)
        self.assertIn('renderSessionState("error"', js)
        self.assertIn("isValidSessionsPayload(data)", js)
        self.assertIn("generation !== sessionsGeneration", js)
        self.assertIn('sessionsView.status !== "ready"', js)
        self.assertIn("setSessionFiltersDisabled(true)", js)
        self.assertIn('retry.textContent = "Retry"', js)
        self.assertIn('retry.addEventListener("click", load)', js)
        self.assertIn('tbody.setAttribute("aria-busy", state === "loading" ? "true" : "false")', js)

    def test_sessions_endpoint_keeps_live_raw_entries_as_its_source(self):
        server = (ROOT / "server.py").read_text()
        endpoint = server[server.index("def sessions_endpoint") : server.index("def session_detail")]

        self.assertIn("load_all_entries()", endpoint)
        self.assertNotIn("rollup.", endpoint)

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
