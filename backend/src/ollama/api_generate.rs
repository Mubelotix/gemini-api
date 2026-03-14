use anyhow::{Context, anyhow};
use rocket::post;
use rocket::response::stream::TextStream;
use rocket::State;
use serde::{Deserialize, Serialize};

use crate::api_common::GenerateCommandChunk;
use crate::extension_bridge::{ExtensionBridge, ExtensionFile, request_gemini_generate_with_files, send_streaming_command};
use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct GenerateRequest {
    pub model: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    #[serde(default)]
    pub images: Option<Vec<String>>,
    #[serde(default)]
    pub format: Option<serde_json::Value>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub stream: Option<bool>,
    #[serde(default)]
    pub think: Option<serde_json::Value>,
    #[serde(default)]
    pub raw: Option<bool>,
    #[serde(default)]
    pub keep_alive: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Option<serde_json::Value>,
    #[serde(default)]
    pub logprobs: Option<bool>,
    #[serde(default)]
    pub top_logprobs: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct GenerateResponse {
    model: String,
    created_at: String,
    response: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    done_reason: String,
    total_duration: u64,
    load_duration: u64,
    prompt_eval_count: u64,
    prompt_eval_duration: u64,
    eval_count: u64,
    eval_duration: u64,
}

#[derive(Debug, Serialize)]
pub struct GenerateStreamResponse {
    model: String,
    created_at: String,
    response: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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

fn normalize_files(images: Option<Vec<String>>) -> Vec<ExtensionFile> {
    let mut normalized = Vec::new();

    if let Some(images) = images {
        normalized.extend(images.into_iter().map(decode_image_to_file));
    }

    normalized
}

fn format_prompt(system: Option<String>, prompt: String) -> String {
    if prompt.trim().is_empty() {
        return prompt;
    }

    let Some(system_text) = system.filter(|value| !value.trim().is_empty()) else {
        return prompt;
    };

    let mut messages = Vec::new();

    messages.push(serde_json::json!({
        "role": "system",
        "content": system_text,
    }));

    messages.push(serde_json::json!({
        "role": "user",
        "content": prompt,
    }));

    serde_json::to_string(&messages).unwrap_or_else(|_| "[]".to_string())
}

fn validate_generate_request(req: &GenerateRequest) -> AppResult<()> {
    if req.suffix.is_some() {
        return Err(anyhow!("the `suffix` field is not supported").into());
    }

    if let Some(format) = &req.format {
        let is_json_string = matches!(format, serde_json::Value::String(value) if value == "json");
        if !is_json_string {
            return Err(anyhow!("the `format` field only supports the string `json`").into());
        }
    }

    if req.raw.is_some() {
        return Err(anyhow!("the `raw` field is not supported").into());
    }

    if req.logprobs.is_some() || req.top_logprobs.is_some() {
        return Err(anyhow!("the `logprobs` and `top_logprobs` fields are not supported").into());
    }

    Ok(())
}

#[post("/api/generate", format = "json", data = "<payload>")]
pub async fn generate(payload: rocket::serde::json::Json<GenerateRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    let req = payload.into_inner();
    validate_generate_request(&req)?;
    let model = req.model;
    let prompt = format_prompt(req.system, req.prompt.unwrap_or_default());
    let files = normalize_files(req.images);
    let stream_enabled = req.stream.unwrap_or(true);
    let created_at = "2026-03-13T00:00:00.000000000Z".to_string();

    let mut stream_rx_opt = None;
    let mut stream_unsupported_model = false;
    let mut non_stream_body_opt = None;

    if stream_enabled {
        if model.starts_with("gemini") {
            stream_rx_opt = Some(
                send_streaming_command::<serde_json::Value>(
                    state,
                    crate::extension_bridge::ExtensionCommandKind::GeminiGenerate {
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
                .context("gemini non-stream generation failed")?;
            if text.is_empty() {
                "Gemini returned an empty response.".to_string()
            } else {
                text
            }
        } else {
            format!("Unsupported model: {}", model)
        };

        non_stream_body_opt = Some(GenerateResponse {
            model: model.clone(),
            created_at: created_at.clone(),
            response,
            done: true,
            error: None,
            done_reason: "stop".to_string(),
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
                let chunk = GenerateStreamResponse {
                    model: model.clone(),
                    created_at: created_at.clone(),
                    response: "Unsupported model".to_string(),
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

                            GenerateStreamResponse {
                                model: model.clone(),
                                created_at: created_at.clone(),
                                response: chunk.text,
                                done: item.done || chunk.error.is_some(),
                                error: chunk.error,
                            }
                        }
                        Err(error) => GenerateStreamResponse {
                            model: model.clone(),
                            created_at: created_at.clone(),
                            response: String::new(),
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
