use super::schema::{Profile, Scene};
use crate::Result;
use std::collections::HashMap;
use uuid::Uuid;

pub struct ProfileStore {
    profiles: HashMap<Uuid, Profile>,
    active_profile_id: Option<Uuid>,
    /// Stack of active scene IDs per profile (for push/pop navigation).
    scene_stacks: HashMap<Uuid, Vec<Uuid>>,
}

impl ProfileStore {
    pub fn new() -> Self {
        let default = Profile::new_default();
        let pid = default.id;
        let default_scene = default.default_scene_id;
        let mut profiles = HashMap::new();
        profiles.insert(pid, default);

        let mut scene_stacks = HashMap::new();
        scene_stacks.insert(pid, vec![default_scene]);

        Self {
            profiles,
            active_profile_id: Some(pid),
            scene_stacks,
        }
    }

    pub fn get_active(&self) -> Option<&Profile> {
        self.active_profile_id.and_then(|id| self.profiles.get(&id))
    }

    pub fn get(&self, id: &Uuid) -> Option<&Profile> {
        self.profiles.get(id)
    }

    pub fn list(&self) -> Vec<&Profile> {
        self.profiles.values().collect()
    }

    pub fn save(&mut self, profile: Profile) -> Result<()> {
        self.profiles.insert(profile.id, profile);
        Ok(())
    }

    pub fn delete(&mut self, id: &Uuid) -> Result<()> {
        self.profiles.remove(id);
        self.scene_stacks.remove(id);
        if self.active_profile_id == Some(*id) {
            self.active_profile_id = self.profiles.keys().next().copied();
        }
        Ok(())
    }

    pub fn set_active(&mut self, id: Uuid) -> Result<()> {
        if !self.profiles.contains_key(&id) {
            return Err(crate::Error::Profile(format!("Profile {} not found", id)));
        }
        self.active_profile_id = Some(id);
        Ok(())
    }

    // --- Scene navigation ---

    pub fn active_scene(&self) -> Option<&Scene> {
        let pid = self.active_profile_id?;
        let profile = self.profiles.get(&pid)?;
        let stack = self.scene_stacks.get(&pid)?;
        let scene_id = stack.last()?;
        profile.scenes.get(scene_id)
    }

    pub fn active_scene_id(&self) -> Option<Uuid> {
        let pid = self.active_profile_id?;
        self.scene_stacks.get(&pid)?.last().copied()
    }

    /// Push a scene onto the stack (for "push" mode navigation).
    pub fn push_scene(&mut self, scene_id: Uuid) -> Result<()> {
        let pid = self.active_profile_id
            .ok_or_else(|| crate::Error::Profile("No active profile".into()))?;
        let profile = self.profiles.get(&pid)
            .ok_or_else(|| crate::Error::Profile("Profile not found".into()))?;
        if !profile.scenes.contains_key(&scene_id) {
            return Err(crate::Error::Profile(format!("Scene {} not found", scene_id)));
        }
        self.scene_stacks.entry(pid).or_default().push(scene_id);
        Ok(())
    }

    /// Pop the scene stack (go back). Returns the new active scene ID.
    pub fn pop_scene(&mut self) -> Result<Option<Uuid>> {
        let pid = self.active_profile_id
            .ok_or_else(|| crate::Error::Profile("No active profile".into()))?;
        let stack = self.scene_stacks.entry(pid).or_default();
        if stack.len() > 1 {
            stack.pop();
        }
        Ok(stack.last().copied())
    }

    /// Switch to a scene (replace stack with single scene).
    pub fn switch_scene(&mut self, scene_id: Uuid) -> Result<()> {
        let pid = self.active_profile_id
            .ok_or_else(|| crate::Error::Profile("No active profile".into()))?;
        let profile = self.profiles.get(&pid)
            .ok_or_else(|| crate::Error::Profile("Profile not found".into()))?;
        if !profile.scenes.contains_key(&scene_id) {
            return Err(crate::Error::Profile(format!("Scene {} not found", scene_id)));
        }
        self.scene_stacks.insert(pid, vec![scene_id]);
        Ok(())
    }
}
