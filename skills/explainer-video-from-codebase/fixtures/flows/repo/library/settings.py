from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    store_backend: str = "memory"


settings = Settings()
