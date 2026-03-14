use anyhow::Context;
use rocket::State;
use rocket::post;
use rocket::response::stream::TextStream;
use rocket::serde::json::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api_common::{GenerateCommandChunk, decode_image_to_file};
use crate::error::AppResult;
use crate::extension_bridge::{ExtensionBridge, ExtensionCommandKind, ExtensionFile, request_gemini_generate_with_files, send_streaming_command};

#[derive(Debug, Deserialize)]
pub struct ChatCompletionsRequest {
    pub model: String,
    pub messages: Vec<ChatCompletionsMessage>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
    #[serde(default)]
    pub tool_choice: Option<Value>,
    #[serde(default)]
    pub stream: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ChatCompletionsMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Value>,
}

#[derive(Debug, Serialize)]
struct PromptMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<usize>>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<Value>>,
    refusal: Option<Value>,
    annotations: Vec<Value>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionChoice {
    index: u32,
    message: ChatCompletionMessage,
    logprobs: Option<Value>,
    finish_reason: String,
}

#[derive(Debug, Serialize)]
struct CompletionUsageDetails {
    reasoning_tokens: u32,
    audio_tokens: u32,
    accepted_prediction_tokens: u32,
    rejected_prediction_tokens: u32,
}

#[derive(Debug, Serialize)]
struct PromptUsageDetails {
    cached_tokens: u32,
    audio_tokens: u32,
}

#[derive(Debug, Serialize)]
struct CompletionUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
    prompt_tokens_details: PromptUsageDetails,
    completion_tokens_details: CompletionUsageDetails,
}

#[derive(Debug, Serialize)]
struct ChatCompletionResponse {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<ChatCompletionChoice>,
    usage: CompletionUsage,
    service_tier: String,
}

#[derive(Debug, Serialize)]
struct ChatCompletionDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<Value>>,
}

#[derive(Clone, Copy, Debug)]
enum ToolChoiceMode {
    None,
    Auto,
    Required,
}

#[derive(Debug)]
struct ToolBehavior {
    mode: ToolChoiceMode,
    available_tools: Vec<Value>,
    forced_tool: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionStreamChoice {
    index: u32,
    delta: ChatCompletionDelta,
    logprobs: Option<Value>,
    finish_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionChunk {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<ChatCompletionStreamChoice>,
}

fn extract_text_and_images(content: Option<Value>) -> (String, Vec<String>) {
    let Some(content) = content else {
        return (String::new(), Vec::new());
    };

    match content {
        Value::String(text) => (text, Vec::new()),
        Value::Array(parts) => {
            let mut text_chunks = Vec::new();
            let mut images = Vec::new();

            for part in parts {
                let Value::Object(obj) = part else {
                    continue;
                };

                let part_type = obj
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                if part_type == "text" {
                    if let Some(text) = obj.get("text").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        text_chunks.push(text.to_string());
                    }
                    continue;
                }

                if part_type == "image_url" {
                    let maybe_url = obj
                        .get("image_url")
                        .and_then(Value::as_object)
                        .and_then(|image_obj| image_obj.get("url"))
                        .and_then(Value::as_str);

                    if let Some(url) = maybe_url {
                        images.push(url.to_string());
                    }
                }
            }

            (text_chunks.join("\n"), images)
        }
        other => (other.to_string(), Vec::new()),
    }
}

fn flatten_prompt_and_files(messages: Vec<ChatCompletionsMessage>) -> (String, Vec<ExtensionFile>) {
    let mut prompt_messages = Vec::new();
    let mut files = Vec::new();

    for message in messages {
        let ChatCompletionsMessage {
            role,
            content,
            name,
            tool_call_id,
            tool_calls,
        } = message;

        let (content, image_payloads) = extract_text_and_images(content);
        let mut image_indices = Vec::new();

        for image in image_payloads {
            let next_index = files.len();
            files.push(decode_image_to_file(image));
            image_indices.push(next_index);
        }

        prompt_messages.push(PromptMessage {
            role,
            content,
            name,
            tool_call_id,
            tool_calls,
            images: if image_indices.is_empty() {
                None
            } else {
                Some(image_indices)
            },
        });
    }

    let prompt = serde_json::to_string(&prompt_messages).unwrap_or_else(|_| "[]".to_string());
    (prompt, files)
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => 0,
    }
}

