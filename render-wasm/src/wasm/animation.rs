//! Penforge (W31): playback mode for layer animations.
//!
//! The animation driver in the frontend pushes temporary per-shape
//! overrides (modifiers, opacity, fills, ...) every frame. It needs every
//! visible tile finished in the same frame, like an interactive transform,
//! but with full quality: shadows and background blur stay on.

use crate::globals::get_render_state;
use crate::render::options::RenderOptions;

/// Options for animation playback: interactive transform on (complete the
/// visible tiles in one frame) and fast mode off (keep every effect).
pub fn apply_animation_mode(options: &mut RenderOptions, enabled: bool) {
    options.set_interactive_transform(enabled);
    options.set_fast_mode(false);
}

#[no_mangle]
pub extern "C" fn set_animation_mode(enabled: bool) {
    let render_state = get_render_state();
    render_state.moving_extrects.clear();
    apply_animation_mode(&mut render_state.options, enabled);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn animation_mode_keeps_effects_while_playing() {
        let mut options = RenderOptions::default();
        options.set_fast_mode(true);

        apply_animation_mode(&mut options, true);
        assert!(options.is_interactive_transform());
        assert!(!options.is_fast_mode());

        apply_animation_mode(&mut options, false);
        assert!(!options.is_interactive_transform());
        assert!(!options.is_fast_mode());
    }
}
