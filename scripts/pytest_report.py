"""Small bounded pytest plugin that emits the runner's machine-readable report."""

import json
import os
import time
from sandbox.pytest_capture import CapturedOutput

_started = time.time() * 1000
_tests = {}
_output = CapturedOutput()
_MAX_MESSAGE = 20_000
_MAX_TESTS = 500


def _message(value):
    text = str(value)
    if len(text) > _MAX_MESSAGE:
        return text[:_MAX_MESSAGE] + "\n… failure output truncated"
    return text


def _record(nodeid, status, message=""):
    if nodeid not in _tests and len(_tests) >= _MAX_TESTS:
        return
    current = _tests.setdefault(nodeid, {"fullName": nodeid, "status": "passed", "failureMessages": []})
    if status == "failed":
        current["status"] = "failed"
        if message and not current["failureMessages"]:
            current["failureMessages"] = [_message(message)]
    elif status == "skipped" and current["status"] == "passed":
        current["status"] = "skipped"


def pytest_runtest_logreport(report):
    _output.add_sections(report, report.when)
    if report.failed:
        _record(report.nodeid, "failed", report.longrepr)
    elif report.when == "call":
        _record(report.nodeid, "skipped" if report.skipped else "passed")


def pytest_collectreport(report):
    _output.add_sections(report)
    if report.failed:
        _record(getattr(report, "nodeid", "collection"), "failed", report.longrepr)


def pytest_sessionfinish(session, exitstatus):
    path = os.environ.get("INTERVIEW_RUNNER_PYTEST_REPORT")
    test_path = os.environ.get("INTERVIEW_RUNNER_PYTEST_PATH", "")
    if not path:
        return
    tests = list(_tests.values())
    represented_failure = any(test["status"] == "failed" for test in tests)
    if exitstatus != 0 and not represented_failure and exitstatus != 5:
        tests.append({"fullName": "pytest session", "status": "failed", "failureMessages": [f"pytest exited with status {exitstatus}"]})
        represented_failure = True
    status = "failed" if represented_failure else "pending" if not tests or exitstatus == 5 else "passed"
    payload = {"startTime": _started, "testResults": [{"name": test_path, "status": status, "assertionResults": tests}], "output": _output.result()}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