fn build_non_stream_response(id: String, created: u64, model: String, content: String) -> ChatCompletionResponse {
    ChatCompletionResponse {
        id,
        object: "chat.completion".to_string(),
        created,
        model,
        choices: vec![ChatCompletionChoice {
            index: 0,
            message: ChatCompletionMessage {
                role: "assistant".to_string(),
                content: Some(content),
                tool_calls: None,
                refusal: None,
                annotations: Vec::new(),
            },
            logprobs: None,
            finish_reason: "stop".to_string(),
        }],
        usage: CompletionUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_tokens_details: PromptUsageDetails {
                cached_tokens: 0,
                audio_tokens: 0,
            },
            completion_tokens_details: CompletionUsageDetails {
                reasoning_tokens: 0,
                audio_tokens: 0,
                accepted_prediction_tokens: 0,
                rejected_prediction_tokens: 0,
            },
        },
        service_tier: "default".to_string(),
    }
}

fn build_stream_chunk(id: String, created: u64, model: String, content: Option<String>, include_role: bool, done: bool) -> ChatCompletionChunk {
    ChatCompletionChunk {
        id,
        object: "chat.completion.chunk".to_string(),
        created,
        model,
        choices: vec![ChatCompletionStreamChoice {
            index: 0,
            delta: ChatCompletionDelta {
                role: if include_role {
                    Some("assistant".to_string())
                } else {
                    None
                },
                content,
                tool_calls: None,
            },
            logprobs: None,
            finish_reason: if done {
                Some("stop".to_string())
            } else {
                None
            },
        }],
    }
}

fn build_stream_tool_call_chunk(
    id: String,
    created: u64,
    model: String,
    tool_calls: Vec<Value>,
    include_role: bool,
    done: bool,
) -> ChatCompletionChunk {
    ChatCompletionChunk {
        id,
        object: "chat.completion.chunk".to_string(),
        created,
        model,
        choices: vec![ChatCompletionStreamChoice {
            index: 0,
            delta: ChatCompletionDelta {
                role: if include_role {
                    Some("assistant".to_string())
                } else {
                    None
                },
                content: None,
                tool_calls: Some(tool_calls),
            },
            logprobs: None,
            finish_reason: if done {
                Some("tool_calls".to_string())
            } else {
                None
            },
        }],
    }
}

fn build_non_stream_tool_response(
    id: String,
    created: u64,
    model: String,
    tool_calls: Vec<Value>,
) -> ChatCompletionResponse {
    ChatCompletionResponse {
        id,
        object: "chat.completion".to_string(),
        created,
        model,
        choices: vec![ChatCompletionChoice {
            index: 0,
            message: ChatCompletionMessage {
                role: "assistant".to_string(),
                content: None,
                tool_calls: Some(tool_calls),
                refusal: None,
                annotations: Vec::new(),
            },
            logprobs: None,
            finish_reason: "tool_calls".to_string(),
        }],
        usage: CompletionUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_tokens_details: PromptUsageDetails {
                cached_tokens: 0,
                audio_tokens: 0,
            },
            completion_tokens_details: CompletionUsageDetails {
                reasoning_tokens: 0,
                audio_tokens: 0,
                accepted_prediction_tokens: 0,
                rejected_prediction_tokens: 0,
            },
        },
        service_tier: "default".to_string(),
    }
}

fn parse_tool_choice_mode(mode: &str) -> Option<ToolChoiceMode> {
    match mode {
        "none" => Some(ToolChoiceMode::None),
        "auto" => Some(ToolChoiceMode::Auto),
        "required" => Some(ToolChoiceMode::Required),
        _ => None,
    }
}

