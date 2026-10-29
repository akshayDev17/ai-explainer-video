from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    remote_embedder: bool = False


settings = Settings()
