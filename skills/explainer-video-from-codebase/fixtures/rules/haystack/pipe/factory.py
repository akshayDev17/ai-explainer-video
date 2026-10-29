from pipe.components import LocalEmbedder, RemoteEmbedder
from pipe.settings import settings


def create_embedder():
    if settings.remote_embedder:
        return RemoteEmbedder()
    return LocalEmbedder()
