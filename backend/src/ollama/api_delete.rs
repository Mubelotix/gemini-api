use anyhow::anyhow;
use rocket::delete;
use rocket::serde::json::Json;
use serde::Deserialize;

use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct DeleteRequest {
    pub model: String,
}

#[delete("/api/delete", format = "json", data = "<payload>")]
pub async fn delete_model(payload: Json<DeleteRequest>) -> AppResult<()> {
    let _model = payload.into_inner().model;
    Err(anyhow!("unsupported").into())
}
