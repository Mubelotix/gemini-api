use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct GenerateCommandChunk {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub error: Option<String>,
}
