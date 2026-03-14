use anyhow::anyhow;
use rocket::post;
use rocket::serde::json::Json;
use serde::Deserialize;

use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub model: String,
    #[serde(default)]
    pub insecure: Option<bool>,
    #[serde(default)]
    pub stream: Option<bool>,
}

#[post("/api/push", format = "json", data = "<payload>")]
pub async fn push_model(payload: Json<PushRequest>) -> AppResult<()> {
    let req = payload.into_inner();
    let _ = (req.model, req.insecure, req.stream);
    Err(anyhow!("unsupported").into())
}
