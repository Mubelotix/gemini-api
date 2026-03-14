use anyhow::anyhow;
use rocket::post;
use rocket::serde::json::Json;
use serde::Deserialize;

use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct CopyRequest {
    pub source: String,
    pub destination: String,
}

#[post("/api/copy", format = "json", data = "<payload>")]
pub async fn copy_model(payload: Json<CopyRequest>) -> AppResult<()> {
    let req = payload.into_inner();
    let _ = (req.source, req.destination);
    Err(anyhow!("unsupported").into())
}
