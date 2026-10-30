"""trace.mjs's pytest plugin: tells the collector which test is running, so a call made by a framework (a fixture, a DI
provider, a route reached through a test client thread) is still attributed to the test it ran under; and records each
test's outcome per phase, with whether the sandbox denied it (a permission error, or a hidden path not found). Loaded
with PYTEST_PLUGINS=fmtrace_plugin.
It records only the repo's own tests: those of the first pytest config in a process, in files inside the scratch copy.
A pytest run inside a test (pytester, in process or in a child process, which inherits PYTEST_PLUGINS) runs tests
from its own tmp dir, so it records no outcome and moves no current test; the collector still records its calls. An
xdist worker runs the copy's tests, and records them."""
import os

import pytest
import sitecustomize as fm

_CONFIG = [None]


def pytest_configure(config):
    if _CONFIG[0] is None:
        _CONFIG[0] = config


def _path(node):
    return os.path.realpath(str(getattr(node, "path", None) or node.fspath))


def _in_copy(path, root):
    return (path + os.sep).startswith(root)


def _ours(config, node):
    path = _path(node)
    return config is _CONFIG[0] and any(_in_copy(path, r) for r in fm.ROOTS)


def _key(item):
    # the test's file relative to the repo root, then the rest of its node id: independent of pytest's rootdir. An
    # item a plugin parents at the session (its path is the root) is `::<name>`
    path = _path(item)
    rel = next((path[len(r):] for r in fm.ROOTS if _in_copy(path, r)), "")
    rest = item.nodeid.split("::", 1)[1] if "::" in item.nodeid else ""
    return rel + "::" + rest


def _last_line(longrepr):
    crash = getattr(longrepr, "reprcrash", None)
    lines = (crash.message if crash else str(longrepr or "")).strip().splitlines()
    return lines[-1][:200] if lines else ""


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    if not _ours(item.config, item):
        yield
        return
    fm.CURRENT[0] = _key(item)
    fm.OUTCOMES.setdefault(fm.CURRENT[0], {"nodeid": item.nodeid})
    yield
    fm.CURRENT[0] = None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    if not _ours(item.config, item):
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
    if _ours(collector.config, collector) and report.failed:
        fm.COLLECT_ERRORS.append({"nodeid": report.nodeid, "message": _last_line(report.longrepr)})


def pytest_collection_finish(session):
    if session.config is _CONFIG[0]:
        fm.COLLECTED[0] = len([i for i in session.items if _ours(session.config, i)])
