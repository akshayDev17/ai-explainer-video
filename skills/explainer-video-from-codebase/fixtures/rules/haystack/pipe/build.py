from haystack import Pipeline
from haystack.components.preprocessors import DocumentSplitter

from pipe.components import Cleaner
from pipe.factory import create_embedder


def build_pipeline():
    p = Pipeline()
    p.add_component("clean", Cleaner())
    p.add_component("split", DocumentSplitter())
    p.add_component("embed", create_embedder())
    p.connect("clean.documents", "split.documents")
    p.connect("split.documents", "embed.documents")
    return p


def index(docs):
    p = build_pipeline()
    return p.run({"clean": {"documents": docs}})
