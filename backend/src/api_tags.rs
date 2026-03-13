use std::sync::Arc;

use rocket::get;
use rocket::serde::json::Json;
use rocket::tokio::sync::{broadcast, oneshot, Mutex};
use rocket::tokio::time::{timeout, Duration};
use rocket::State;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct ExtensionBridge {
    pub command_tx: broadcast::Sender<ServerCommand>,
    pub pending_login_check: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    pub pending_generate: Arc<Mutex<Option<oneshot::Sender<String>>>>,
}

impl ExtensionBridge {
    pub fn new(command_tx: broadcast::Sender<ServerCommand>) -> Self {
        Self {
            command_tx,
            pending_login_check: Arc::new(Mutex::new(None)),
            pending_generate: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerCommand {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

impl ServerCommand {
    pub fn check_gemini_login() -> Self {
        Self {
            kind: "check-gemini-login".to_string(),
            prompt: None,
        }
    }

    pub fn gemini_generate(prompt: String) -> Self {
        Self {
            kind: "gemini-generate".to_string(),
            prompt: Some(prompt),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ClientMessage {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    sign_in_present: Option<bool>,
    #[serde(default, rename = "signInPresent")]
    sign_in_present_camel: Option<bool>,
    #[serde(default)]
    text: Option<String>,
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
    let sign_in_present = request_gemini_sign_in_presence(state.inner()).await;
    let gemini_available = matches!(sign_in_present, Some(false));

    let mut models = Vec::new();
    if gemini_available {
        models.push(dummy_gemini_model());
    }

    Json(TagsResponse { models })
}

async fn request_gemini_sign_in_presence(state: &ExtensionBridge) -> Option<bool> {
    if state.command_tx.receiver_count() == 0 {
        return None;
    }

    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending_login_check.lock().await;
        *pending = Some(tx);
    }

    if state
        .command_tx
        .send(ServerCommand::check_gemini_login())
        .is_err()
    {
        let mut pending = state.pending_login_check.lock().await;
        *pending = None;
        return None;
    }

    match timeout(Duration::from_secs(20), rx).await {
        Ok(Ok(sign_in_present)) => Some(sign_in_present),
        _ => {
            let mut pending = state.pending_login_check.lock().await;
            *pending = None;
            None
        }
    }
}

pub async fn handle_client_message(state: &ExtensionBridge, raw_message: &str) {
    let Ok(message) = serde_json::from_str::<ClientMessage>(raw_message) else {
        return;
    };

    match message.kind.as_str() {
        "gemini-login-status" => {
            let sign_in_present = message
                .sign_in_present
                .or(message.sign_in_present_camel)
                .unwrap_or(true);
            let sender = {
                let mut pending = state.pending_login_check.lock().await;
                pending.take()
            };
            if let Some(sender) = sender {
                let _ = sender.send(sign_in_present);
            }
        }
        "gemini-generate-response" => {
            let text = message.text.unwrap_or_default();
            let sender = {
                let mut pending = state.pending_generate.lock().await;
                pending.take()
            };
            if let Some(sender) = sender {
                let _ = sender.send(text);
            }
        }
        _ => {}
    }
}

pub async fn request_gemini_generate(state: &ExtensionBridge, prompt: String) -> Option<String> {
    if state.command_tx.receiver_count() == 0 {
        return None;
    }

    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending_generate.lock().await;
        *pending = Some(tx);
    }

    if state
        .command_tx
        .send(ServerCommand::gemini_generate(prompt))
        .is_err()
    {
        let mut pending = state.pending_generate.lock().await;
        *pending = None;
        return None;
    }

    match timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(text)) => Some(text),
        _ => {
            let mut pending = state.pending_generate.lock().await;
            *pending = None;
            None
        }
    }
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
