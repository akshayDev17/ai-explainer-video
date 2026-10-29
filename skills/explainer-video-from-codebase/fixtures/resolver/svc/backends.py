from svc.settings import get_settings


class LocalBackend:
    def fetch(self):
        return "local"


class RemoteBackend:
    def fetch(self):
        return "remote"


class EuBackend:
    def fetch(self):
        return "eu"


def create_backend():
    # B14: no settings field declares backend_mode, so its value is not in the repo
    settings = get_settings()
    mode = getattr(settings, "backend_mode", "local").lower()
    if mode == "remote":
        return RemoteBackend()
    return LocalBackend()


def create_regional_backend():
    # B14: region is declared (default "us"), but only deploy/prod.env decides a getattr read
    settings = get_settings()
    if getattr(settings, "region", "eu") == "eu":
        return EuBackend()
    return LocalBackend()
