import sys

if sys.version_info >= (3, 11):
    class Compat:
        def run(self):
            return 1
else:
    class Compat:
        def run(self):
            return 2

try:
    from fast import speedup
except ImportError:
    def speedup(x):
        return x
