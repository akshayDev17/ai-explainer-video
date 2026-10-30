"""trace.mjs's pytest plugin: tells the collector which test is running, so a call made by a framework (a fixture, a DI
provider, a route reached through a test client thread) is still attributed to the test it ran under; and records each
test's outcome per phase, with whether the sandbox denied it (a permission error, or a hidden path not found). Loaded
with PYTEST_PLUGINS=fmtrace_plugin.
It records only the repo's own run: the first pytest config in the first pytest process. A pytest run inside a test
(pytester, in process or in a child process, which inherits PYTEST_PLUGINS) records no outcome and moves no current
test; the collector still records its calls."""
import os

import pytest
import sitecustomize as fm

_BOUND = "FM_TRACE_PYTEST_BOUND"
_CONFIG = [None]


def pytest_configure(config):
    if _CONFIG[0] is None and not os.environ.get(_BOUND):
        _CONFIG[0] = config
        os.environ[_BOUND] = "1"


def _ours(config):
    return config is _CONFIG[0]


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


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    if not _ours(item.config):
        yield
        return
    fm.CURRENT[0] = _key(item)
    fm.OUTCOMES.setdefault(fm.CURRENT[0], {"nodeid": item.nodeid})
    yield
    fm.CURRENT[0] = None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    if not _ours(item.config):
        return
    rep = outcome.get_result()
    rec = fm.OUTCOMES.setdefault(_key(item), {"nodeid": item.nodeid})
    rec[rep.when] = rep.outcome
    if getattr(rep, "wasxfail", None) is not None:
        rec["xfail"] = True
    if rep.failed:
        rec.setdefault("message", _last_line(rep.longrepr))
        if call.excinfo is not None and fm.denied(call.excinfo.value):
            rec["permission"] = True


@pytest.hookimpl(hookwrapper=True)
def pytest_make_collect_report(collector):
    outcome = yield
    report = outcome.get_result()
    if _ours(collector.config) and report.failed:
        fm.COLLECT_ERRORS.append({"nodeid": report.nodeid, "message": _last_line(report.longrepr)})


def pytest_collection_finish(session):
    if _ours(session.config):
        fm.COLLECTED[0] = len(session.items)
