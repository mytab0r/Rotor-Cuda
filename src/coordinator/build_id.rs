/// Resolve the coordinator build id used by the footer and the `/a/<build>/`
/// asset URLs. An explicit `ROTOR_BUILD_ID` wins (a Docker build has no
/// `.git`), then the local git commit, and `dev` only when neither exists.
///
/// Included from `build.rs` and from the coordinator test module so the
/// precedence has one source of truth.
pub fn resolve_build_id(explicit: Option<&str>, git_commit: Option<&str>) -> String {
    explicit
        .and_then(safe_build_id)
        .or_else(|| git_commit.and_then(safe_build_id))
        .unwrap_or_else(|| "dev".to_string())
}

/// The id lands in an HTML attribute and in asset URLs, so accept only the
/// characters a commit sha or a CI build number can contain. Anything else
/// falls through to the next source instead of being escaped and shipped.
fn safe_build_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 40 {
        return None;
    }
    let allowed = trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    allowed.then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::resolve_build_id;

    #[test]
    fn explicit_id_wins_over_git() {
        assert_eq!(resolve_build_id(Some("abc123"), Some("def456")), "abc123");
    }

    #[test]
    fn git_is_the_fallback_and_dev_the_last_resort() {
        assert_eq!(resolve_build_id(None, Some("def456")), "def456");
        assert_eq!(resolve_build_id(None, None), "dev");
        assert_eq!(resolve_build_id(Some("  "), Some(" ")), "dev");
    }

    #[test]
    fn an_id_that_cannot_ship_safely_falls_through() {
        assert_eq!(resolve_build_id(Some("abc\"def"), Some("def456")), "def456");
        assert_eq!(resolve_build_id(Some("<script>"), None), "dev");
        assert_eq!(resolve_build_id(Some(&"a".repeat(41)), None), "dev");
    }
}
