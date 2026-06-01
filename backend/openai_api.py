import json
import time
import asyncio
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from bridge import bridge, flatten_prompt_and_files
import tool_handler

router = APIRouter()

class ChatCompletionsRequest(BaseModel):
    messages: List[dict]
    model: str
    stream: Optional[bool] = False
    tools: Optional[List[dict]] = None

    class Config:
        extra = "allow"

def build_stream_chunk(id: str, created: int, model: str, content: Optional[str], include_role: bool, done: bool) -> dict:
    delta = {}
    if include_role:
        delta["role"] = "assistant"
    if content is not None:
        delta["content"] = content
    
    return {
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "logprobs": None,
            "finish_reason": "stop" if done else None
        }]
    }

async def event_generator(cmd_id: int, queue: asyncio.Queue, model: str):
    created_time = int(time.time())
    chunk_id = f"chatcmpl-{cmd_id}"
    first = True
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=1200.0)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'error': 'Timeout waiting for response from browser extension'})}\n\n"
                break
                
            error = item.get("error")
            if error:
                yield f"data: {json.dumps({'error': error})}\n\n"
                break
                
            text = item.get("text", "")
            done = item.get("done", False)
            
            if first or text or done:
                chunk = build_stream_chunk(
                    id=chunk_id,
                    created=created_time,
                    model=model,
                    content=text if text else None,
                    include_role=first,
                    done=done
                )
                yield f"data: {json.dumps(chunk)}\n\n"
                first = False
                
            if done:
                break
    finally:
        bridge.unregister_receiver(cmd_id)
    yield "data: [DONE]\n\n"

async def get_non_stream_response(cmd_id: int, queue: asyncio.Queue, model: str):
    created_time = int(time.time())
    chunk_id = f"chatcmpl-{cmd_id}"
    accumulated_text = []
    
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=1200.0)
            except asyncio.TimeoutError:
                raise HTTPException(status_code=504, detail="Timeout waiting for response from browser extension")
                
            error = item.get("error")
            if error:
                raise HTTPException(status_code=500, detail=str(error))
                
            text = item.get("text", "")
            if text:
                accumulated_text.append(text)
                
            if item.get("done", False):
                break
    finally:
        bridge.unregister_receiver(cmd_id)
        
    full_text = "".join(accumulated_text)
    return {
        "id": chunk_id,
        "object": "chat.completion",
        "created": created_time,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": full_text
            },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "prompt_tokens_details": {
                "cached_tokens": 0,
                "audio_tokens": 0
            },
            "completion_tokens_details": {
                "reasoning_tokens": 0,
                "audio_tokens": 0,
                "accepted_prediction_tokens": 0,
                "rejected_prediction_tokens": 0
            }
        },
        "service_tier": "default"
    }

@router.post("/v1/chat/completions")
@router.post("/chat/completions")
async def chat_completions(request: ChatCompletionsRequest):
    model = request.model
    processed_messages = tool_handler.preprocess_messages(request.messages, request.tools)
    prompt, files = flatten_prompt_and_files(processed_messages)
    stream_enabled = request.stream
    
    if not bridge.active_websocket:
        raise HTTPException(status_code=503, detail="No browser extension connected")
        
    cmd_id = await bridge.get_next_id()
    queue: asyncio.Queue = asyncio.Queue()
    bridge.register_receiver(cmd_id, queue)
    
    try:
        await bridge.send_command(cmd_id, "gemini-generate", prompt=prompt, files=files)
    except Exception as e:
        bridge.unregister_receiver(cmd_id)
        raise HTTPException(status_code=500, detail=f"Failed to send command: {e}")
        
    if stream_enabled:
        return StreamingResponse(
            tool_handler.event_generator(cmd_id, queue, model),
            media_type="text/event-stream"
        )
    else:
        return await tool_handler.get_non_stream_response(cmd_id, queue, model)
