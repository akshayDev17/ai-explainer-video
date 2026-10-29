import asyncio


async def run_with_timeout(coro, timeout=5):
    return await asyncio.wait_for(coro, timeout)


def with_retry(fn, attempts=3):
    for _ in range(attempts):
        try:
            return fn()
        except ValueError:
            log_retry()
    return None


def log_retry():
    return None


def keep(fn):
    return fn


async def task():
    async def _body():
        return 1

    return await run_with_timeout(_body())


def load():
    def _fetch():
        return 2

    return with_retry(_fetch)


def store_only():
    def _callback():
        return 3

    # handed over but never called by keep(): no link
    return keep(_callback)
