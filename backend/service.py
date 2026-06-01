import bentoml
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional

# 1. Define your minimal OpenAI Schemas (or import them from vLLM/LiteLLM)
class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    model: Optional[str] = "my-custom-function"

# 2. Your custom text generation logic
def my_simple_text_generator(messages):
    last_message = messages[-1].content
    return f"You said: {last_message}. This is a generated response."

# 3. Create a FastAPI app
app = FastAPI()

@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest):
    # Call your function
    response_text = my_simple_text_generator(request.messages)
    
    # Return the exact OpenAI JSON structure
    return {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": request.model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": response_text
            },
            "finish_reason": "stop"
        }]
    }

# 4. Wrap it all in BentoML
@bentoml.asgi_app(app, path="/")
@bentoml.service(resources={"cpu": "2"})
class OpenAICompatibleService:
    pass
