"""Bounded pytest captured output, attributed only to test call phases."""


class CapturedOutput:
    def __init__(self):
        self.entries = []
        self.size = 0
        self.truncated = False

    def add_sections(self, report, phase=None):
        for title, text in report.sections:
            for stream in ("stdout", "stderr"):
                expected = f"Captured {stream}" + (f" {phase}" if phase else "")
                if title != expected or not text:
                    continue
                if self.truncated or len(self.entries) >= 256:
                    self.truncated = True
                    continue
                raw = text.encode("utf-8")
                remaining = 64 * 1024 - self.size
                kept = raw[:remaining].decode("utf-8", errors="ignore")
                if kept:
                    entry = {"stream": stream, "text": kept}
                    if phase == "call":
                        entry["testName"] = report.nodeid[:2000]
                    self.entries.append(entry)
                    self.size += len(kept.encode("utf-8"))
                if len(raw) > remaining or len(self.entries) >= 256:
                    self.truncated = True

    def result(self):
        return {"entries": self.entries, **({"truncated": True} if self.truncated else {})}
