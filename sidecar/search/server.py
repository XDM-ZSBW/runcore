"""
Dash search sidecar — DuckDuckGo web search via smolagents.
Minimal FastAPI server: /search and /health endpoints.
No LLM on the Python side — Dash's main LLM handles synthesis.
"""

import argparse
import traceback

from fastapi import FastAPI
from pydantic import BaseModel
from smolagents import DuckDuckGoSearchTool

app = FastAPI()
search_tool = DuckDuckGoSearchTool()


class SearchRequest(BaseModel):
    query: str
    max_results: int = 5


class SearchResponse(BaseModel):
    results: str
    query: str


@app.get("/health")
def health():
    return {"status": "ok", "engine": "duckduckgo"}


@app.post("/search")
def search(req: SearchRequest) -> SearchResponse:
    try:
        raw = search_tool(req.query)
        # smolagents returns a string of concatenated results
        return SearchResponse(results=raw, query=req.query)
    except Exception as e:
        traceback.print_exc()
        return SearchResponse(results=f"Search failed: {e}", query=req.query)


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Dash search sidecar")
    parser.add_argument("--port", type=int, default=3578, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
