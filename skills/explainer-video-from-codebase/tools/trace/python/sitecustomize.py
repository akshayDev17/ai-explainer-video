"""trace.mjs's Python collector: record which in-repo functions called which while the repo's own test command runs.

Loaded through PYTHONPATH from a directory outside the repo, inside trace.mjs's sandbox. On every Python call it records
(nearest in-repo caller, in-repo callee, current test): library frames between the two are skipped, so a call through a
decorator, a framework or the event loop is attributed to the in-repo code that started it. The current test is set by
fmtrace_plugin (pytest) or by the TestCase.run wrapper below (unittest), so a call a framework makes (a fixture, a DI
provider, a test client's handler thread) is still attributed to the test it ran under. It also records each test's
network attempts (audit hooks), so a test that failed on a connect the sandbox denied can be listed as denied, as can
one that failed on reading a path the sandbox hides (the user's home folder, the original repo). Imports an editable
install points into the original repo are sent to the copy.
Writes one JSON file per process at exit (or on SIGTERM, when trace.mjs's time limit stops the run). Never imports repo
code itself.

Environment: FM_TRACE_ROOT (the scratch copy of the repo), FM_TRACE_OUT (the output directory), FM_TRACE_RUNNER
("pytest" or "unittest"), FM_TRACE_ORIGIN (where the original repo was) and FM_TRACE_HIDDEN (the paths the sandbox
hides), both os.pathsep-separated."""
import atexit, errno, json, os, signal, sys, threading


def _dirs(var):
    return tuple(os.path.realpath(r) + os.sep for r in os.environ.get(var, "").split(os.pathsep) if r)


ROOTS = _dirs("FM_TRACE_ROOT")
ORIGINS = tuple(sorted({o for r in os.environ.get("FM_TRACE_ORIGIN", "").split(os.pathsep) if r
                        for o in (os.path.abspath(r) + os.sep, os.path.realpath(r) + os.sep)}, key=len, reverse=True))
HIDDEN = _dirs("FM_TRACE_HIDDEN")
OUT = os.environ["FM_TRACE_OUT"]
RUNNER = os.environ.get("FM_TRACE_RUNNER")
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
_forked = [False]


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


def _to_copy(p):
    # the interpreter's own paths stay: its virtualenv may live in the original repo, and the sandbox exposes it there
    if isinstance(p, str) and not (os.path.realpath(p) + os.sep).startswith(_LIB):
        for o in ORIGINS:
            if p == o[:-1] or p.startswith(o):
                return ROOTS[0] + p[len(o):]
    return p


def _pth_paths():
    # the path lines of the site dirs' .pth files: site skipped every one that points into the original repo, since
    # the sandbox hides it
    import site
    for d in site.getsitepackages():
        try:
            names = sorted(n for n in os.listdir(d) if n.endswith(".pth"))
        except OSError:
            continue
        for n in names:
            try:
                with open(os.path.join(d, n), encoding="utf-8") as fh:
                    lines = fh.read().splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            for line in lines:
                line = line.strip()
                if line and not line.startswith(("#", "import ", "import\t")):
                    yield os.path.join(d, line)


def _redirect_origin():
    # an editable install points into the original repo, which the sandbox hides: a path entry (a .pth line), a
    # setuptools finder's MAPPING and NAMESPACES, or an `editables` redirect; each is sent to the copy instead
    sys.path[:] = [_to_copy(p) for p in sys.path]
    for p in _pth_paths():
        moved = _to_copy(p)
        if moved != p and moved not in sys.path and os.path.isdir(moved):
            sys.path.append(moved)
    for name, mod in list(sys.modules.items()):
        if name.startswith("__editable__"):
            for k, v in (getattr(mod, "MAPPING", None) or {}).items():
                mod.MAPPING[k] = _to_copy(v)
            for k, v in (getattr(mod, "NAMESPACES", None) or {}).items():
                mod.NAMESPACES[k] = [_to_copy(x) for x in v]
    for finder in sys.meta_path:
        redirects = getattr(finder, "_redirections", None)
        if isinstance(redirects, dict):
            for k, v in redirects.items():
                redirects[k] = _to_copy(v)


def _hidden(path):
    return isinstance(path, str) and os.path.realpath(path).startswith(HIDDEN)


