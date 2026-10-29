from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    backend_mode: str = "local"
    api_token: str | None = None
    database_url: str | None = None


settings = Settings()