fn as_array(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn resolve_tool_behavior(tools: Option<Vec<Value>>, tool_choice: Option<Value>) -> ToolBehavior {
    let declared_tools = tools.unwrap_or_default();
    let default_mode = if declared_tools.is_empty() {
        ToolChoiceMode::None
    } else {
        ToolChoiceMode::Auto
    };

    let mut mode = default_mode;
    let mut available_tools = declared_tools;
    let mut forced_tool = None;

    if let Some(choice) = tool_choice {
        if let Some(choice_mode) = choice.as_str().and_then(parse_tool_choice_mode) {
            mode = choice_mode;
        } else if let Some(choice_obj) = choice.as_object() {
            let choice_type = choice_obj
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();

            if choice_type == "function" || choice_obj.contains_key("function") {
                if let Some(function_obj) = choice_obj.get("function").and_then(Value::as_object)
                    && let Some(name) = function_obj.get("name").and_then(Value::as_str)
                {
                    forced_tool = Some(serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": name,
                        }
                    }));
                    mode = ToolChoiceMode::Required;
                }
            } else if choice_type == "custom" || choice_obj.contains_key("custom") {
                if let Some(custom_obj) = choice_obj.get("custom").and_then(Value::as_object)
                    && let Some(name) = custom_obj.get("name").and_then(Value::as_str)
                {
                    forced_tool = Some(serde_json::json!({
                        "type": "custom",
                        "custom": {
                            "name": name,
                        }
                    }));
                    mode = ToolChoiceMode::Required;
                }
            } else if choice_type == "allowed_tools" || choice_obj.contains_key("allowed_tools") {
                if let Some(m) = choice_obj.get("mode").and_then(Value::as_str).and_then(parse_tool_choice_mode)
                    && !matches!(m, ToolChoiceMode::None)
                {
                    mode = m;
                }

                let maybe_allowed_tools = choice_obj
                    .get("allowed_tools")
                    .and_then(Value::as_object)
                    .and_then(|allowed_obj| allowed_obj.get("tools"))
                    .map(as_array)
                    .or_else(|| choice_obj.get("tools").map(as_array));

                if let Some(allowed_tools) = maybe_allowed_tools {
                    available_tools = allowed_tools;
                }
            } else if let Some(m) = choice_obj
                .get("mode")
                .and_then(Value::as_str)
                .and_then(parse_tool_choice_mode)
            {
                mode = m;
            }
        }
    }

    ToolBehavior {
        mode,
        available_tools,
        forced_tool,
    }
}

fn format_tool_definitions(tools: &[Value]) -> String {
    let mut lines = Vec::new();

    for tool in tools {
        let Some(tool_obj) = tool.as_object() else {
            continue;
        };

        let tool_type = tool_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("function");

        if tool_type == "function" {
            let Some(function_obj) = tool_obj.get("function").and_then(Value::as_object) else {
                continue;
            };

            let Some(name) = function_obj.get("name").and_then(Value::as_str) else {
                continue;
            };

            let description = function_obj
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let parameters = function_obj
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}}));
            let strict = function_obj
                .get("strict")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            lines.push(format!(
                "- FUNCTION {name}: description={description:?}, strict={strict}, parameters={}",
                parameters
            ));
            continue;
        }

        if tool_type == "custom" {
            let Some(custom_obj) = tool_obj.get("custom").and_then(Value::as_object) else {
                continue;
            };

            let Some(name) = custom_obj.get("name").and_then(Value::as_str) else {
                continue;
            };

            let description = custom_obj
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let format = custom_obj
                .get("format")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"type": "text"}));

            lines.push(format!(
                "- CUSTOM {name}: description={description:?}, format={}",
                format
            ));
        }
    }

    if lines.is_empty() {
        "- (no valid tool definitions were provided)".to_string()
    } else {
        lines.join("\n")
    }
}

fn render_forced_tool_line(forced_tool: &Value) -> Option<String> {
    let forced_obj = forced_tool.as_object()?;
    let tool_type = forced_obj.get("type").and_then(Value::as_str).unwrap_or_default();

    if tool_type == "function" {
        let name = forced_obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)?;
        return Some(format!(
            "When calling a tool, call this exact function name only: {}.",
            name
        ));
    }

    if tool_type == "custom" {
        let name = forced_obj
            .get("custom")
            .and_then(Value::as_object)
            .and_then(|custom| custom.get("name"))
            .and_then(Value::as_str)?;
        return Some(format!(
            "When calling a tool, call this exact custom tool name only: {}.",
            name
        ));
    }

    None
}

