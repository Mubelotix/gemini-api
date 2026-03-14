use anyhow::Context;
use rocket::State;
use rocket::post;
use rocket::response::stream::TextStream;
use rocket::serde::json::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api_common::{GenerateCommandChunk, decode_image_to_file};
use crate::error::AppResult;
use crate::extension_bridge::{ExtensionBridge, ExtensionCommandKind, ExtensionFile, request_gemini_generate_with_files, send_streaming_command};

#[derive(Debug, Deserialize)]
pub struct ChatCompletionsRequest {
    pub model: String,
    pub messages: Vec<ChatCompletionsMessage>,
    #[serde(default)]
    pub stream: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ChatCompletionsMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<Value>,
}

#[derive(Debug, Serialize)]
struct PromptMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<usize>>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionMessage {
    role: String,
    content: String,
    refusal: Option<Value>,
    annotations: Vec<Value>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionChoice {
    index: u32,
    message: ChatCompletionMessage,
    logprobs: Option<Value>,
    finish_reason: String,
}

#[derive(Debug, Serialize)]
struct CompletionUsageDetails {
    reasoning_tokens: u32,
    audio_tokens: u32,
    accepted_prediction_tokens: u32,
    rejected_prediction_tokens: u32,
}

#[derive(Debug, Serialize)]
struct PromptUsageDetails {
    cached_tokens: u32,
    audio_tokens: u32,
}

#[derive(Debug, Serialize)]
struct CompletionUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
    prompt_tokens_details: PromptUsageDetails,
    completion_tokens_details: CompletionUsageDetails,
}

#[derive(Debug, Serialize)]
struct ChatCompletionResponse {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<ChatCompletionChoice>,
    usage: CompletionUsage,
    service_tier: String,
}

#[derive(Debug, Serialize)]
struct ChatCompletionDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionStreamChoice {
    index: u32,
    delta: ChatCompletionDelta,
    logprobs: Option<Value>,
    finish_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionChunk {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<ChatCompletionStreamChoice>,
}

fn extract_text_and_images(content: Option<Value>) -> (String, Vec<String>) {
    let Some(content) = content else {
        return (String::new(), Vec::new());
    };

    match content {
        Value::String(text) => (text, Vec::new()),
        Value::Array(parts) => {
            let mut text_chunks = Vec::new();
            let mut images = Vec::new();

            for part in parts {
                let Value::Object(obj) = part else {
                    continue;
                };

                let part_type = obj
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                if part_type == "text" {
                    if let Some(text) = obj.get("text").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        text_chunks.push(text.to_string());
                    }
                    continue;
                }

                if part_type == "image_url" {
                    let maybe_url = obj
                        .get("image_url")
                        .and_then(Value::as_object)
                        .and_then(|image_obj| image_obj.get("url"))
                        .and_then(Value::as_str);

                    if let Some(url) = maybe_url {
                        images.push(url.to_string());
                    }
                }
            }

            (text_chunks.join("\n"), images)
        }
        other => (other.to_string(), Vec::new()),
    }
}

fn flatten_prompt_and_files(messages: Vec<ChatCompletionsMessage>) -> (String, Vec<ExtensionFile>) {
    let mut prompt_messages = Vec::new();
    let mut files = Vec::new();

    for message in messages {
        let (content, image_payloads) = extract_text_and_images(message.content);
        let mut image_indices = Vec::new();

        for image in image_payloads {
            let next_index = files.len();
            files.push(decode_image_to_file(image));
            image_indices.push(next_index);
        }

        prompt_messages.push(PromptMessage {
            role: message.role,
            content,
            images: if image_indices.is_empty() {
                None
            } else {
                Some(image_indices)
            },
        });
    }

    let prompt = serde_json::to_string(&prompt_messages).unwrap_or_else(|_| "[]".to_string());
    (prompt, files)
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => 0,
    }
}

fn build_non_stream_response(id: String, created: u64, model: String, content: String) -> ChatCompletionResponse {
    ChatCompletionResponse {
        id,
        object: "chat.completion".to_string(),
        created,
        model,
        choices: vec![ChatCompletionChoice {
            index: 0,
            message: ChatCompletionMessage {
                role: "assistant".to_string(),
                content,
                refusal: None,
                annotations: Vec::new(),
            },
            logprobs: None,
            finish_reason: "stop".to_string(),
        }],
        usage: CompletionUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_tokens_details: PromptUsageDetails {
                cached_tokens: 0,
                audio_tokens: 0,
            },
            completion_tokens_details: CompletionUsageDetails {
                reasoning_tokens: 0,
                audio_tokens: 0,
                accepted_prediction_tokens: 0,
                rejected_prediction_tokens: 0,
            },
        },
        service_tier: "default".to_string(),
    }
}

