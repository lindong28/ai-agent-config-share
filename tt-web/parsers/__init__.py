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

    @property
    def dedup_key(self):
        return "%s:%s:%s" % (self.agent_id, self.session_id, self.message_id)


@dataclass(frozen=True)
class RateLimits:
    five_hour_pct: Optional[float]
    five_hour_resets_at: Optional[float]
    seven_day_pct: Optional[float]
    seven_day_resets_at: Optional[float]
    model: str = ""
    updated_at: str = ""
