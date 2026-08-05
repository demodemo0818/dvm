pub mod display;
pub mod fileops;
pub mod folders;
pub mod fonts;
pub mod history;
pub mod libraries;
pub mod maintenance;
pub mod playback;

/// operations_log の actor を検証する。省略時は "user"。"user"/"ai" 以外は拒否
pub fn validate_actor(actor: Option<String>) -> Result<String, String> {
    match actor.as_deref() {
        None => Ok("user".into()),
        Some("user") | Some("ai") => Ok(actor.unwrap()),
        Some(other) => Err(format!("不正な actor です: {other}")),
    }
}
pub mod series;
pub mod settings;
pub mod smart_folders;
pub mod stats;
pub mod tags;
pub mod videos;