fn build_stream_chunk(id: String, created: u64, model: String, content: Option<String>, include_role: bool, done: bool) -> ChatCompletionChunk {
    ChatCompletionChunk {
        id,
        object: "chat.completion.chunk".to_string(),
        created,
        model,
        choices: vec![ChatCompletionStreamChoice {
            index: 0,
            delta: ChatCompletionDelta {
                role: if include_role {
                    Some("assistant".to_string())
                } else {
                    None
                },
                content,
            },
            logprobs: None,
            finish_reason: if done {
                Some("stop".to_string())
            } else {
                None
            },
        }],
    }
}

#[post("/chat/completions", format = "json", data = "<payload>")]
pub async fn chat_completions(payload: Json<ChatCompletionsRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    chat_completions_impl(payload.into_inner(), state).await
}

#[post("/v1/chat/completions", format = "json", data = "<payload>")]
pub async fn chat_completions_v1(payload: Json<ChatCompletionsRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    chat_completions_impl(payload.into_inner(), state).await
}

async fn chat_completions_impl(req: ChatCompletionsRequest, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    let stream_enabled = req.stream.unwrap_or(false);
    let model = req.model;
    let (prompt, files) = flatten_prompt_and_files(req.messages);

    let id = format!("chatcmpl-{}", uuid_like_suffix(unix_now(), &model));
    let created = unix_now();

    let mut stream_rx_opt = None;
    let mut stream_unsupported_model = false;
    let mut non_stream_body_opt = None;

    if stream_enabled {
        if model.starts_with("gemini") {
            stream_rx_opt = Some(
                send_streaming_command::<serde_json::Value>(
                    state,
                    ExtensionCommandKind::GeminiGenerate { prompt, files },
                )
                .await,
            );
        } else {
            stream_unsupported_model = true;
        }
    } else {
        let response_text = if model.starts_with("gemini") {
            let text = request_gemini_generate_with_files(state, prompt, files)
                .await
                .context("gemini non-stream completion failed")?;
            if text.is_empty() {
                "Gemini returned an empty response.".to_string()
            } else {
                text
            }
        } else {
            format!("Unsupported model: {}", model)
        };

        non_stream_body_opt = Some(build_non_stream_response(
            id.clone(),
            created,
            model.clone(),
            response_text,
        ));
    }

    Ok(TextStream! {
        if stream_enabled {
            if stream_unsupported_model {
                let chunk = build_stream_chunk(
                    id.clone(),
                    created,
                    model.clone(),
                    Some("Unsupported model".to_string()),
                    true,
                    true,
                );

                if let Ok(line) = serde_json::to_string(&chunk) {
                    yield format!("data: {}\n\n", line);
                }
                yield "data: [DONE]\n\n".to_string();
                return;
            }

            let mut emitted_role = false;

            if let Some(mut stream_rx) = stream_rx_opt {
                while let Some(item) = stream_rx.recv().await {
                    let (text, done) = match item {
                        Ok(item) => {
                            let chunk: GenerateCommandChunk = serde_json::from_value(item.value)
                                .unwrap_or(GenerateCommandChunk {
                                    text: String::new(),
                                    error: Some("failed to decode extension response chunk".to_string()),
                                });

                            let text = if let Some(error) = chunk.error {
                                format!("Gemini stream error: {}", error)
                            } else {
                                chunk.text
                            };
                            (text, item.done)
                        }
                        Err(error) => (format!("Gemini stream error: {}", error), true),
                    };

                    let chunk = build_stream_chunk(
                        id.clone(),
                        created,
                        model.clone(),
                        if text.is_empty() { None } else { Some(text) },
                        !emitted_role,
                        done,
                    );

                    if let Ok(line) = serde_json::to_string(&chunk) {
                        yield format!("data: {}\n\n", line);
                    }

                    emitted_role = true;

                    if done {
                        break;
                    }
                }
            }

            yield "data: [DONE]\n\n".to_string();
        } else if let Some(body) = non_stream_body_opt
            && let Ok(line) = serde_json::to_string(&body) {
            yield format!("{}\n", line);
        }
    })
}

fn uuid_like_suffix(created: u64, model: &str) -> String {
    let reduced_model = model
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>();
    format!("{}{}", created, reduced_model)
}
