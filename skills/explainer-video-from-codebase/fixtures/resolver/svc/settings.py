from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    region: str = "us"


def get_settings():
    return Settings()
