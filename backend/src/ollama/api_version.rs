use rocket::get;
use rocket::serde::json::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct VersionResponse {
    version: String,
}

#[get("/api/version")]
pub async fn version() -> Json<VersionResponse> {
    Json(VersionResponse {
        version: "0.17.1".to_string(),
    })
}
