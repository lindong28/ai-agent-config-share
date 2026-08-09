import logging
import threading
from pathlib import Path


logger = logging.getLogger(__name__)


class MtimeCache:
    def __init__(self, path_provider, parser):
        self.path_provider = path_provider
        self.parser = parser
        self._entries_by_path = {}
        self._lock = threading.RLock()

    def load(self, source_errors=None):
        with self._lock:
            try:
                paths = [Path(path) for path in self.path_provider()]
            except OSError as exc:
                self._record_error(source_errors, None, "scan", exc)
                paths = []
            current = {str(path): path for path in paths}

            for cached_path in list(self._entries_by_path):
                if cached_path not in current:
                    del self._entries_by_path[cached_path]

            for key, path in sorted(current.items()):
                try:
                    stat = path.stat()
                except OSError as exc:
                    self._record_error(source_errors, path, "stat", exc)
                    self._entries_by_path.pop(key, None)
                    continue

                signature = (stat.st_mtime_ns, stat.st_size)
                cached = self._entries_by_path.get(key)
                if cached and cached["signature"] == signature:
                    continue

                try:
                    entries = list(self.parser(path))
                except Exception as exc:
                    logger.warning("Could not parse %s: %s", path, exc)
                    self._record_error(source_errors, path, "parse", exc)
                    entries = []

                self._entries_by_path[key] = {"signature": signature, "entries": entries}

            merged = []
            for key in sorted(self._entries_by_path):
                merged.extend(self._entries_by_path[key]["entries"])
            return merged

    @staticmethod
    def _record_error(source_errors, path, stage, exc):
        if source_errors is None:
            return
        source_errors.append(
            {
                "path": str(path) if path is not None else None,
                "stage": stage,
                "error": "%s: %s" % (type(exc).__name__, exc),
            }
        )

    def clear(self):
        with self._lock:
            self._entries_by_path.clear()
