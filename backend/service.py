import os
import sys
import json
import bentoml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

# Add current directory to path so that sibling imports work in worker processes
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bridge import bridge
from openai_api import router as openai_router
from ollama_api import router as ollama_router

# 1. Create FastAPI app and include modular routers
app = FastAPI()
app.include_router(openai_router)
app.include_router(ollama_router)

# 2. Main index endpoint
@app.get("/")
async def index():
    return "Hello, world!"

# 3. WebSocket endpoint for Chrome Extension bridge routing
@app.websocket("/incoming-requests")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    await bridge.register_websocket(websocket)
    try:
        while True:
            try:
                data = await websocket.receive_json()
                await bridge.handle_client_message(data)
            except (json.JSONDecodeError, ValueError):
                continue
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        bridge.unregister_websocket()

# 4. Wrap the FastAPI app in a BentoML service definition
@bentoml.asgi_app(app, path="/")
@bentoml.service(resources={"cpu": "2"})
class OpenAICompatibleService:
    pass
