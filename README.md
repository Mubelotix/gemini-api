# 🚀 Gemini API

An incredibly fast, self-contained proxy that brings a drop-in **OpenAI-compatible API** to Google's Gemini web interface! 

This project serves as an alternative to [Nativu5/Gemini-FastAPI](https://github.com/Nativu5/Gemini-FastAPI). However, instead of reverse-engineering the entire private Gemini API (which is fragile and frequently breaks), this proxy leverages Gemini's official web client directly by running it inside a headless Chrome browser.

By running Chrome and a local FastAPI backend inside a single container, this proxy automatically bridges your API calls directly to Gemini's web client. It's the ultimate way to get premium access!

---

## ⚡ Quick Start

### 1. Spin up the Container
Run the container to start the headless Chrome interface (exposing the VNC console on port `3000` and the API on port `1111`). Make sure to mount a volume to persist your Google login session!

```bash
docker run --rm -d \
  --name gemini-api \
  -p 3000:3000 \
  -p 1111:1111 \
  -v "$(pwd)/config:/config" \
  --shm-size="1gb" \
  ghcr.io/mubelotix/gemini-api:latest
```

> [!TIP]
> Open **[http://localhost:3000](http://localhost:3000)** in your browser, log in to Google/Gemini inside the desktop interface, and you are ready to go!

### 2. Send your first Request
Test the OpenAI-compatible endpoint from your terminal:

```bash
curl -X POST http://localhost:1111/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-1.5-pro",
    "messages": [
      {"role": "user", "content": "Say hello!"}
    ]
  }'
```

**Success Response:**
```json
{
  "id": "chatcmpl-1",
  "object": "chat.completion",
  "created": 1780353737,
  "model": "gemini-1.5-pro",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! Let me know what you need help with."
      },
      "finish_reason": "stop"
    }
  ]
}
```
