import subprocess
import sys


def start_server():
    return subprocess.Popen(["uvicorn", "server:app", "--port", "8001"])


def start_tool():
    return subprocess.run([sys.executable, "-m", "tool"], check=True)
