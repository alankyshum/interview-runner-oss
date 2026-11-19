import json
import os
from pytest_capture import CapturedOutput

_results = []
_output = CapturedOutput()

def pytest_collectreport(report):
    _output.add_sections(report)

def pytest_runtest_logreport(report):
    _output.add_sections(report, report.when)
    if report.when != "call" and not (report.when == "setup" and report.failed):
        return
    status = "passed" if report.passed else "skipped" if report.skipped else "failed"
    item = {"name": report.nodeid, "status": status}
    if report.failed:
        item["message"] = str(report.longrepr)
    _results.append(item)

def pytest_sessionfinish(session, exitstatus):
    path = os.environ.get("IR_PYTEST_RESULT")
    if path:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"tests": _results, "output": _output.result()}, handle)
