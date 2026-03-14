use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rocket::get;
use rocket::serde::json::Json;
use rocket::tokio::sync::{broadcast, oneshot, Mutex};
use rocket::tokio::time::{timeout, Duration};
use rocket::State;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone)]
pub struct ExtensionBridge {
    pub command_tx: broadcast::Sender<ExtensionCommand>,
    pub receivers: Arc<Mutex<HashMap<usize, oneshot::Sender<Value>>>>,
    pub counter: Arc<AtomicUsize>,
}

impl ExtensionBridge {
    pub fn new(command_tx: broadcast::Sender<ExtensionCommand>) -> Self {
        Self {
            command_tx,
            receivers: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ExtensionCommandKind {
    CheckGeminiLogin,
    GeminiGenerate { prompt: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtensionCommand {
    pub id: usize,
    #[serde(flatten)]
    pub kind: ExtensionCommandKind,
}

pub async fn send_command<R: DeserializeOwned>(state: &State<ExtensionBridge>, kind: ExtensionCommandKind) -> Result<R, String> {
    let request_id = state.counter.fetch_add(1, Ordering::SeqCst);

    let command = ExtensionCommand {
        id: request_id,
        kind,
    };

    let (tx, rx) = oneshot::channel();
    state.receivers.lock().await.insert(request_id, tx);

    state.command_tx.send(command).map_err(|e| format!("Failed to send command: {}", e))?;

    match timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(response)) => serde_json::from_value(response).map_err(|e| format!("Failed to parse response: {}", e)),
        Ok(Err(_)) => Err("Receiver dropped".to_string()),
        Err(_) => {
            state.receivers.lock().await.remove(&request_id);
            Err("Command timed out".to_string())
        }
    }
}

#[derive(Debug, Deserialize)]
struct ClientMessage {
    id: usize,
    #[serde(flatten)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct GeminiLoginStatus {
    #[serde(default, rename = "signInPresent")]
    sign_in_present: Option<bool>,
}

impl GeminiLoginStatus {
    fn sign_in_present(&self) -> bool {
        self.sign_in_present.unwrap_or(true)
    }
}

#[derive(Debug, Deserialize)]
struct GeminiGenerateResult {
    #[serde(default)]
    text: String,
}

#[derive(Debug, Serialize)]
pub struct TagsResponse {
    models: Vec<ModelEntry>,
}

#[derive(Debug, Serialize)]
struct ModelEntry {
    name: String,
    model: String,
    modified_at: String,
    size: u64,
    digest: String,
    details: ModelDetails,
}

#[derive(Debug, Serialize)]
struct ModelDetails {
    format: String,
    family: String,
    families: Vec<String>,
    parameter_size: String,
    quantization_level: String,
}

#[get("/api/tags")]
pub async fn tags(state: &State<ExtensionBridge>) -> Json<TagsResponse> {
    let sign_in_present = request_gemini_sign_in_presence(state).await;
    let gemini_available = matches!(sign_in_present, Some(false));

    let mut models = Vec::new();
    if gemini_available {
        models.push(dummy_gemini_model());
    }

    Json(TagsResponse { models })
}

pub async fn request_gemini_sign_in_presence(state: &State<ExtensionBridge>) -> Option<bool> {
    if state.command_tx.receiver_count() == 0 {
        return None;
    }

    let response: GeminiLoginStatus = send_command(state, ExtensionCommandKind::CheckGeminiLogin)
        .await
        .ok()?;

    Some(response.sign_in_present())
}

pub async fn handle_client_message(state: &ExtensionBridge, raw_message: &str) {
    let Ok(message) = serde_json::from_str::<ClientMessage>(raw_message) else {
        return;
    };

    let sender = {
        let mut receivers = state.receivers.lock().await;
        receivers.remove(&message.id)
    };

    if let Some(sender) = sender {
        let _ = sender.send(message.payload);
    }
}

pub async fn request_gemini_generate(state: &State<ExtensionBridge>, prompt: String) -> Option<String> {
    if state.command_tx.receiver_count() == 0 {
        return None;
    }

    let response: GeminiGenerateResult = send_command(state, ExtensionCommandKind::GeminiGenerate { prompt })
        .await
        .ok()?;

    Some(response.text)
}

fn dummy_gemini_model() -> ModelEntry {
    ModelEntry {
        name: "gemini-proxy".to_string(),
        model: "gemini-proxy".to_string(),
        modified_at: "2026-03-13T00:00:00.000000000Z".to_string(),
        size: 1,
        digest: "3f3afba5eec3eced16458929f3700a4f2aa134e7771a32339f6efd8006f2b593".to_string(), // sha256("gemini-proxy")
        details: ModelDetails {
            format: "gguf".to_string(),
            family: "gemini".to_string(),
            families: vec!["gemini".to_string()],
            parameter_size: "20000B".to_string(),
            quantization_level: "N/A".to_string(),
        },
    }
}
