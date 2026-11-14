//! Ovation's rules.
//!
//! Everything that decides who may applaud, how applause becomes a score, how a score becomes
//! an amount, who has to sign that amount off, and what the contract writes in public lives
//! here as pure functions. There is no NEAR runtime in this crate, so `cargo test` runs every
//! rule on any machine in a few seconds. The contract in `../src/lib.rs` only gathers facts
//! from storage, asks these functions, and stores or sends what they answer.

pub mod claims;
pub mod config;
pub mod gates;
pub mod math;
pub mod policy;
pub mod rounds;
pub mod text;
