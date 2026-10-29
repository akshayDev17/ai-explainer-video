from svc.settings import settings


class RemoteBackend:
    pass


class LocalBackend:
    pass


class PostgresStore:
    pass


class MemoryStore:
    pass


class SignedClient:
    pass


class AnonClient:
    pass


def create_backend():
    if settings.backend_mode == "remote":
        return RemoteBackend()
    return LocalBackend()


def create_store():
    if settings.database_url:
        return PostgresStore()
    return MemoryStore()


def create_client():
    if settings.api_token:
        return SignedClient()
    return AnonClient()
