/// Resolve the coordinator build id used by the footer and the `/a/<build>/`
/// asset URLs. An explicit `ROTOR_BUILD_ID` wins (a Docker build has no
/// `.git`), then the local git commit, and `dev` only when neither exists.
///
/// Included from `build.rs` and from the coordinator test module so the
/// precedence has one source of truth.
pub fn resolve_build_id(explicit: Option<&str>, git_commit: Option<&str>) -> String {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return value.to_string();
    }
    match git_commit.map(str::trim).filter(|value| !value.is_empty()) {
        Some(commit) => commit.to_string(),
        None => "dev".to_string(),
    }
}