fn build_tool_instruction_block(behavior: &ToolBehavior) -> Option<String> {
    let use_tools = !matches!(behavior.mode, ToolChoiceMode::None)
        && (!behavior.available_tools.is_empty() || behavior.forced_tool.is_some());

    if !use_tools {
        return None;
    }

    let mode_line = match behavior.mode {
        ToolChoiceMode::None => {
            "Do not call any tool. Return only normal assistant text.".to_string()
        }
        ToolChoiceMode::Auto => {
            "You may either return normal assistant text OR call one or more tools.".to_string()
        }
        ToolChoiceMode::Required => {
            "You must call one or more tools and must not return plain assistant text.".to_string()
        }
    };

    let forced_line = behavior
        .forced_tool
        .as_ref()
        .and_then(render_forced_tool_line)
        .unwrap_or_default();

    let tools_list = if let Some(forced) = &behavior.forced_tool {
        format_tool_definitions(std::slice::from_ref(forced))
    } else {
        format_tool_definitions(&behavior.available_tools)
    };

    let valid_example = r#"{"tool_calls":[{"type":"function","function":{"name":"read_file","arguments":"{\"filePath\":\"/tmp/a.txt\",\"startLine\":1,\"endLine\":10}"}}]}"#;

    Some(format!(
        "[TOOL_CALLING_INSTRUCTIONS]\n{}\n{}\nIf you call tools, respond with ONLY one valid JSON object and nothing else (no markdown fences, no prose, no links, no trailing characters).\nRequired shape:\n{{\n  \"tool_calls\": [\n    {{\n      \"type\": \"function\" | \"custom\",\n      \"function\": {{\"name\": \"...\", \"arguments\": \"...\"}},\n      \"custom\": {{\"name\": \"...\", \"input\": \"...\"}}\n    }}\n  ]\n}}\nFor function calls, \"arguments\" MUST be a JSON-encoded string (like JSON.stringify output), not a raw object. Inner quotes must be escaped.\nValid example:\n{}\nAvailable tools:\n{}\n[/TOOL_CALLING_INSTRUCTIONS]",
        mode_line,
        forced_line,
        valid_example,
        tools_list
    ))
}

fn normalize_tool_calls(raw_calls: &[Value], id_seed: &str) -> Vec<Value> {
    let mut normalized = Vec::new();

    for (index, raw_call) in raw_calls.iter().enumerate() {
        let Some(call_obj) = raw_call.as_object() else {
            continue;
        };

        let explicit_type = call_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let call_id = call_obj
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("call_{}_{}", id_seed, index));

        if explicit_type == "custom" || call_obj.contains_key("custom") {
            let Some(custom_obj) = call_obj.get("custom").and_then(Value::as_object) else {
                continue;
            };

            let Some(name) = custom_obj.get("name").and_then(Value::as_str) else {
                continue;
            };

            let input = custom_obj
                .get("input")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));

            normalized.push(serde_json::json!({
                "id": call_id,
                "type": "custom",
                "custom": {
                    "name": name,
                    "input": input,
                }
            }));
            continue;
        }

        let Some(function_obj) = call_obj.get("function").and_then(Value::as_object) else {
            continue;
        };

        let Some(name) = function_obj.get("name").and_then(Value::as_str) else {
            continue;
        };

        let arguments_string = match function_obj.get("arguments") {
            Some(Value::String(s)) => normalize_arguments_string(s),
            Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
            None => "{}".to_string(),
        };

        normalized.push(serde_json::json!({
            "id": call_id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": arguments_string,
            }
        }));
    }

    normalized
}

fn find_quote_ending_value(text: &str, mut index: usize) -> Option<usize> {
    while let Some((offset, ch)) = text[index..].char_indices().next() {
        if ch != '"' {
            index += ch.len_utf8();
            continue;
        }

        let quote_index = index + offset;
        let mut lookahead = quote_index + 1;

        while let Some(next) = text[lookahead..].chars().next() {
            if next.is_whitespace() {
                lookahead += next.len_utf8();
                continue;
            }
            break;
        }

        if text[lookahead..].starts_with('}') {
            return Some(quote_index);
        }

        if text[lookahead..].starts_with(',') {
            lookahead += 1;
            while let Some(next) = text[lookahead..].chars().next() {
                if next.is_whitespace() {
                    lookahead += next.len_utf8();
                    continue;
                }
                break;
            }
            if text[lookahead..].starts_with('"') {
                return Some(quote_index);
            }
        }

        index = quote_index + 1;
    }

    None
}

