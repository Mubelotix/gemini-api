use anyhow::anyhow;
use rocket::post;
use rocket::serde::json::Json;
use serde::Deserialize;

use crate::error::AppResult;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum EmbedInput {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Debug, Deserialize)]
pub struct EmbedRequest {
    pub model: String,
    pub input: EmbedInput,
    #[serde(default = "default_truncate")]
    pub truncate: bool,
    #[serde(default)]
    pub options: Option<serde_json::Value>,
    #[serde(default)]
    pub keep_alive: Option<serde_json::Value>,
}

fn default_truncate() -> bool {
    true
}

#[post("/api/embed", format = "json", data = "<payload>")]
pub async fn embed_model(payload: Json<EmbedRequest>) -> AppResult<()> {
    let req = payload.into_inner();
    let _ = (req.model, req.input, req.truncate, req.options, req.keep_alive);
    Err(anyhow!("unsupported").into())
}
