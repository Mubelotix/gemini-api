import json
import asyncio
from typing import List, Optional, Dict
from fastapi import WebSocket

# Helper for decoding images from data URLs to bytes for the extension
def decode_image_to_file(image_url: str) -> dict:
    if image_url.startswith("data:"):
        payload = image_url[len("data:"):]
        if "," in payload:
            meta, bytes_str = payload.split(",", 1)
            content_type = meta.split(";")[0] if meta else "image/png"
            return {
                "bytes": bytes_str,
                "contentType": content_type
            }
    return {
        "bytes": image_url,
        "contentType": "image/png"
    }

# Helper to extract text chunks and image URLs from OpenAI/Ollama messages
def extract_text_and_images(content) -> tuple[str, list[str]]:
    if not content:
        return "", []
    if isinstance(content, str):
        return content, []
    if isinstance(content, list):
        text_chunks = []
        images = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type == "text":
                text = part.get("text")
                if text:
                    text_chunks.append(text)
            elif part_type == "image_url":
                image_url_obj = part.get("image_url")
                if isinstance(image_url_obj, dict):
                    url = image_url_obj.get("url")
                    if url:
                        images.append(url)
        return "\n".join(text_chunks), images
    return str(content), []

# Helper to format and flatten messages/files for the OpenAI prompt
def flatten_prompt_and_files(messages: List[dict]) -> tuple[str, list[dict]]:
    prompt_messages = []
    files = []
    
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        name = msg.get("name")
        tool_call_id = msg.get("tool_call_id")
        tool_calls = msg.get("tool_calls")
        
        text_content, image_payloads = extract_text_and_images(content)
        image_indices = []
        for img in image_payloads:
            next_idx = len(files)
            files.append(decode_image_to_file(img))
            image_indices.append(next_idx)
            
        prompt_msg = {
            "role": role,
            "content": text_content,
        }
        if name is not None:
            prompt_msg["name"] = name
        if tool_call_id is not None:
            prompt_msg["tool_call_id"] = tool_call_id
        if tool_calls is not None:
            prompt_msg["tool_calls"] = tool_calls
        if image_indices:
            prompt_msg["images"] = image_indices
            
        prompt_messages.append(prompt_msg)
        
    prompt = json.dumps(prompt_messages)
    return prompt, files



# Extension bridge to manage websocket connection and route commands/responses
class ExtensionBridge:
    def __init__(self):
        self.active_websocket: Optional[WebSocket] = None
        self.receivers: Dict[int, asyncio.Queue] = {}
        self.counter = 0
        self.lock = asyncio.Lock()

    async def register_websocket(self, websocket: WebSocket):
        self.active_websocket = websocket

    def unregister_websocket(self):
        self.active_websocket = None

    async def get_next_id(self) -> int:
        async with self.lock:
            self.counter += 1
            return self.counter

    async def send_command(self, cmd_id: int, cmd_type: str, **kwargs):
        if not self.active_websocket:
            raise RuntimeError("No browser extension connected")
        payload = {
            "id": cmd_id,
            "type": cmd_type,
            **kwargs
        }
        await self.active_websocket.send_json(payload)

    def register_receiver(self, cmd_id: int, queue: asyncio.Queue):
        self.receivers[cmd_id] = queue

    def unregister_receiver(self, cmd_id: int):
        self.receivers.pop(cmd_id, None)

    async def handle_client_message(self, data: dict):
        cmd_id = data.get("id")
        if cmd_id is not None and cmd_id in self.receivers:
            await self.receivers[cmd_id].put(data)

# Singleton bridge instance
bridge = ExtensionBridge()
