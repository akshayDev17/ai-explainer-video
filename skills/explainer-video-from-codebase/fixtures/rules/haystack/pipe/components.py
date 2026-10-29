from haystack import component


@component
class Cleaner:
    def run(self, documents):
        return {"documents": documents}


class LocalEmbedder:
    def run(self, documents):
        return {"documents": documents}


class RemoteEmbedder:
    def run(self, documents):
        return {"documents": documents}
