mod ollama;
mod openai;
mod api_common;
mod extension_bridge;
mod error;

use rocket::figment::providers::Serialized;
use rocket::data::{Limits, ToByteUnit};
use rocket::futures::{SinkExt, StreamExt};
use rocket::tokio::sync::broadcast;

#[macro_use] extern crate rocket;

use ollama::api_generate::generate;
use ollama::api_chat::chat;
use ollama::api_delete::delete_model;
use ollama::api_pull::pull_model;
use ollama::api_push::push_model;
use ollama::api_embed::embed_model;
use ollama::api_copy::copy_model;
use ollama::api_models::{running_models, show_model, tags};
use ollama::api_version::version;
use openai::api_chat_completions::{chat_completions, chat_completions_v1};
use extension_bridge::{handle_client_message, ExtensionBridge};
#[get("/")]
fn index() -> &'static str {
    "Hello, world!"
}

#[get("/incoming-requests")]
fn incoming_requests(ws: ws::WebSocket, bridge: &rocket::State<ExtensionBridge>) -> ws::Channel<'static> {
    let bridge = bridge.inner().clone();

    ws.channel(move |mut stream| {
        Box::pin(async move {
            let mut command_rx = bridge.command_tx.subscribe();

            loop {
                rocket::tokio::select! {
                    incoming = stream.next() => {
                        match incoming {
                            Some(Ok(ws::Message::Text(text))) => {
                                handle_client_message(&bridge, &text).await;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(_)) => break,
                            None => break,
                        }
                    }
                    outgoing = command_rx.recv() => {
                        match outgoing {
                            Ok(command) => {
                                if let Ok(serialized) = serde_json::to_string(&command)
                                    && stream.send(ws::Message::Text(serialized)).await.is_err() {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }

            Ok(())
        })
    })
}

#[launch]
fn rocket() -> _ {
    let (command_tx, _) = broadcast::channel(32);
    let bridge = ExtensionBridge::new(command_tx);

    let figment = rocket::Config::figment()
        .merge(Serialized::default("address", "0.0.0.0"))
        .merge(Serialized::default("port", 1111))
        .merge(Serialized::default(
            "limits",
            Limits::new().limit("json", 64.mebibytes()),
        ));

    rocket::custom(figment)
        .manage(bridge)
        .mount("/", routes![index, incoming_requests, tags, running_models, show_model, generate, chat, delete_model, pull_model, push_model, embed_model, copy_model, version, chat_completions, chat_completions_v1])
}
