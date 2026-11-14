//! A stage's own account.
//!
//! Every stage gets one, named under the Ovation contract, for example
//! `lantern-guild-3fa9.v1.ovation-hq.testnet`. It is the account the DAO's role holds. It
//! files the stage's payout proposals, attaches their bonds from its own balance, casts the
//! stage's votes, gets the bonds back, and writes the stage's near.social posts.
//!
//! It has no access keys and no state. It does exactly two things, and only when the account
//! directly above it (the Ovation contract) asks:
//!
//! - `call`: make one function call, with a deposit from its own balance, and hand back the
//!   result.
//! - `send`: send NEAR from its own balance.
//!
//! So a stage's money is held apart from every other stage's: a DAO that misbehaves can only
//! ever spend its own stage's NEAR.
//!
//! Arguments are packed bytes rather than JSON, which keeps this contract a few hundred bytes:
//!
//! ```text
//! call: u32 len, receiver | u32 len, method | u128 deposit | u64 gas | arguments (the rest)
//! send: u32 len, receiver | u128 amount
//! ```
//!
//! All integers are little-endian.

#![no_std]

use core::ptr::addr_of_mut;

#[link(wasm_import_module = "env")]
extern "C" {
    fn input(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn current_account_id(register_id: u64);
    fn predecessor_account_id(register_id: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
    fn promise_create(
        account_id_len: u64,
        account_id_ptr: u64,
        function_name_len: u64,
        function_name_ptr: u64,
        arguments_len: u64,
        arguments_ptr: u64,
        amount_ptr: u64,
        gas: u64,
    ) -> u64;
    fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
    fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
    fn promise_return(promise_id: u64);
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    fail(b"ERR_AGENT")
}

const INPUT_MAX: usize = 65_536;
static mut INPUT: [u8; INPUT_MAX] = [0; INPUT_MAX];
static mut ME: [u8; 64] = [0; 64];
static mut CALLER: [u8; 64] = [0; 64];

fn fail(msg: &[u8]) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

/// Read register 0 into `buf` and return how many bytes it held.
unsafe fn take(buf: *mut u8, cap: usize) -> usize {
    let len = register_len(0);
    if len == u64::MAX {
        return 0;
    }
    if len as usize > cap {
        fail(b"ERR_AGENT_INPUT: too large");
    }
    read_register(0, buf as u64);
    len as usize
}

/// Only the account directly above this one may use it.
unsafe fn only_parent() {
    current_account_id(0);
    let me_len = take(addr_of_mut!(ME) as *mut u8, 64);
    predecessor_account_id(0);
    let caller_len = take(addr_of_mut!(CALLER) as *mut u8, 64);
    let me = core::slice::from_raw_parts(addr_of_mut!(ME) as *const u8, me_len);
    let caller = core::slice::from_raw_parts(addr_of_mut!(CALLER) as *const u8, caller_len);
    let dot = match me.iter().position(|b| *b == b'.') {
        Some(i) => i,
        None => fail(b"ERR_AGENT: not a sub-account"),
    };
    if &me[dot + 1..] != caller {
        fail(b"ERR_AGENT: only the Ovation contract above this account can use it");
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        if self.at + n > self.bytes.len() {
            fail(b"ERR_AGENT_INPUT: too short");
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        out
    }
    fn u32(&mut self) -> usize {
        let b = self.take(4);
        u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize
    }
    fn u64(&mut self) -> u64 {
        let b = self.take(8);
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        u64::from_le_bytes(a)
    }
    fn bytes(&mut self) -> &'a [u8] {
        let n = self.u32();
        self.take(n)
    }
    fn rest(&mut self) -> &'a [u8] {
        let out = &self.bytes[self.at..];
        self.at = self.bytes.len();
        out
    }
}

unsafe fn read_input() -> Reader<'static> {
    input(0);
    let len = take(addr_of_mut!(INPUT) as *mut u8, INPUT_MAX);
    Reader { bytes: core::slice::from_raw_parts(addr_of_mut!(INPUT) as *const u8, len), at: 0 }
}

/// Make one function call and return its result as this call's result.
#[no_mangle]
pub extern "C" fn call() {
    unsafe {
        only_parent();
        let mut r = read_input();
        let receiver = r.bytes();
        let method = r.bytes();
        let deposit = r.take(16);
        let gas = r.u64();
        let args = r.rest();
        let id = promise_create(
            receiver.len() as u64,
            receiver.as_ptr() as u64,
            method.len() as u64,
            method.as_ptr() as u64,
            args.len() as u64,
            args.as_ptr() as u64,
            deposit.as_ptr() as u64,
            gas,
        );
        promise_return(id);
    }
}

/// Send NEAR from this account.
#[no_mangle]
pub extern "C" fn send() {
    unsafe {
        only_parent();
        let mut r = read_input();
        let receiver = r.bytes();
        let amount = r.take(16);
        let id = promise_batch_create(receiver.len() as u64, receiver.as_ptr() as u64);
        promise_batch_action_transfer(id, amount.as_ptr() as u64);
    }
}
