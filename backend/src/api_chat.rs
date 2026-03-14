use anyhow::{Context, anyhow};
use rocket::post;
use rocket::response::stream::TextStream;
use rocket::serde::json::Json;
use rocket::State;
use serde::{Deserialize, Serialize};

use crate::api_common::GenerateCommandChunk;
use crate::error::AppResult;
use crate::extension_bridge::{ExtensionBridge, ExtensionCommandKind, ExtensionFile, request_gemini_generate_with_files, send_streaming_command};

#[derive(Debug, Deserialize)]
pub struct ChatMessageRequest {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub images: Option<Vec<String>>,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct ChatPromptMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<usize>>,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessageRequest>,
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
    #[serde(default)]
    pub format: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Option<serde_json::Value>,
    #[serde(default)]
    pub stream: Option<bool>,
    #[serde(default)]
    pub keep_alive: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    model: String,
    created_at: String,
    message: ChatResponseMessage,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    total_duration: u64,
    load_duration: u64,
    prompt_eval_count: u64,
    prompt_eval_duration: u64,
    eval_count: u64,
    eval_duration: u64,
}

#[derive(Debug, Serialize)]
pub struct ChatStreamResponse {
    model: String,
    created_at: String,
    message: ChatResponseMessage,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponseMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<String>>,
}

fn decode_image_to_file(image: String) -> ExtensionFile {
    if let Some(payload) = image.strip_prefix("data:")
        && let Some((meta, bytes)) = payload.split_once(',')
    {
        let content_type = meta
            .split(';')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("image/png")
            .to_string();

        return ExtensionFile {
            bytes: bytes.to_string(),
            content_type,
        };
    }

    ExtensionFile {
        bytes: image,
        content_type: "image/png".to_string(),
    }
}

fn flatten_chat_prompt_and_files(messages: Vec<ChatMessageRequest>) -> (String, Vec<ExtensionFile>) {
    let mut prompt_messages = Vec::new();
    let mut files = Vec::new();

    for message in messages {
        let _tool_calls = message.tool_calls;
        let mut image_indices = Vec::new();

        if let Some(images) = message.images {
            for image in images {
                let next_index = files.len();
                files.push(decode_image_to_file(image));
                image_indices.push(next_index);
            }
        }

        prompt_messages.push(ChatPromptMessage {
            role: message.role,
            content: message.content,
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

fn validate_chat_request(req: &ChatRequest) -> AppResult<()> {
    if let Some(format) = &req.format {
        let is_json_string = matches!(format, serde_json::Value::String(value) if value == "json");
        if !is_json_string {
            return Err(anyhow!("the `format` field only supports the string `json`").into());
        }
    }

    Ok(())
}

#[post("/api/chat", format = "json", data = "<payload>")]
pub async fn chat(payload: Json<ChatRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    let req = payload.into_inner();
    validate_chat_request(&req)?;

    let model = req.model;
    let (prompt, files) = flatten_chat_prompt_and_files(req.messages);
    let stream_enabled = req.stream.unwrap_or(true);
    let _tools = req.tools;
    let _options = req.options;
    let _keep_alive = req.keep_alive;
    let created_at = "2026-03-13T00:00:00.000000000Z".to_string();

    let mut stream_rx_opt = None;
    let mut stream_unsupported_model = false;
    let mut non_stream_body_opt = None;

    if stream_enabled {
        if model.starts_with("gemini") {
            stream_rx_opt = Some(
                send_streaming_command::<serde_json::Value>(
                    state,
                    ExtensionCommandKind::GeminiGenerate {
                        prompt,
                        files,
                    },
                )
                .await,
            );
        } else {
            stream_unsupported_model = true;
        }
    } else {
        let response = if model.starts_with("gemini") {
            let text = request_gemini_generate_with_files(state, prompt, files)
                .await
                .context("gemini non-stream chat failed")?;
            if text.is_empty() {
                "Gemini returned an empty response.".to_string()
            } else {
                text
            }
        } else {
            format!("Unsupported model: {}", model)
        };

        non_stream_body_opt = Some(ChatResponse {
            model: model.clone(),
            created_at: created_at.clone(),
            message: ChatResponseMessage {
                role: "assistant".to_string(),
                content: response,
                images: None,
            },
            done: true,
            error: None,
            total_duration: 0,
            load_duration: 0,
            prompt_eval_count: 0,
            prompt_eval_duration: 0,
            eval_count: 0,
            eval_duration: 0,
        });
    }

    Ok(TextStream! {
        if stream_enabled {
            if stream_unsupported_model {
                let chunk = ChatStreamResponse {
                    model: model.clone(),
                    created_at: created_at.clone(),
                    message: ChatResponseMessage {
                        role: "assistant".to_string(),
                        content: "Unsupported model".to_string(),
                        images: None,
                    },
                    done: true,
                    error: None,
                };
                if let Ok(line) = serde_json::to_string(&chunk) {
                    yield format!("{}\n", line);
                }
            }

            if let Some(mut stream_rx) = stream_rx_opt {
                while let Some(item) = stream_rx.recv().await {
                    let chunk = match item {
                        Ok(item) => {
                            let chunk: GenerateCommandChunk = serde_json::from_value(item.value)
                                .unwrap_or(GenerateCommandChunk {
                                    text: String::new(),
                                    error: Some("failed to decode extension response chunk".to_string()),
                                });

                            ChatStreamResponse {
                                model: model.clone(),
                                created_at: created_at.clone(),
                                message: ChatResponseMessage {
                                    role: "assistant".to_string(),
                                    content: chunk.text,
                                    images: None,
                                },
                                done: item.done || chunk.error.is_some(),
                                error: chunk.error,
                            }
                        }
                        Err(error) => ChatStreamResponse {
                            model: model.clone(),
                            created_at: created_at.clone(),
                            message: ChatResponseMessage {
                                role: "assistant".to_string(),
                                content: String::new(),
                                images: None,
                            },
                            done: true,
                            error: Some(format!("Gemini stream error: {}", error)),
                        },
                    };

                    if let Ok(line) = serde_json::to_string(&chunk) {
                        yield format!("{}\n", line);
                    }

                    if chunk.done {
                        break;
                    }
                }
            }
        } else if let Some(body) = non_stream_body_opt
            && let Ok(line) = serde_json::to_string(&body) {
            yield format!("{}\n", line);
        }
    })
}
