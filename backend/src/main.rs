use rocket::figment::providers::Serialized;
use rocket::tokio::time::{interval, Duration};

#[macro_use] extern crate rocket;

#[get("/")]
fn index() -> &'static str {
    "Hello, world!"
}

#[get("/incoming-requests")]
fn incoming_requests(ws: ws::WebSocket) -> ws::Stream!['static] {
    ws::Stream! { ws =>
        let _ = &ws;
        let mut ticker = interval(Duration::from_secs(1));

        loop {
            ticker.tick().await;
            yield ws::Message::Text(r#"{"message":"hello world"}"#.to_string());
        }
    }
}

#[launch]
fn rocket() -> _ {
    let figment = rocket::Config::figment()
        .merge(Serialized::default("port", 1111));

    rocket::custom(figment).mount("/", routes![index, incoming_requests])
}
