use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result as AnyResult, anyhow, bail};
use rocket::tokio::spawn;
use rocket::tokio::sync::mpsc::{Sender, UnboundedReceiver, channel, unbounded_channel};
use rocket::tokio::sync::{Mutex, broadcast};
use rocket::tokio::time::{timeout, Duration};
use rocket::State;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const COMMAND_TIMEOUT_SECS: u64 = 300;
const STREAMING_IDLE_TIMEOUT_SECS: u64 = 300;

#[derive(Debug)]
pub(crate) struct BridgeMessage {
    done: bool,
    payload: Value,
}

#[derive(Clone)]
pub struct ExtensionBridge {
    pub command_tx: broadcast::Sender<ExtensionCommand>,
    pub receivers: Arc<Mutex<HashMap<usize, Sender<BridgeMessage>>>>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionFile {
    pub bytes: String,
    #[serde(rename = "contentType", alias = "content_type")]
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ExtensionCommandKind {
    CheckGeminiLogin,
    GeminiGenerate {
        prompt: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<ExtensionFile>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtensionCommand {
    pub id: usize,
    #[serde(flatten)]
    pub kind: ExtensionCommandKind,
}

#[derive(Debug)]
pub struct StreamingCommandItem<R> {
    pub value: R,
    pub done: bool,
}

fn ensure_extension_connected(state: &State<ExtensionBridge>) -> AnyResult<()> {
    if state.command_tx.receiver_count() == 0 {
        bail!("no extension websocket connected");
    }

    Ok(())
}

pub async fn send_command<R: DeserializeOwned>(state: &State<ExtensionBridge>, kind: ExtensionCommandKind) -> AnyResult<R> {
    let request_id = state.counter.fetch_add(1, Ordering::SeqCst);

    let command = ExtensionCommand {
        id: request_id,
        kind,
    };

    let (tx, mut rx) = channel(1);
    state.receivers.lock().await.insert(request_id, tx);

    state
        .command_tx
        .send(command)
        .context("failed to send command to extension")?;

    match timeout(Duration::from_secs(COMMAND_TIMEOUT_SECS), rx.recv()).await {
        Ok(Some(response)) => serde_json::from_value(response.payload)
            .context("failed to parse command response"),
        Ok(None) => Err(anyhow!("response channel closed before receiving a value")),
        Err(_) => {
            state.receivers.lock().await.remove(&request_id);
            Err(anyhow!(
                "command timed out after {}s",
                COMMAND_TIMEOUT_SECS
            ))
        }
    }
}

pub async fn send_streaming_command<R: DeserializeOwned + Send + 'static>(state: &State<ExtensionBridge>, kind: ExtensionCommandKind) -> UnboundedReceiver<AnyResult<StreamingCommandItem<R>>> {
    let request_id = state.counter.fetch_add(1, Ordering::SeqCst);

    let command = ExtensionCommand {
        id: request_id,
        kind,
    };

    let (tx, mut rx) = channel(10);
    state.receivers.lock().await.insert(request_id, tx);

    let (response_tx, response_rx) = unbounded_channel();
    let receivers = state.receivers.clone();

    match state.command_tx.send(command) {
        Ok(_) => {}
        Err(e) => {
            let _ = response_tx.send(Err(anyhow!(e)).context("failed to send streaming command to extension"));
            state.receivers.lock().await.remove(&request_id);
            return response_rx;
        }
    }

    spawn(async move {
        loop {
            match timeout(Duration::from_secs(STREAMING_IDLE_TIMEOUT_SECS), rx.recv()).await {
                Ok(Some(response)) => match serde_json::from_value(response.payload) {
                    Ok(parsed) => {
                        let done = response.done;
                        if response_tx
                            .send(Ok(StreamingCommandItem {
                                value: parsed,
                                done,
                            }))
                            .is_err()
                        {
                            break;
                        }
                        if done {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = response_tx.send(Err(anyhow!(e)).context("failed to parse streaming response"));
                        break;
                    }
                },
                Ok(None) => {
                    let _ = response_tx.send(Err(anyhow!("stream receiver dropped")));
                    break;
                }
                Err(_) => {
                    let _ = response_tx.send(Err(anyhow!(
                        "streaming command timed out after {}s",
                        STREAMING_IDLE_TIMEOUT_SECS
                    )));
                    break;
                }
            }
        }

        receivers.lock().await.remove(&request_id);
    });

    response_rx
}

#[derive(Debug, Deserialize)]
struct ClientMessage {
    id: usize,
    #[serde(default)]
    done: bool,
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
    #[serde(default)]
    error: Option<String>,
}

impl GeminiGenerateResult {
    fn into_text_result(self) -> AnyResult<String> {
        if let Some(error) = self.error {
            bail!(error);
        }

        Ok(self.text)
    }
}

pub async fn request_gemini_sign_in_presence(state: &State<ExtensionBridge>) -> AnyResult<bool> {
    ensure_extension_connected(state)?;

    let response: GeminiLoginStatus = send_command(state, ExtensionCommandKind::CheckGeminiLogin)
        .await
        .context("gemini login check failed")?;

    Ok(response.sign_in_present())
}

pub async fn handle_client_message(state: &ExtensionBridge, raw_message: &str) {
    let Ok(message) = serde_json::from_str::<ClientMessage>(raw_message) else {
        return;
    };
    
    let sender = {
        let mut receivers = state.receivers.lock().await;
        if message.done {
            receivers.remove(&message.id)
        } else {
            receivers.get(&message.id).cloned()
        }
    };

    if let Some(sender) = sender {
        let _ = sender
            .send(BridgeMessage {
                done: message.done,
                payload: message.payload,
            })
            .await;
    }
}

pub async fn request_gemini_generate_with_files(
    state: &State<ExtensionBridge>,
    prompt: String,
    files: Vec<ExtensionFile>,
) -> AnyResult<String> {
    ensure_extension_connected(state)?;

    let mut rx = send_streaming_command::<GeminiGenerateResult>(
        state,
        ExtensionCommandKind::GeminiGenerate { prompt, files },
    )
    .await;

    let mut output = String::new();

    while let Some(item) = rx.recv().await {
        match item {
            Ok(item) => {
                output.push_str(
                    &item
                        .value
                        .into_text_result()
                        .context("gemini extension reported an error")?,
                );
                if item.done {
                    break;
                }
            }
            Err(e) => return Err(e).context("gemini generate streaming failed"),
        }
    }

    Ok(output)
}
