from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class UsageEntry:
    timestamp: datetime
    session_id: str
    message_id: str
    request_id: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_creation_tokens: int
    cache_read_tokens: int
    cost_usd: Optional[float]
    project: str
    agent_id: str
    message_count: int = 1
    # Subset of cache_creation_tokens written with a 1-hour TTL, which Anthropic
    # bills at a higher rate than the 5-minute default. Cost-only: the total
    # stays in cache_creation_tokens so token counters are unaffected.
    cache_creation_1h_tokens: int = 0

    @property
    def dedup_key(self):
        # Keyed on the API call, not the transcript it lives in: Claude Code
        # copies whole transcripts into a new session file on resume/fork, so a
        # session-scoped key counts one call once per copy.
        return "%s:%s:%s" % (self.agent_id, self.message_id, self.request_id)


@dataclass(frozen=True)
class RateLimits:
    five_hour_pct: Optional[float]
    five_hour_resets_at: Optional[float]
    seven_day_pct: Optional[float]
    seven_day_resets_at: Optional[float]
    model: str = ""
    updated_at: str = ""
    # The plan the reading itself reports, when the provider states one inside
    # the same object as the percentages. It is the only plan known to come from
    # the same event as them — a plan read from a credential file is a separate
    # fact on its own clock. Same event, not same observation: a percentage
    # whose window has since reset is rewritten to zero while this keeps the
    # value the event carried. Codex fills it; Claude's status file
    # carries no plan, so it stays None there. See ADR 20260822-586a.
    plan: Optional[str] = None
