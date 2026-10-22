use serde::{Deserialize, Serialize};

/// Elgato-compatible plugin manifest (manifest.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PluginManifest {
    pub name: String,
    pub description: Option<String>,
    pub version: String,
    pub author: Option<String>,
    #[serde(rename = "UUID")]
    pub uuid: String,
    pub icon: Option<String>,
    pub code_path: Option<String>,
    #[serde(rename = "SDKVersion")]
    pub sdk_version: Option<u32>,
    pub actions: Vec<PluginAction>,
    #[serde(rename = "OS")]
    pub os: Option<Vec<OsRequirement>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PluginAction {
    #[serde(rename = "UUID")]
    pub uuid: String,
    pub name: String,
    pub icon: Option<String>,
    pub tooltip: Option<String>,
    pub property_inspector_path: Option<String>,
    pub states: Option<Vec<ActionState>>,
    pub supported_in_multi_actions: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ActionState {
    pub image: Option<String>,
    pub title_alignment: Option<String>,
    pub font_size: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct OsRequirement {
    pub platform: String,
    pub minimum_version: Option<String>,
}
