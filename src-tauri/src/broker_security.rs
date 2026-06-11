use std::fmt::Write as _;

pub const MAX_BROKER_BODY_BYTES: usize = 1024 * 1024;

pub fn broker_token(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("failed to generate broker token: {err}"))?;
    Ok(format!("{prefix}-{}", hex_bytes(&bytes)))
}

/// Constant-time token equality so the comparison can't serve as a timing
/// oracle against the broker bearer token.
pub fn token_matches(candidate: &str, token: &str) -> bool {
    let candidate = candidate.as_bytes();
    let token = token.as_bytes();
    if candidate.len() != token.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in candidate.iter().zip(token.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_compares_exactly() {
        assert!(token_matches("abc-123", "abc-123"));
        assert!(!token_matches("abc-124", "abc-123"));
        assert!(!token_matches("abc-12", "abc-123"));
        assert!(!token_matches("", "abc-123"));
    }

    #[test]
    fn broker_tokens_use_random_bytes() {
        let first = broker_token("polypore-test").unwrap();
        let second = broker_token("polypore-test").unwrap();

        assert!(first.starts_with("polypore-test-"));
        assert_eq!(first.len(), "polypore-test-".len() + 64);
        assert_ne!(first, second);
    }
}
