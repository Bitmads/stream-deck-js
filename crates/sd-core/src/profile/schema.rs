use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// A Profile contains all scenes for a specific device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    pub device_id: Option<String>,
    pub default_scene_id: Uuid,
    pub scenes: HashMap<Uuid, Scene>,
}

impl Profile {
    pub fn new_default() -> Self {
        let default_scene = Scene::new("Default");
        let id = default_scene.id;
        let mut scenes = HashMap::new();
        scenes.insert(id, default_scene);

        Self {
            id: Uuid::new_v4(),
            name: "Default Profile".to_string(),
            device_id: None,
            default_scene_id: id,
            scenes,
        }
    }
}

/// A Scene is a complete key layout + the triggers that activate it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub id: Uuid,
    pub name: String,
    pub keys: HashMap<u8, KeyConfig>,
    pub triggers: Vec<SceneTrigger>,
}

impl Scene {
    pub fn new(name: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.to_string(),
            keys: HashMap::new(),
            triggers: vec![],
        }
    }
}

/// What activates a scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SceneTrigger {
    /// Activate when a window matching the pattern is focused.
    #[serde(rename = "window")]
    WindowFocus {
        app_name: Option<String>,
        window_title: Option<String>,
        priority: i32,
    },
    /// Activate when a specific key is pressed (from any scene).
    #[serde(rename = "key_press")]
    KeyPress {
        key_index: u8,
        /// "push" = stack-based (back returns to previous), "switch" = replace
        mode: SceneSwitchMode,
    },
    /// Activated manually from the UI.
    #[serde(rename = "manual")]
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum SceneSwitchMode {
    #[serde(rename = "push")]
    Push,
    #[serde(rename = "switch")]
    Switch,
}

/// Configuration for a single key within a scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyConfig {
    pub action_type: String,
    pub settings: serde_json::Value,
    pub appearance: KeyAppearance,
}

/// Visual appearance of a key — stored separately from action logic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyAppearance {
    pub background_color: Option<String>,
    pub image_data_url: Option<String>,
    pub icon: Option<KeyIcon>,
    pub text: Option<KeyText>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyIcon {
    pub set_id: String,
    pub icon_name: String,
    pub svg_body: String,
    pub view_box: String,
    pub color: String,
    pub size: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyText {
    pub text: String,
    pub font_size: f32,
    pub font_weight: String,
    pub font_style: String,
    pub color: String,
    pub h_align: String,
    pub v_align: String,
    pub anchor: String,
    pub use_absolute_pos: bool,
    pub x: Option<f32>,
    pub y: Option<f32>,
}
