use rocket::figment::providers::Serialized;

#[macro_use] extern crate rocket;

#[get("/")]
fn index() -> &'static str {
    "Hello, world!"
}

#[launch]
fn rocket() -> _ {
    let figment = rocket::Config::figment()
        .merge(Serialized::default("port", 1111));

    rocket::custom(figment).mount("/", routes![index])
}