fn parse_loose_object_arguments(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
        return None;
    }

    let mut index = 1usize;
    let mut map = serde_json::Map::new();

    loop {
        while let Some(ch) = trimmed[index..].chars().next() {
            if ch.is_whitespace() || ch == ',' {
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        if index >= trimmed.len() || trimmed[index..].starts_with('}') {
            break;
        }

        if !trimmed[index..].starts_with('"') {
            return None;
        }
        index += 1;
        let key_end_rel = trimmed[index..].find('"')?;
        let key_end = index + key_end_rel;
        let key = trimmed[index..key_end].to_string();
        index = key_end + 1;

        while let Some(ch) = trimmed[index..].chars().next() {
            if ch.is_whitespace() {
                index += ch.len_utf8();
                continue;
            }
            break;
        }
        if !trimmed[index..].starts_with(':') {
            return None;
        }
        index += 1;

        while let Some(ch) = trimmed[index..].chars().next() {
            if ch.is_whitespace() {
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        let value = if trimmed[index..].starts_with('"') {
            let value_start = index + 1;
            let value_end = find_quote_ending_value(trimmed, value_start)?;
            index = value_end + 1;
            Value::String(trimmed[value_start..value_end].to_string())
        } else if trimmed[index..].starts_with('{') {
            let end = find_matching_delimiter(trimmed, index, '{', '}')?;
            let raw = &trimmed[index..=end];
            index = end + 1;
            serde_json::from_str(raw).ok().unwrap_or_else(|| Value::String(raw.to_string()))
        } else if trimmed[index..].starts_with('[') {
            let end = find_matching_delimiter(trimmed, index, '[', ']')?;
            let raw = &trimmed[index..=end];
            index = end + 1;
            serde_json::from_str(raw).ok().unwrap_or_else(|| Value::String(raw.to_string()))
        } else {
            let mut end = index;
            while let Some(ch) = trimmed[end..].chars().next() {
                if ch == ',' || ch == '}' {
                    break;
                }
                end += ch.len_utf8();
            }
            let raw = trimmed[index..end].trim();
            index = end;
            serde_json::from_str(raw).ok().unwrap_or_else(|| Value::String(raw.to_string()))
        };

        map.insert(key, value);
    }

    Some(Value::Object(map))
}

fn normalize_arguments_string(raw: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(raw)
        && let Ok(serialized) = serde_json::to_string(&value)
    {
        return serialized;
    }

    if let Some(value) = parse_loose_object_arguments(raw)
        && let Ok(serialized) = serde_json::to_string(&value)
    {
        return serialized;
    }

    raw.to_string()
}

fn extract_json_candidate_from_text(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return Some(trimmed);
    }

    let fence_start = trimmed.find("```")?;
    let after_fence = &trimmed[fence_start + 3..];
    let body_start = if let Some(newline_index) = after_fence.find('\n') {
        &after_fence[newline_index + 1..]
    } else {
        after_fence
    };
    let fence_end = body_start.find("```")?;
    Some(body_start[..fence_end].trim())
}

fn find_matching_delimiter(text: &str, start: usize, open: char, close: char) -> Option<usize> {
    let bytes = text.as_bytes();
    if *bytes.get(start)? != open as u8 {
        return None;
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == open {
            depth += 1;
            continue;
        }
        if ch == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(start + offset);
            }
        }
    }

    None
}

