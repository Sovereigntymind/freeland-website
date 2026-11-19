"""Extract final PDF text for the blocking content gate. No source-HTML fallback."""
import json
import sys

from pypdf import PdfReader


def extract(filename):
    try:
        with open(filename, "rb") as stream:
            reader = PdfReader(stream, strict=True)
            if reader.is_encrypted:
                raise ValueError("Encrypted PDF cannot be checked")
            pages = [page.extract_text() for page in reader.pages]
            if not pages or any(not text or not text.strip() for text in pages):
                raise ValueError("PDF has a page without extractable text; content is unverified")
            return {"text": "\n".join(pages)}
    except Exception as error:
        return {"error": f"Unreadable PDF: {type(error).__name__}: {error}"}


print(json.dumps([extract(filename) for filename in json.load(sys.stdin)], ensure_ascii=True))
