"""trace.mjs's pytest plugin: tells the collector which test is running, so a call made by a framework (a fixture, a DI
provider, a route reached through a test client thread) is still attributed to the test it ran under; and records each
test's outcome per phase, with whether it failed on a PermissionError. Loaded with PYTEST_PLUGINS=fmtrace_plugin."""
import errno
import os

import pytest
import sitecustomize as fm


def _key(item):
    # the test's file relative to the repo root, then the rest of its node id: independent of pytest's rootdir
    path = os.path.realpath(str(getattr(item, "path", None) or item.fspath))
    rel = next((path[len(r):] for r in fm.ROOTS if path.startswith(r)), item.nodeid.split("::", 1)[0])
    rest = item.nodeid.split("::", 1)[1] if "::" in item.nodeid else ""
    return rel + "::" + rest


def _last_line(longrepr):
    crash = getattr(longrepr, "reprcrash", None)
    lines = (crash.message if crash else str(longrepr or "")).strip().splitlines()
    return lines[-1][:200] if lines else ""


def _denied(exc):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, PermissionError) or (isinstance(exc, OSError) and exc.errno in (errno.EPERM, errno.EACCES)):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    fm.CURRENT[0] = _key(item)
    yield
    fm.CURRENT[0] = None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    rec = fm.OUTCOMES.setdefault(_key(item), {"nodeid": item.nodeid})
    rec[rep.when] = rep.outcome
    if getattr(rep, "wasxfail", None) is not None:
        rec["xfail"] = True
    if rep.failed:
        rec.setdefault("message", _last_line(rep.longrepr))
        if call.excinfo is not None and _denied(call.excinfo.value):
            rec["permission"] = True


def pytest_collectreport(report):
    if report.failed:
        fm.COLLECT_ERRORS.append({"nodeid": report.nodeid, "message": _last_line(report.longrepr)})


def pytest_collection_finish(session):
    fm.COLLECTED[0] = len(session.items)