def denied(exc):
    """Did this exception (or one it came from) come from the sandbox: a permission error, or a hidden path not found
    (bwrap hides a path by mounting an empty dir over it, so a read of it fails as missing)."""
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, OSError) and (exc.errno in (errno.EPERM, errno.EACCES) or
                                         (exc.errno == errno.ENOENT and (_hidden(exc.filename) or _hidden(exc.filename2)))):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _denied_line(line):
    # unittest keeps only the formatted traceback: its last line
    if line.startswith("PermissionError") or "[Errno 1] Operation not permitted" in line or "[Errno 13] Permission denied" in line:
        return True
    return line.startswith("FileNotFoundError") and any(h in line or h[:-1] + "'" in line for h in HIDDEN)


def _reset_in_child():
    # a forked child starts with a copy of the parent's records; it must write only its own
    _pairs.clear()
    _net.clear()
    OUTCOMES.clear()
    COLLECT_ERRORS.clear()
    COLLECTED[0] = None
    _forked[0] = True


def _on_term(signum, frame):
    # the test the time limit cut off, in the process that ran it (a forked worker's SIGTERM is not a cut-off): the
    # phase it was in fails, as pytest counts it; under unittest the test is an error
    if CURRENT[0] is not None and not _forked[0]:
        rec = OUTCOMES.setdefault(CURRENT[0], {})
        rec.setdefault("message", "cut off by the time limit")
        if RUNNER == "pytest":
            phases = ("setup", "call", "teardown") if rec.get("setup", "passed") == "passed" else ("setup", "teardown")
            phase = next((p for p in phases if p not in rec), None)
            if phase:
                rec[phase] = "error" if phase == "call" else "failed"
        else:
            rec.setdefault("call", "error")
    _dump()
    os._exit(128 + signum)


def _wrap_unittest():
    import traceback
    import unittest.case
    import unittest.result
    import unittest.suite

    run = unittest.case.TestCase.run
    kinds = ("errors", "failures", "skipped", "expectedFailures", "unexpectedSuccesses")

    def counts(result):
        return {k: len(getattr(result, k, ()) or ()) for k in kinds}

    def traced_run(self, result=None):
        key = "unittest::" + self.id()
        before = counts(result) if result is not None else None
        CURRENT[0] = key
        if before is not None:
            OUTCOMES[key] = {}
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
                    last = tb.strip().splitlines()[-1] if tb.strip() else ""
                    rec["message"] = last[:200]
                    rec["permission"] = _denied_line(last)
                OUTCOMES[key] = rec

    unittest.case.TestCase.run = traced_run

    # a failing setUpModule, setUpClass, tearDownClass or tearDownModule is reported outside any TestCase.run, under
    # unittest's own name for it (`setUpClass (pkg.mod.Class)`): record it as an error, and make it current while it
    # runs, so its network attempts and a cut-off there are recorded under that name too
    add_error = unittest.result.TestResult.addError

    def traced_add_error(self, test, err):
        if isinstance(test, unittest.suite._ErrorHolder):
            last = traceback.format_exception_only(err[0], err[1])[-1].strip()
            OUTCOMES["unittest::" + test.id()] = {"call": "error", "message": last[:200], "permission": denied(err[1])}
        return add_error(self, test, err)

    unittest.result.TestResult.addError = traced_add_error

    def strclass(cls):
        return "%s.%s" % (cls.__module__, cls.__qualname__)

    def previous(result):
        return getattr(result, "_previousTestClass", None)

    def fixture(method, name, parent):
        handle = getattr(unittest.suite.TestSuite, method)

        def traced(self, *args):
            prev, p = CURRENT[0], parent(*args)
            CURRENT[0] = "unittest::%s (%s)" % (name, p) if p else prev
            try:
                return handle(self, *args)
            finally:
                CURRENT[0] = prev

        setattr(unittest.suite.TestSuite, method, traced)

    fixture("_handleClassSetUp", "setUpClass", lambda test, result: strclass(test.__class__))
    fixture("_tearDownPreviousClass", "tearDownClass", lambda test, result: previous(result) and strclass(previous(result)))
    fixture("_handleModuleFixture", "setUpModule", lambda test, result: test.__class__.__module__)
    fixture("_handleModuleTearDown", "tearDownModule", lambda result: previous(result) and previous(result).__module__)


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
_redirect_origin()
if RUNNER == "unittest":
    _wrap_unittest()
os.register_at_fork(after_in_child=_reset_in_child)
if signal.getsignal(signal.SIGTERM) == signal.SIG_DFL:
    signal.signal(signal.SIGTERM, _on_term)
sys.addaudithook(_audit)
atexit.register(_dump)
threading.setprofile(_prof)
sys.setprofile(_prof)