fn sanitize_malformed_tool_arguments_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while let Some(rel_index) = text[cursor..].find("\"arguments\"") {
        let key_index = cursor + rel_index;
        out.push_str(&text[cursor..key_index]);
        out.push_str("\"arguments\"");

        let mut index = key_index + "\"arguments\"".len();

        while let Some(ch) = text[index..].chars().next() {
            if ch.is_whitespace() {
                out.push(ch);
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        if !text[index..].starts_with(':') {
            cursor = key_index + 1;
            continue;
        }

        out.push(':');
        index += 1;

        while let Some(ch) = text[index..].chars().next() {
            if ch.is_whitespace() {
                out.push(ch);
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        if !text[index..].starts_with('"') {
            cursor = index;
            continue;
        }

        let original_quote_index = index;
        index += 1;

        while let Some(ch) = text[index..].chars().next() {
            if ch.is_whitespace() {
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        let Some(first_value_char) = text[index..].chars().next() else {
            out.push('"');
            cursor = index;
            continue;
        };

        if first_value_char != '{' && first_value_char != '[' {
            out.push_str(&text[original_quote_index..]);
            return out;
        }

        let close = if first_value_char == '{' { '}' } else { ']' };
        let Some(end_index) = find_matching_delimiter(text, index, first_value_char, close) else {
            out.push_str(&text[original_quote_index..]);
            return out;
        };

        let raw_json = &text[index..=end_index];
        let encoded = serde_json::to_string(raw_json).unwrap_or_else(|_| "\"{}\"".to_string());
        let encoded_inner = encoded
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .unwrap_or(raw_json);

        out.push('"');
        out.push_str(encoded_inner);
        out.push('"');

        let mut after = end_index + 1;
        if let Some(quote_rel) = text[after..].find('"') {
            // Drop any malformed junk between the recovered JSON block and
            // the terminating quote of the original arguments string.
            after += quote_rel + 1;
        }

        cursor = after;
    }

    out.push_str(&text[cursor..]);
    out
}

fn repair_incomplete_json(text: &str) -> String {
    let mut repaired = text.trim().to_string();

    while repaired.ends_with(',') {
        repaired.pop();
        repaired = repaired.trim_end().to_string();
    }

    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for ch in repaired.chars() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }

            if ch == '\\' {
                escaped = true;
                continue;
            }

            if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }

        if ch == '{' || ch == '[' {
            stack.push(ch);
            continue;
        }

        if ch == '}' {
            if matches!(stack.last(), Some('{')) {
                stack.pop();
            }
            continue;
        }

        if ch == ']'
            && matches!(stack.last(), Some('['))
        {
            stack.pop();
        }
    }

    if in_string {
        repaired.push('"');
    }

    while let Some(open) = stack.pop() {
        repaired.push(match open {
            '{' => '}',
            '[' => ']',
            _ => continue,
        });
    }

    repaired
}

fn parse_tool_calls_from_text(text: &str, id_seed: &str) -> Option<Vec<Value>> {
    let sanitized = sanitize_malformed_tool_arguments_json(text);
    let candidate = extract_json_candidate_from_text(&sanitized)?;
    let repaired = repair_incomplete_json(candidate);
    let parsed: Value = serde_json::from_str(&repaired).ok()?;

    let tool_calls = if let Some(tool_calls_array) = parsed
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
    {
        tool_calls_array.clone()
    } else if let Some(array) = parsed.as_array() {
        array.clone()
    } else {
        return None;
    };

    let normalized = normalize_tool_calls(&tool_calls, id_seed);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn select_effective_tools_for_prompt(behavior: &ToolBehavior) -> Vec<Value> {
    if let Some(forced_tool) = &behavior.forced_tool {
        return vec![forced_tool.clone()];
    }
    behavior.available_tools.clone()
}

#[post("/chat/completions", format = "json", data = "<payload>")]
pub async fn chat_completions(payload: Json<ChatCompletionsRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    chat_completions_impl(payload.into_inner(), state).await
}

#[post("/v1/chat/completions", format = "json", data = "<payload>")]
pub async fn chat_completions_v1(payload: Json<ChatCompletionsRequest>, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    chat_completions_impl(payload.into_inner(), state).await
}

async fn chat_completions_impl(req: ChatCompletionsRequest, state: &State<ExtensionBridge>) -> AppResult<TextStream![String]> {
    let stream_enabled = req.stream.unwrap_or(false);
    let model = req.model;
    let tool_behavior = resolve_tool_behavior(req.tools, req.tool_choice);
    let (prompt_base, files) = flatten_prompt_and_files(req.messages);
    let prompt = if let Some(instructions) = build_tool_instruction_block(&tool_behavior) {
        format!("{}\n\n{}", prompt_base, instructions)
    } else {
        prompt_base
    };

    let id = format!("chatcmpl-{}", uuid_like_suffix(unix_now(), &model));
    let created = unix_now();

    let mut stream_rx_opt = None;
    let mut stream_unsupported_model = false;
    let mut non_stream_body_opt = None;
    let tool_mode_active = !matches!(tool_behavior.mode, ToolChoiceMode::None)
        && !select_effective_tools_for_prompt(&tool_behavior).is_empty();

    if stream_enabled {
        if model.starts_with("gemini") {
            stream_rx_opt = Some(
                send_streaming_command::<serde_json::Value>(
                    state,
                    ExtensionCommandKind::GeminiGenerate { prompt, files },
                )
                .await,
            );
        } else {
            stream_unsupported_model = true;
        }
    } else {
        let response_text = if model.starts_with("gemini") {
            let text = request_gemini_generate_with_files(state, prompt, files)
                .await
                .context("gemini non-stream completion failed")?;
            if text.is_empty() {
                "Gemini returned an empty response.".to_string()
            } else {
                text
            }
        } else {
            format!("Unsupported model: {}", model)
        };

        let maybe_tool_calls = if tool_mode_active {
            parse_tool_calls_from_text(&response_text, &id)
        } else {
            None
        };

        non_stream_body_opt = Some(if let Some(tool_calls) = maybe_tool_calls {
            build_non_stream_tool_response(id.clone(), created, model.clone(), tool_calls)
        } else {
            build_non_stream_response(id.clone(), created, model.clone(), response_text)
        });
    }

    Ok(TextStream! {
        if stream_enabled {
            if stream_unsupported_model {
                let chunk = build_stream_chunk(
                    id.clone(),
                    created,
                    model.clone(),
                    Some("Unsupported model".to_string()),
                    true,
                    true,
                );

                if let Ok(line) = serde_json::to_string(&chunk) {
                    yield format!("data: {}\n\n", line);
                }
                yield "data: [DONE]\n\n".to_string();
                return;
            }

            let mut emitted_role = false;

            if let Some(mut stream_rx) = stream_rx_opt {
                if tool_mode_active {
                    let mut aggregated = String::new();
                    let mut had_error = false;

                    while let Some(item) = stream_rx.recv().await {
                        let (text, done) = match item {
                            Ok(item) => {
                                let chunk: GenerateCommandChunk = serde_json::from_value(item.value)
                                    .unwrap_or(GenerateCommandChunk {
                                        text: String::new(),
                                        error: Some("failed to decode extension response chunk".to_string()),
                                    });

                                let text = if let Some(error) = chunk.error {
                                    had_error = true;
                                    format!("Gemini stream error: {}", error)
                                } else {
                                    chunk.text
                                };
                                (text, item.done)
                            }
                            Err(error) => {
                                had_error = true;
                                (format!("Gemini stream error: {}", error), true)
                            }
                        };

                        aggregated.push_str(&text);

                        if done {
                            break;
                        }
                    }

                    if let Some(tool_calls) = (!had_error)
                        .then(|| parse_tool_calls_from_text(&aggregated, &id))
                        .flatten()
                    {
                        let chunk = build_stream_tool_call_chunk(
                            id.clone(),
                            created,
                            model.clone(),
                            tool_calls,
                            true,
                            true,
                        );

                        if let Ok(line) = serde_json::to_string(&chunk) {
                            yield format!("data: {}\n\n", line);
                        }
                    } else {
                        let role_chunk = build_stream_chunk(
                            id.clone(),
                            created,
                            model.clone(),
                            None,
                            true,
                            false,
                        );

                        if let Ok(line) = serde_json::to_string(&role_chunk) {
                            yield format!("data: {}\n\n", line);
                        }

                        let final_chunk = build_stream_chunk(
                            id.clone(),
                            created,
                            model.clone(),
                            if aggregated.is_empty() {
                                None
                            } else {
                                Some(aggregated)
                            },
                            false,
                            true,
                        );

                        if let Ok(line) = serde_json::to_string(&final_chunk) {
                            yield format!("data: {}\n\n", line);
                        }
                    }

                    yield "data: [DONE]\n\n".to_string();
                    return;
                }

                while let Some(item) = stream_rx.recv().await {
                    let (text, done) = match item {
                        Ok(item) => {
                            let chunk: GenerateCommandChunk = serde_json::from_value(item.value)
                                .unwrap_or(GenerateCommandChunk {
                                    text: String::new(),
                                    error: Some("failed to decode extension response chunk".to_string()),
                                });

                            let text = if let Some(error) = chunk.error {
                                format!("Gemini stream error: {}", error)
                            } else {
                                chunk.text
                            };
                            (text, item.done)
                        }
                        Err(error) => (format!("Gemini stream error: {}", error), true),
                    };

                    let chunk = build_stream_chunk(
                        id.clone(),
                        created,
                        model.clone(),
                        if text.is_empty() { None } else { Some(text) },
                        !emitted_role,
                        done,
                    );

                    if let Ok(line) = serde_json::to_string(&chunk) {
                        yield format!("data: {}\n\n", line);
                    }

                    emitted_role = true;

                    if done {
                        break;
                    }
                }
            }

            yield "data: [DONE]\n\n".to_string();
        } else if let Some(body) = non_stream_body_opt
            && let Ok(line) = serde_json::to_string(&body) {
            yield format!("{}\n", line);
        }
    })
}

fn uuid_like_suffix(created: u64, model: &str) -> String {
    let reduced_model = model
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>();
    format!("{}{}", created, reduced_model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_calls_when_arguments_are_malformed_unescaped_json_string() {
        let payload = r#"{"tool_calls":[{"type":"function","function":{"name":"manage_todo_list","arguments":"{"todoList":[{"id":1,"status":"in-progress","title":"Identify occurrences of 'gemini-ollama' in codebase"}]}"}},{"type":"function","function":{"name":"grep_search","arguments":"{"isRegexp":false,"query":"gemini-ollama"}"}}]}"#;

        let calls = parse_tool_calls_from_text(payload, "seed").expect("expected tool calls");
        assert_eq!(calls.len(), 2);

        let first_name = calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .expect("first tool name should be present");
        assert_eq!(first_name, "manage_todo_list");

        let first_arguments = calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
            .expect("first tool arguments should be present");
        let parsed_first_arguments: Value =
            serde_json::from_str(first_arguments).expect("first arguments should be valid JSON");
        assert_eq!(parsed_first_arguments["todoList"][0]["id"], 1);

        let second_name = calls[1]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .expect("second tool name should be present");
        assert_eq!(second_name, "grep_search");

        let second_arguments = calls[1]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
            .expect("second tool arguments should be present");
        let parsed_second_arguments: Value =
            serde_json::from_str(second_arguments).expect("second arguments should be valid JSON");
        assert_eq!(parsed_second_arguments["isRegexp"], false);
        assert_eq!(parsed_second_arguments["query"], "gemini-ollama");
    }

    #[test]
    fn parses_tool_calls_with_embedded_quotes_and_newlines_in_arguments() {
        let payload = r#"{"tool_calls":[{"type":"function","function":{"name":"replace_string_in_file","arguments":"{"filePath":"/home/mubelotix/projects/gemini-ollama/ff.sh","newString":"CRX_FILE=\"$BUILD_DIR/extension.crx\"\nPOLICY_FILE=\"$BUILD_DIR/gemini-proxy-extension-policy.json\"","oldString":"CRX_FILE=\"$BUILD_DIR/extension.crx\"\nPOLICY_FILE=\"$BUILD_DIR/gemini-proxy-extension-policy.json\""}"}},{"type":"function","function":{"name":"replace_string_in_file","arguments":"{"filePath":"/home/mubelotix/projects/gemini-ollama/extension/manifest.json","newString":"  \"name\": \"Gemini Proxy Extension\",\n  \"version\": \"1.0.0\",\n  \"description\": \"Gemini Proxy browser extension.\",","oldString":"  \"name\": \"Gemini Proxy Extension\",\n  \"version\": \"1.0.0\",\n  \"description\": \"Gemini Proxy browser extension.\","}"}}]}"#;

        let calls = parse_tool_calls_from_text(payload, "seed").expect("expected tool calls");
        assert_eq!(calls.len(), 2);

        for call in calls {
            let function = call
                .get("function")
                .and_then(Value::as_object)
                .expect("function object must be present");
            assert_eq!(
                function.get("name").and_then(Value::as_str),
                Some("replace_string_in_file")
            );

            let arguments = function
                .get("arguments")
                .and_then(Value::as_str)
                .expect("arguments must be present");
            let parsed_arguments: Value =
                serde_json::from_str(arguments).expect("arguments should be valid JSON");

            assert!(parsed_arguments.get("filePath").and_then(Value::as_str).is_some());
            assert!(parsed_arguments.get("newString").and_then(Value::as_str).is_some());
            assert!(parsed_arguments.get("oldString").and_then(Value::as_str).is_some());
        }
    }

    #[test]
    fn parses_truncated_tool_calls_payload() {
        let payload = r#"{"tool_calls":[{"type":"function","function":{"name":"read_file","arguments":"{"endLine":20,"filePath":"/home/mubelotix/projects/gemini-ollama/backend/Cargo.toml","startLine":1}"}},"#;

        let calls = parse_tool_calls_from_text(payload, "seed").expect("expected tool calls");
        assert_eq!(calls.len(), 1);

        let function = calls[0]
            .get("function")
            .and_then(Value::as_object)
            .expect("function object must be present");
        assert_eq!(function.get("name").and_then(Value::as_str), Some("read_file"));

        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .expect("arguments must be present");
        let parsed_arguments: Value =
            serde_json::from_str(arguments).expect("arguments should be valid JSON");

        assert_eq!(parsed_arguments["startLine"], 1);
        assert_eq!(parsed_arguments["endLine"], 20);
        assert_eq!(
            parsed_arguments["filePath"],
            "/home/mubelotix/projects/gemini-ollama/backend/Cargo.toml"
        );
    }

    #[test]
    fn parses_arguments_when_trailing_garbage_follows_embedded_json() {
        let payload = r#"{"tool_calls":[{"type":"function","function":{"name":"manage_todo_list","arguments":"{"todoList":[{"id":1,"status":"completed","title":"Search for 'gemini-ollama' in codebase"}]} extraction"}}]}"#;

        let calls = parse_tool_calls_from_text(payload, "seed").expect("expected tool calls");
        assert_eq!(calls.len(), 1);

        let function = calls[0]
            .get("function")
            .and_then(Value::as_object)
            .expect("function object must be present");
        assert_eq!(
            function.get("name").and_then(Value::as_str),
            Some("manage_todo_list")
        );

        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .expect("arguments must be present");
        let parsed_arguments: Value =
            serde_json::from_str(arguments).expect("arguments should be valid JSON");
        assert_eq!(parsed_arguments["todoList"][0]["id"], 1);
    }
}
