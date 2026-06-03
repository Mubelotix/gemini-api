import os
import sys
import json
import asyncio
from typing import List, Optional, AsyncIterator, Any, Dict
import litellm
from litellm import CustomLLM, ModelResponse
from litellm.types.utils import GenericStreamingChunk
from litellm.proxy.proxy_server import initialize, app
from fastapi import WebSocket, WebSocketDisconnect, HTTPException

# Add current directory to path so that sibling imports work in worker processes
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bridge import bridge, flatten_prompt_and_files
import tool_handler

class GeminiOllamaCustomProvider(CustomLLM):
    async def acompletion(self, model: str, messages: List[Dict[str, Any]], **kwargs: Any) -> ModelResponse:  # type: ignore[override]
        tools: Optional[List[Dict[str, Any]]] = kwargs.get("tools")
        processed_messages = tool_handler.preprocess_messages(messages, tools)
        prompt, files = flatten_prompt_and_files(processed_messages)

        if not bridge.active_websocket:
            raise Exception("No browser extension connected")

        cmd_id = await bridge.get_next_id()
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        bridge.register_receiver(cmd_id, queue)

        try:
            await bridge.send_command(cmd_id, "gemini-generate", prompt=prompt, files=files)
        except Exception as e:
            bridge.unregister_receiver(cmd_id)
            raise Exception(f"Failed to send command: {e}")

        # Clean provider prefix if added by LiteLLM wildcard routing
        clean_model = model.replace("gemini-ollama/", "", 1)

        try:
            response_dict = await tool_handler.get_non_stream_response(cmd_id, queue, clean_model)
            return ModelResponse(**response_dict)
        except HTTPException as e:
            raise Exception(str(e.detail))

    async def astreaming(self, model: str, messages: List[Dict[str, Any]], **kwargs: Any) -> AsyncIterator[GenericStreamingChunk]:  # type: ignore[override]
        tools: Optional[List[Dict[str, Any]]] = kwargs.get("tools")
        processed_messages = tool_handler.preprocess_messages(messages, tools)
        prompt, files = flatten_prompt_and_files(processed_messages)

        if not bridge.active_websocket:
            raise Exception("No browser extension connected")

        cmd_id = await bridge.get_next_id()
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        bridge.register_receiver(cmd_id, queue)

        try:
            await bridge.send_command(cmd_id, "gemini-generate", prompt=prompt, files=files)
        except Exception as e:
            bridge.unregister_receiver(cmd_id)
            raise Exception(f"Failed to send command: {e}")

        # Clean provider prefix if added by LiteLLM wildcard routing
        clean_model = model.replace("gemini-ollama/", "", 1)

        async for raw_line in tool_handler.event_generator(cmd_id, queue, clean_model):
            if not raw_line.startswith("data: "):
                continue
            data_str = raw_line[len("data: "):].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk_data = json.loads(data_str)
            except Exception:
                continue

            if "error" in chunk_data:
                raise Exception(chunk_data["error"])

            choice = chunk_data["choices"][0]
            delta = choice["delta"]
            finish_reason = choice.get("finish_reason")
            is_finished = finish_reason is not None

            yield GenericStreamingChunk(
                text=delta.get("content") or "",
                is_finished=is_finished,
                finish_reason=finish_reason,
                index=0,
                tool_use=delta.get("tool_calls"),
                usage={"completion_tokens": 0, "prompt_tokens": 0, "total_tokens": 0}
            )

# 1. Register custom provider in LiteLLM's internal registry
provider_name = "gemini-ollama"
custom_provider = GeminiOllamaCustomProvider()
litellm.custom_provider_map = [
    {"provider": provider_name, "custom_handler": custom_provider}
]
if provider_name not in litellm._custom_providers:
    litellm._custom_providers.append(provider_name)
if provider_name not in litellm.provider_list:
    litellm.provider_list.append(provider_name)

# 2. Add WebSocket endpoint to LiteLLM's FastAPI app for extension communication
@app.websocket("/incoming-requests")
async def websocket_endpoint(websocket: WebSocket) -> None:
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

# 3. Main runner entrypoint
if __name__ == "__main__":
    import uvicorn
    import yaml  # type: ignore[import-untyped]

    # Write the routing config to a yaml file for LiteLLM initialize to load
    config_data = {
        "model_list": [
            {
                "model_name": "*",
                "litellm_params": {
                    "model": "gemini-ollama/*"
                }
            }
        ]
    }
    
    config_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(config_dir, "litellm_config.yaml")
    with open(config_path, "w") as f:
        yaml.dump(config_data, f)

    # Initialize the LiteLLM Proxy configuration
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(initialize(config=config_path))

    # Retrieve port from env or default to 1111 (as expected by Docker/extension)
    port = int(os.environ.get("PORT", "1111"))
    
    print(f"Starting OpenAI-compatible LiteLLM server on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
