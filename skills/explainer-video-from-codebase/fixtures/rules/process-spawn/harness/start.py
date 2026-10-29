import asyncio
import subprocess
import sys


def start_server():
    cmd = ["poetry", "run", "uvicorn", "server:app", "--port", "8000"]
    return subprocess.Popen(cmd)


def start_worker():
    return subprocess.Popen(["taskiq", "worker", "worker.broker:broker"])


def start_scheduler():
    return subprocess.run(["taskiq", "scheduler", "worker.broker:broker"], check=True)


async def run_tool():
    return await asyncio.create_subprocess_exec(sys.executable, "-m", "tool")


def not_a_spawn(pipeline):
    return pipeline.run(["uvicorn", "server:app"])
