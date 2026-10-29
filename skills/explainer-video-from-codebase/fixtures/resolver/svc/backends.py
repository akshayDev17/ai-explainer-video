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
    # B14: no settings field declares backend_mode, so getattr's default decides
    settings = get_settings()
    mode = getattr(settings, "backend_mode", "local").lower()
    if mode == "remote":
        return RemoteBackend()
    return LocalBackend()


def create_regional_backend():
    # B14: region is declared (default "us"), so the field decides, not getattr's default
    settings = get_settings()
    if getattr(settings, "region", "eu") == "eu":
        return EuBackend()
    return LocalBackend()


def create_regional_backend_by_attribute():
    # the same setting read as an attribute
    settings = get_settings()
    if settings.region == "eu":
        return EuBackend()
    return LocalBackend()
