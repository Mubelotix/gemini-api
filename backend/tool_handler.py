import json
import time
import re
import asyncio
from typing import List, Optional, Tuple
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from bridge import bridge

def inject_tools_instruction(messages: List[dict], tools: List[dict]) -> List[dict]:
    if not tools:
        return messages
        
    tools_json = json.dumps(tools, indent=2)
    
    instruction = (
        "You have access to the following tools that you can call if needed:\n"
        f"<tools>\n{tools_json}\n</tools>\n\n"
        "If you decide to call one or more tools, you MUST respond ONLY with a JSON tool call block in the following format:\n"
        "```json-tool-call\n"
        "{\n"
        "  \"tool_calls\": [\n"
        "    {\n"
        "      \"id\": \"call_unique_id_here\",\n"
        "      \"type\": \"function\",\n"
        "      \"function\": {\n"
        "        \"name\": \"tool_name\",\n"
        "        \"arguments\": {\n"
        "          \"arg1\": \"value1\"\n"
        "        }\n"
        "      }\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "```\n"
        "Make sure the function arguments is a valid JSON object matching the tool's schema.\n"
        "Do not include any other text, explanation, or conversational filler when making a tool call. Respond only with the json-tool-call code block."
    )
    
    new_messages = []
    system_msg_found = False
    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content") or ""
            if content:
                msg = msg.copy()
                msg["content"] = content + "\n\n" + instruction
            else:
                msg = msg.copy()
                msg["content"] = instruction
            system_msg_found = True
        new_messages.append(msg)
        
    if not system_msg_found:
        new_messages.insert(0, {"role": "system", "content": instruction})
        
    return new_messages

def preprocess_messages(messages: List[dict], tools: Optional[List[dict]]) -> List[dict]:
    processed = []
    for msg in messages:
        msg = msg.copy()
        role = msg.get("role")
        
        # 1. Handle assistant tool calls in history
        if role == "assistant" and msg.get("tool_calls"):
            try:
                tool_calls_list = []
                for tc in msg["tool_calls"]:
                    args = tc["function"].get("arguments")
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except:
                            pass
                    tool_calls_list.append({
                        "id": tc.get("id"),
                        "type": "function",
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": args
                        }
                    })
                
                tool_calls_data = {"tool_calls": tool_calls_list}
                msg["content"] = f"```json-tool-call\n{json.dumps(tool_calls_data, indent=2)}\n```"
                msg.pop("tool_calls", None)
            except Exception as e:
                pass
                
        # 2. Handle tool responses in history
        elif role == "tool":
            tool_id = msg.get("tool_call_id", "")
            tool_name = msg.get("name", "tool")
            content = msg.get("content", "")
            # Convert tool message to a user instruction containing the tool output
            msg["role"] = "user"
            msg["content"] = f"Tool '{tool_name}' (ID: {tool_id}) returned the following result:\n{content}"
            msg.pop("tool_call_id", None)
            msg.pop("name", None)
            
        processed.append(msg)
        
    # 3. Inject system instruction for available tools
    if tools:
        processed = inject_tools_instruction(processed, tools)
        
    return processed

def parse_tool_calls(text: str) -> Optional[List[dict]]:
    if not text:
        return None
        
    # Pattern 1: Look for ```json-tool-call ... ```
    pattern = re.compile(r'```json-tool-call\s*(.*?)\s*```', re.DOTALL)
    match = pattern.search(text)
    
    json_str = None
    if match:
        json_str = match.group(1).strip()
    else:
        # Pattern 2: Look for raw JSON if text starts with '{' and contains 'tool_calls'
        stripped = text.strip()
        if stripped.startswith("{") and stripped.endswith("}") and "tool_calls" in stripped:
            json_str = stripped
            
    if not json_str:
        return None
        
    try:
        data = json.loads(json_str)
        if isinstance(data, dict) and "tool_calls" in data:
            tool_calls = data["tool_calls"]
            if isinstance(tool_calls, list):
                validated = []
                for tc in tool_calls:
                    if isinstance(tc, dict) and "function" in tc:
                        func = tc["function"]
                        if isinstance(func, dict) and "name" in func:
                            # Arguments must be a JSON-serialized string in OpenAI format
                            args = func.get("arguments", {})
                            if not isinstance(args, str):
                                args = json.dumps(args)
                            
                            validated.append({
                                "id": tc.get("id") or f"call_{int(time.time())}_{tc['function']['name']}",
                                "type": "function",
                                "function": {
                                    "name": func["name"],
                                    "arguments": args
                                }
                            })
                if validated:
                    return validated
    except:
        pass
    return None

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
    
    # Check if there is a tool call in the response
    tool_calls = parse_tool_calls(full_text)
    
    if tool_calls:
        choice_message = {
            "role": "assistant",
            "content": None,
            "tool_calls": tool_calls
        }
        finish_reason = "tool_calls"
    else:
        choice_message = {
            "role": "assistant",
            "content": full_text
        }
        finish_reason = "stop"
        
    return {
        "id": chunk_id,
        "object": "chat.completion",
        "created": created_time,
        "model": model,
        "choices": [{
            "index": 0,
            "message": choice_message,
            "finish_reason": finish_reason
        }],
        "choices": [{
            "index": 0,
            "message": choice_message,
            "finish_reason": finish_reason
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

def build_stream_chunk(id: str, created: int, model: str, content: Optional[str], tool_calls: Optional[list], include_role: bool, done: bool) -> dict:
    delta = {}
    if include_role:
        delta["role"] = "assistant"
    if content is not None:
        delta["content"] = content
    if tool_calls is not None:
        delta["tool_calls"] = tool_calls
    
    return {
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "logprobs": None,
            "finish_reason": "tool_calls" if (tool_calls and done) else ("stop" if done else None)
        }]
    }

async def event_generator(cmd_id: int, queue: asyncio.Queue, model: str):
    created_time = int(time.time())
    chunk_id = f"chatcmpl-{cmd_id}"
    first = True
    
    accumulator = ""
    is_tool_call = None  # None: undecided, True: tool call, False: normal text
    
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
            
            if text:
                accumulator += text
                
            if is_tool_call is None:
                stripped = accumulator.lstrip()
                if len(stripped) >= 15:
                    if stripped.startswith("```json-tool-call") or stripped.startswith("{"):
                        is_tool_call = True
                    else:
                        is_tool_call = False
                        chunk = build_stream_chunk(
                            id=chunk_id,
                            created=created_time,
                            model=model,
                            content=accumulator,
                            tool_calls=None,
                            include_role=first,
                            done=False
                        )
                        yield f"data: {json.dumps(chunk)}\n\n"
                        first = False
                elif done:
                    if stripped.startswith("```json-tool-call") or stripped.startswith("{"):
                        is_tool_call = True
                    else:
                        is_tool_call = False
            
            if is_tool_call is False:
                if text or done:
                    chunk = build_stream_chunk(
                        id=chunk_id,
                        created=created_time,
                        model=model,
                        content=text if text else None,
                        tool_calls=None,
                        include_role=first,
                        done=done
                    )
                    yield f"data: {json.dumps(chunk)}\n\n"
                    first = False
                    
            if done:
                if is_tool_call is True:
                    tool_calls = parse_tool_calls(accumulator)
                    if tool_calls:
                        chunk = build_stream_chunk(
                            id=chunk_id,
                            created=created_time,
                            model=model,
                            content=None,
                            tool_calls=tool_calls,
                            include_role=first,
                            done=True
                        )
                        yield f"data: {json.dumps(chunk)}\n\n"
                    else:
                        chunk = build_stream_chunk(
                            id=chunk_id,
                            created=created_time,
                            model=model,
                            content=accumulator,
                            tool_calls=None,
                            include_role=first,
                            done=True
                        )
                        yield f"data: {json.dumps(chunk)}\n\n"
                break
    finally:
        bridge.unregister_receiver(cmd_id)
    yield "data: [DONE]\n\n"
