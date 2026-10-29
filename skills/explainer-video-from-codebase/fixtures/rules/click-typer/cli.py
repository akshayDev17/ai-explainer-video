import click
import typer

app = typer.Typer()


@click.group()
def cli():
    pass


@cli.command()
@click.option("--name")
@click.option("--count", default=1)
def greet(name, count):
    click.echo(name * count)


@app.command()
def serve(port: int = 8000):
    typer.echo(port)
