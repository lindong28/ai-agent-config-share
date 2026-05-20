import json
import logging
import ssl
import time
import urllib.request
from pathlib import Path


# Adapted from token-tracker src/analyzer/cost.py; this version wraps the
# cache with fetched_at and enforces a 7-day TTL.
LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
TTL_SECONDS = 7 * 24 * 3600
ROOT = Path(__file__).resolve().parent
CACHE_PATH = ROOT / "state" / "pricing_cache.json"
FALLBACK_PATH = ROOT / "pricing.json"

logger = logging.getLogger(__name__)
_FUZZY_LOGGED = set()
_UNKNOWN_LOGGED = set()


def get_pricing(cache_path=CACHE_PATH, fetcher=None, now=None):
    now_fn = now or time.time
    cache_path = Path(cache_path)
    cached = _read_fresh_cache(cache_path, now_fn())
    if cached is not None:
        return cached

    fetch = fetcher or _fetch_litellm_pricing
    try:
        data = fetch()
        _write_cache(cache_path, data, now_fn())
        return data
    except Exception as exc:
        logger.warning("Pricing fetch failed, using bundled fallback: %s", exc)
        return _fallback_pricing()


def calculate_cost(entry, pricing=None):
    if entry.cost_usd is not None:
        return entry.cost_usd

    table = pricing if pricing is not None else get_pricing()
    model_key = resolve_model_key(entry.model, table)
    if model_key is None:
        _log_unknown(entry.model)
        return None

    info = table[model_key]
    input_cost = info.get("input_cost_per_token", 0)
    output_cost = info.get("output_cost_per_token", 0)
    cache_creation_cost = info.get("cache_creation_input_token_cost", input_cost * 1.25)
    cache_read_cost = info.get("cache_read_input_token_cost", input_cost * 0.1)

    return (
        entry.input_tokens * input_cost
        + entry.output_tokens * output_cost
        + entry.cache_creation_tokens * cache_creation_cost
        + entry.cache_read_tokens * cache_read_cost
    )


def resolve_model_key(model, pricing):
    if model in pricing:
        return model

    for key in pricing:
        if model and (model in key or key in model):
            _log_fuzzy(model, key)
            return key

    model_lower = (model or "").lower()
    for key in pricing:
        key_lower = key.lower()
        if model_lower and (model_lower in key_lower or key_lower in model_lower):
            _log_fuzzy(model, key)
            return key

    return None


def _read_fresh_cache(cache_path, now):
    if not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    if not isinstance(payload, dict) or "fetched_at" not in payload or "data" not in payload:
        return None

    if now - float(payload.get("fetched_at", 0)) > TTL_SECONDS:
        return None
    return payload["data"]


def _write_cache(cache_path, data, fetched_at):
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps({"fetched_at": fetched_at, "data": data}, sort_keys=True),
            encoding="utf-8",
        )
    except OSError:
        logger.warning("Could not write pricing cache to %s", cache_path)


def _fetch_litellm_pricing():
    context = ssl.create_default_context()
    request = urllib.request.Request(LITELLM_URL, headers={"User-Agent": "tt-web/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=10, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
    except ssl.SSLCertVerificationError:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(request, timeout=10, context=context) as response:
            return json.loads(response.read().decode("utf-8"))


def _fallback_pricing():
    try:
        return json.loads(FALLBACK_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.warning("Bundled pricing fallback missing or invalid")
        return {}


def _log_fuzzy(model, key):
    pair = (model, key)
    if pair in _FUZZY_LOGGED:
        return
    _FUZZY_LOGGED.add(pair)
    logger.warning("Fuzzy pricing match: %s -> %s", model, key)


def _log_unknown(model):
    if model in _UNKNOWN_LOGGED:
        return
    _UNKNOWN_LOGGED.add(model)
    logger.warning("Unknown pricing model: %s", model)
