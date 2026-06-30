use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};

const MEMORY_COST_KIB: u32 = 65536; // 64 MiB
const TIME_COST_ROUNDS: u32 = 3;
const PARALLELISM: u32 = 1;

pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::errors::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let params = Params::new(
        MEMORY_COST_KIB,
        TIME_COST_ROUNDS,
        PARALLELISM,
        None,
    )?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let hash = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, expected_hash: &str) -> bool {
    let parsed = match PasswordHash::new(expected_hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let params = match Params::new(
        MEMORY_COST_KIB,
        TIME_COST_ROUNDS,
        PARALLELISM,
        None,
    ) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    argon2
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}
