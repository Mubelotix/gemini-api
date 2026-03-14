use anyhow::Context;
use rocket::post;
use rocket::response::stream::TextStream;
use rocket::State;
use serde::{Deserialize, Serialize};

use crate::api_tags::{ExtensionBridge, request_gemini_generate, send_streaming_command};
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
}

#[post("/api/generate", format = "json", data = "<payload>")]
pub async fn generate(payload: rocket::serde::json::Json<GenerateRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    let req = payload.into_inner();
    let model = req.model;
    let prompt = req.prompt.unwrap_or_default();
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
                    crate::api_tags::ExtensionCommandKind::GeminiGenerate { prompt },
                )
                .await,
            );
        } else {
            stream_unsupported_model = true;
        }
    } else {
        let response = if model.starts_with("gemini") {
            let text = request_gemini_generate(state, prompt)
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
                };
                if let Ok(line) = serde_json::to_string(&chunk) {
                    yield format!("{}\n", line);
                }
            }

            if let Some(mut stream_rx) = stream_rx_opt {
                while let Some(item) = stream_rx.recv().await {
                    let chunk = match item {
                        Ok(item) => {
                            let text = item
                                .value
                                .get("text")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();

                            GenerateStreamResponse {
                                model: model.clone(),
                                created_at: created_at.clone(),
                                response: text,
                                done: item.done,
                            }
                        }
                        Err(error) => GenerateStreamResponse {
                            model: model.clone(),
                            created_at: created_at.clone(),
                            response: format!("Gemini stream error: {}", error),
                            done: true,
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
        } else {
            if let Some(body) = non_stream_body_opt {
                if let Ok(line) = serde_json::to_string(&body) {
                    yield format!("{}\n", line);
                }
            }
        }
    })
}
