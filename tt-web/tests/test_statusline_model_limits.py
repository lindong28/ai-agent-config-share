"""Which cached model-scoped windows reach the statusline, and which are dropped.

`statusline-fields.py` serves the per-model quota bars (today: Fable) out of the
cache `statusline-usage.py` writes, and decides per entry whether it is still
worth showing. That decision had no coverage: the feature shipped verified only
at its data source, so nothing pinned which cache shapes survive the render.

The distinction these tests exist to hold is between a reset time that has
*passed* and one that is *absent*. Both used to read as "0 or less than now" and
both were dropped, which silently blanked a bar whose percentage was current.
"""

import importlib.util
import json
import os
import shlex
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

CLAUDE = Path(__file__).resolve().parents[2] / "claude"
FIELDS = CLAUDE / "statusline-fields.py"


def _usage_module():
    """statusline-usage.py, imported despite the hyphen in its filename."""
    spec = importlib.util.spec_from_file_location("statusline_usage", CLAUDE / "statusline-usage.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model_limit_lines(limits: list[dict], fetched_at: int | None = None) -> list[str]:
    """MODEL_LIMIT_LINES as the shell would see it, for a cache holding `limits`."""
    now = int(time.time())
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp) / ".usage.json"
        cache.write_text(
            json.dumps(
                {
                    "attempted_at": now,
                    "fetched_at": now if fetched_at is None else fetched_at,
                    "limits": limits,
                }
            ),
            encoding="utf-8",
        )
        env = os.environ.copy()
        env["USAGE_CACHE"] = str(cache)
        # Keep the render's other side effects out of the developer's real home.
        env["HOME"] = tmp
        env["CLAUDE_DIR"] = tmp
        env["STATUS_FILE"] = str(Path(tmp) / "tt-status.json")
        env["SPEED_CACHE"] = str(Path(tmp) / "speed.json")
        result = subprocess.run(
            ["python3", str(FIELDS)],
            input=json.dumps({"model": {"id": "claude-fable-5"}, "context_window": {"used_percentage": 1}}),
            capture_output=True,
            env=env,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, result.stderr
    # The emitted value is `shlex.quote`d, so a cache holding more than one window
    # puts real newlines *inside* the quotes: the assignment is not a single
    # physical line and cannot be recovered by splitting the output on newlines.
    # `shlex.split` unquotes exactly the way the shell would, which is the whole
    # claim this helper makes.
    marker = "\nMODEL_LIMIT_LINES="
    haystack = "\n" + result.stdout
    if marker not in haystack:
        raise AssertionError("statusline-fields.py emitted no MODEL_LIMIT_LINES")
    tail = haystack.split(marker, 1)[1]
    text = shlex.split(tail)[0] if tail.strip() else ""
    return [entry for entry in text.split("\n") if entry]


class ModelLimitRenderTests(unittest.TestCase):
    def test_live_window_is_shown_with_its_reset(self):
        future = int(time.time()) + 3600
        self.assertEqual(
            model_limit_lines([{"name": "Fable", "percent": 42, "resets_at": future}]),
            ["Fable|42|%d" % future],
        )

    def test_absent_reset_still_shows_the_percentage(self):
        """`resets_at: 0` means the refresher found no reset time, not one in the past.

        Observed live, beside a Fable window reading 0%. The percentage is the
        server's current answer regardless of why the reset time is missing, so
        dropping the entry blanks a bar that has nothing wrong with it. Only the
        countdown is unknown, and the renderer already omits one it cannot format.
        """
        self.assertEqual(
            model_limit_lines([{"name": "Fable", "percent": 0, "resets_at": 0}]),
            ["Fable|0|0"],
        )

    def test_elapsed_reset_is_dropped(self):
        """A window whose reset has passed carries the *previous* period's number."""
        past = int(time.time()) - 3600
        self.assertEqual(
            model_limit_lines([{"name": "Fable", "percent": 88, "resets_at": past}]),
            [],
        )

    def test_unnamed_window_is_dropped(self):
        self.assertEqual(
            model_limit_lines([{"name": "", "percent": 5, "resets_at": int(time.time()) + 60}]),
            [],
        )

    def test_every_window_survives_when_the_account_has_several(self):
        """The emitted value is newline-delimited, so more than one must round-trip.

        Only ever exercised with a single window, this path looks identical
        whether or not the extra entries are being lost.
        """
        future = int(time.time()) + 3600
        self.assertEqual(
            model_limit_lines(
                [
                    {"name": "Fable", "percent": 42, "resets_at": future},
                    {"name": "Opus", "percent": 7, "resets_at": future + 60},
                ]
            ),
            ["Fable|42|%d" % future, "Opus|7|%d" % (future + 60)],
        )

    def test_stale_cache_is_not_displayed(self):
        """Past DISPLAY_MAX_AGE_S the numbers stop being worth showing at all."""
        future = int(time.time()) + 3600
        self.assertEqual(
            model_limit_lines(
                [{"name": "Fable", "percent": 42, "resets_at": future}],
                fetched_at=int(time.time()) - 7 * 3600,
            ),
            [],
        )


class ResetInstantTests(unittest.TestCase):
    """`to_epoch` feeds the comparison above; a rounding error there hides a bar."""

    def test_subsecond_reset_does_not_land_in_the_past(self):
        """Live payloads carry fractional seconds, and truncating moves them back.

        `...T00:00:00.228772Z` truncated to `...T00:00:00` reads as already
        elapsed for the fraction of a second before the true reset, which is long
        enough for a render to land in and hide a window that is still live.
        """
        to_epoch = _usage_module().to_epoch
        whole = to_epoch("2026-08-09T00:00:00+00:00")
        self.assertEqual(to_epoch("2026-08-09T00:00:00.228772+00:00"), whole + 1)

    def test_whole_second_reset_is_unchanged(self):
        self.assertEqual(_usage_module().to_epoch("2026-08-09T00:00:00Z"), 1786233600)

    def test_absent_or_unparseable_reset_is_zero(self):
        to_epoch = _usage_module().to_epoch
        for value in (None, "", "   ", "not a date", 1786233600):
            self.assertEqual(to_epoch(value), 0, value)


if __name__ == "__main__":
    unittest.main()
