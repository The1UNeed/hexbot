/// Signed artifact paths are plain relative paths, without URL syntax or escapes.
/// Check before joining: URL parsers otherwise normalize away traversal segments.
pub(crate) fn valid(path: &str) -> bool {
    path.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}
