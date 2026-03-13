use rocket::post;
use rocket::serde::json::Json;
use rocket::State;
use serde::{Deserialize, Serialize};

use crate::api_tags::{request_gemini_generate, ExtensionBridge};

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

#[post("/api/generate", format = "json", data = "<payload>")]
pub async fn generate(payload: Json<GenerateRequest>, state: &State<ExtensionBridge>) -> Json<GenerateResponse> {
    let req = payload.into_inner();
    let prompt = req.prompt.clone().unwrap_or_default();

    let response = if req.model.starts_with("gemini") {
        match request_gemini_generate(state.inner(), prompt).await {
            Some(text) if !text.is_empty() => text,
            Some(_) => "Gemini returned an empty response.".to_string(),
            None => "Gemini is unavailable or the request timed out.".to_string(),
        }
    } else {
        format!("Unsupported model: {}", req.model)
    };

    Json(GenerateResponse {
        model: req.model,
        created_at: "2026-03-13T00:00:00.000000000Z".to_string(),
        response,
        done: true,
        done_reason: "stop".to_string(),
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: 0,
        prompt_eval_duration: 0,
        eval_count: 0,
        eval_duration: 0,
    })
}
