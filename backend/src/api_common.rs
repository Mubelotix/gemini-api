use serde::Deserialize;

use crate::extension_bridge::ExtensionFile;

#[derive(Debug, Deserialize)]
pub struct GenerateCommandChunk {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn decode_image_to_file(image: String) -> ExtensionFile {
    if let Some(payload) = image.strip_prefix("data:")
        && let Some((meta, bytes)) = payload.split_once(',')
    {
        let content_type = meta
            .split(';')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("image/png")
            .to_string();

        return ExtensionFile {
            bytes: bytes.to_string(),
            content_type,
        };
    }

    ExtensionFile {
        bytes: image,
        content_type: "image/png".to_string(),
    }
}

pub fn normalize_files(images: Option<Vec<String>>) -> Vec<ExtensionFile> {
    let mut normalized = Vec::new();

    if let Some(images) = images {
        normalized.extend(images.into_iter().map(decode_image_to_file));
    }

    normalized
}
