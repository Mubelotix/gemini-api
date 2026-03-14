use anyhow::Error;
use rocket::http::Status;
use rocket::request::Request;
use rocket::response::{Responder, Response};
use rocket::serde::json::Json;
use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[macro_export]
macro_rules! app_bail {
    ($($arg:tt)*) => {
        return Err(anyhow::Error::msg(format!($($arg)*)).into())
    };
}

#[derive(Debug)]
pub struct AppError(pub Error);

impl From<Error> for AppError {
    fn from(value: Error) -> Self {
        Self(value)
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl<'r> Responder<'r, 'static> for AppError {
    fn respond_to(self, req: &'r Request<'_>) -> rocket::response::Result<'static> {
        let body = Json(ErrorBody {
            error: format!("{:#}", self.0),
        });

        Response::build_from(body.respond_to(req)?)
            .status(Status::InternalServerError)
            .ok()
    }
}
