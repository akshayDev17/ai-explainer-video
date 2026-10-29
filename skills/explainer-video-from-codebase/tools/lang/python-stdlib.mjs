/* Top-level names of the Python standard library (CPython 3.13's sys.stdlib_module_names, plus modules removed in
   3.12 that older code still imports), frozen here so mining is the same on every machine. An in-repo module or
   package dir with one of these names never captures the standard-library import. */
export const STDLIB = new Set([
  'abc', 'antigravity', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore', 'atexit', 'base64', 'bdb',
  'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cmath', 'cmd', 'code', 'codecs', 'codeop',
  'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils',
  'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'genericpath', 'getopt', 'getpass', 'gettext', 'glob',
  'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imp', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox',
  'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msvcrt', 'multiprocessing', 'netrc', 'nt', 'ntpath',
  'nturl2path', 'numbers', 'opcode', 'operator', 'optparse', 'os', 'pathlib', 'pdb', 'pickle', 'pickletools',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
  'signal', 'site', 'smtpd', 'smtplib', 'socket', 'socketserver', 'sqlite3', 'sre_compile', 'sre_constants',
  'sre_parse', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable', 'sys',
  'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'tempfile', 'termios', 'textwrap', 'this', 'threading', 'time',
  'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle',
  'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
  'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);
