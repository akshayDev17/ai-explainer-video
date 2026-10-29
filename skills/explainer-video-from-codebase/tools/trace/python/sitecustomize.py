"""trace.mjs's Python collector: record which in-repo functions called which while the repo's own test command runs.

Loaded through PYTHONPATH from a directory outside the repo, inside trace.mjs's sandbox. On every Python call it records
(nearest in-repo caller, in-repo callee, current test): library frames between the two are skipped, so a call through a
decorator, a framework or the event loop is attributed to the in-repo code that started it. The current test is set by
fmtrace_plugin (pytest) or by the TestCase.run wrapper below (unittest), so a call a framework makes (a fixture, a DI
provider, a test client's handler thread) is still attributed to the test it ran under. It also records each test's
network attempts (audit hooks), so a test that failed on a connect the sandbox denied can be listed as denied.
Writes one JSON file per process at exit (or on SIGTERM, when trace.mjs's time limit stops the run). Never imports repo
code itself.

Environment: FM_TRACE_ROOT (the repo roots, os.pathsep-separated), FM_TRACE_OUT (the output directory),
FM_TRACE_RUNNER ("pytest" or "unittest")."""
import atexit, json, os, signal, sys, threading

ROOTS = tuple(os.path.realpath(r) + os.sep for r in os.environ["FM_TRACE_ROOT"].split(os.pathsep) if r)
OUT = os.environ["FM_TRACE_OUT"]
# an interpreter or virtualenv that lives under a repo root is library code, not repo code
_LIB = tuple({os.path.realpath(p) + os.sep for p in (sys.prefix, sys.base_prefix, sys.exec_prefix)})
_FOLD = (".<lambda>", ".<genexpr>", ".<listcomp>", ".<dictcomp>", ".<setcomp>")
_keys = {}
_pairs = {}        # (caller, callee, test) -> calls
_net = {}          # test -> [network attempts]
OUTCOMES = {}      # test -> {phase: outcome, ...}, filled by fmtrace_plugin or the unittest wrapper
COLLECTED = [None]
COLLECT_ERRORS = []
CURRENT = [None]   # the running test's key, set around its setup, call and teardown
_done = [False]


def _rel(f):
    if not f.endswith(".py") or f.startswith(_LIB) or os.sep + "site-packages" + os.sep in f or os.sep + "dist-packages" + os.sep in f:
        return None
    for r in ROOTS:
        if f.startswith(r):
            return f[len(r):]
    return None


def _key(code):
    # keyed by identity: code objects compare by value (not by file), so twin bodies in two files would collide;
    # the stored reference keeps the id from being reused
    hit = _keys.get(id(code))
    if hit is not None:
        return hit[1]
    rel = _rel(code.co_filename)
    k = False
    if rel is not None:
        q = getattr(code, "co_qualname", code.co_name)
        # comprehensions, lambdas and generator bodies belong to the function that holds them
        while q.endswith(_FOLD) or q in ("<lambda>", "<genexpr>"):
            q = q.rsplit(".<locals>.", 1)[0] if ".<locals>." in q else "<module>"
        k = (rel, q)
    _keys[id(code)] = (code, k)
    return k


def _prof(frame, event, arg):
    if event != "call":
        return
    callee = _key(frame.f_code)
    if not callee:
        return
    caller = None
    b = frame.f_back
    while b is not None:
        caller = _key(b.f_code)
        if caller:
            break
        b = b.f_back
    p = (caller or None, callee, CURRENT[0])
    _pairs[p] = _pairs.get(p, 0) + 1


def _audit(event, args):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto"):
        seen = _net.setdefault(CURRENT[0], [])
        if len(seen) < 5:
            target = args[1] if event in ("socket.connect", "socket.sendto") else args[0] if args else None
            if event == "socket.getaddrinfo" and len(args) > 1:
                target = (args[0], args[1])
            what = event.split(".", 1)[1] + " " + str(target)[:120]
            if what not in seen:
                seen.append(what)


def _dump():
    if _done[0]:
        return
    _done[0] = True
    sys.setprofile(None)
    threading.setprofile(None)
    rows = [{"from": list(c) if c else None, "to": list(t), "test": k, "n": n} for (c, t, k), n in _pairs.items()]
    data = {"argv": sys.argv, "python": sys.version.split()[0], "pairs": rows,
            "network": {k: v for k, v in _net.items() if k is not None}, "outcomes": OUTCOMES,
            "collected": COLLECTED[0], "collectErrors": COLLECT_ERRORS}
    name = "trace-%d-%s.json" % (os.getpid(), os.urandom(4).hex())
    with open(os.path.join(OUT, name), "w") as fh:
        json.dump(data, fh)


def _reset_in_child():
    # a forked child starts with a copy of the parent's records; it must write only its own
    _pairs.clear()
    _net.clear()
    OUTCOMES.clear()
    COLLECT_ERRORS.clear()
    COLLECTED[0] = None


def _on_term(signum, frame):
    _dump()
    os._exit(128 + signum)


def _wrap_unittest():
    import unittest.case

    run = unittest.case.TestCase.run
    kinds = ("errors", "failures", "skipped", "expectedFailures", "unexpectedSuccesses")

    def counts(result):
        return {k: len(getattr(result, k, ()) or ()) for k in kinds}

    def traced_run(self, result=None):
        key = "unittest::" + self.id()
        before = counts(result) if result is not None else None
        CURRENT[0] = key
        try:
            return run(self, result)
        finally:
            CURRENT[0] = None
            if before is not None:
                after = counts(result)
                grew = [k for k in kinds if after[k] > before[k]]
                outcome = {"errors": "error", "failures": "failed", "skipped": "skipped",
                           "expectedFailures": "xfailed", "unexpectedSuccesses": "xpassed"}.get(grew[0] if grew else "", "passed")
                rec = {"call": outcome}
                if outcome in ("error", "failed"):
                    tb = getattr(result, grew[0])[-1][1]
                    rec["message"] = tb.strip().splitlines()[-1][:200] if tb.strip() else ""
                    rec["permission"] = "PermissionError" in tb
                OUTCOMES[key] = rec

    unittest.case.TestCase.run = traced_run


def _run_shadowed_sitecustomize():
    # this module shadows the interpreter's own sitecustomize (Homebrew's adds its site-packages there): run that one too
    here = os.path.dirname(os.path.realpath(__file__))
    for d in sys.path:
        p = os.path.join(d or ".", "sitecustomize.py")
        if os.path.realpath(d or ".") != here and os.path.isfile(p):
            import runpy

            runpy.run_path(p, run_name="_shadowed_sitecustomize")
            return


_run_shadowed_sitecustomize()
if os.environ.get("FM_TRACE_RUNNER") == "unittest":
    _wrap_unittest()
os.register_at_fork(after_in_child=_reset_in_child)
if signal.getsignal(signal.SIGTERM) == signal.SIG_DFL:
    signal.signal(signal.SIGTERM, _on_term)
sys.addaudithook(_audit)
atexit.register(_dump)
threading.setprofile(_prof)
sys.setprofile(_prof)
