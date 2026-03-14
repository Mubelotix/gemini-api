mod api_generate;
mod api_delete;
mod api_pull;
mod api_push;
mod api_embed;
mod api_copy;
mod api_version;
mod api_tags;
mod error;

use rocket::figment::providers::Serialized;
use rocket::futures::{SinkExt, StreamExt};
use rocket::tokio::sync::broadcast;

#[macro_use] extern crate rocket;

use api_generate::generate;
use api_delete::delete_model;
use api_pull::pull_model;
use api_push::push_model;
use api_embed::embed_model;
use api_copy::copy_model;
use api_version::version;
use api_tags::{handle_client_message, tags, ExtensionBridge};
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
        .merge(Serialized::default("port", 1111));

    rocket::custom(figment)
        .manage(bridge)
        .mount("/", routes![index, incoming_requests, tags, generate, delete_model, pull_model, push_model, embed_model, copy_model, version])
}
