//! One queue the event loop sleeps on: keyboard/mouse input from a reader
//! thread, plus a nudge whenever a terminal has new output. Without the
//! nudge, an echoed keystroke waits out the idle poll before it is drawn.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::OnceLock;

use ratatui::crossterm::event::Event;

pub enum Wake {
    Input(Event),
    Output,
    /// The input reader stopped (the terminal went away).
    Lost(String),
}

static TX: OnceLock<Sender<Wake>> = OnceLock::new();
static PENDING: AtomicBool = AtomicBool::new(false);

pub fn install(tx: Sender<Wake>) {
    let _ = TX.set(tx);
}

/// Called by pane readers after queuing output. Sends at most one nudge
/// until the loop calls `clear`, so a chatty pane can't flood the queue.
pub fn poke() {
    if !PENDING.swap(true, Ordering::AcqRel) {
        if let Some(tx) = TX.get() {
            let _ = tx.send(Wake::Output);
        }
    }
}

/// The loop calls this right before draining pane output.
pub fn clear() {
    PENDING.store(false, Ordering::Release);
}
