//! Text art: the original braille "polypore" wordmark and the mushroom who
//! keeps an eye on your agents.

/// The two-row braille wordmark from the original Polypore launcher.
pub const WORDMARK: [&str; 2] = [
    "\u{28C0}\u{2840}\u{2800}\u{2880}\u{2840}\u{2800}\u{2847}\u{2800}\u{2840}\u{2880}\u{2800}\u{28C0}\u{2840}\u{2800}\u{2880}\u{2840}\u{2800}\u{2840}\u{28C0}\u{2800}\u{2880}\u{2840}",
    "\u{2867}\u{281C}\u{2800}\u{2823}\u{281C}\u{2800}\u{2823}\u{2800}\u{28D1}\u{287A}\u{2800}\u{2867}\u{281C}\u{2800}\u{2823}\u{281C}\u{2800}\u{280F}\u{2800}\u{2800}\u{2823}\u{282D}",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mood {
    /// Nothing running: looks around, blinks now and then.
    Idle,
    /// Agents at work: happy, spores drifting up.
    Busy,
    /// Someone needs you.
    Alert,
    /// Stay-awake is on and nothing is running: dozing on watch.
    Watch,
}

/// One row of the mascot and which part it is, so it can be coloured.
pub enum Part {
    Spores,
    Cap,
    Stem,
}

pub const MASCOT_W: u16 = 15;

/// The mascot for a mood at a point in time (ms since start).
pub fn mascot(mood: Mood, tick: u64) -> Vec<(Part, String)> {
    let blink = mood == Mood::Idle && (tick / 100) % 42 == 0;
    let look = (tick / 3000) % 4;
    let eyes = match mood {
        Mood::Busy => "^ ^",
        Mood::Alert => "O O",
        Mood::Watch => "- -",
        Mood::Idle if blink => "- -",
        Mood::Idle => match look {
            1 => "•• ",
            3 => " ••",
            _ => "• •",
        },
    };
    let mouth = match mood {
        Mood::Busy => " ‿ ",
        Mood::Alert => " o ",
        Mood::Watch => " ~ ",
        Mood::Idle => " ‿ ",
    };
    let spores = spores(mood, tick);
    vec![
        (Part::Spores, spores),
        (Part::Cap, "    .-~~~-.    ".to_string()),
        (Part::Cap, "  .' o . o '.  ".to_string()),
        (Part::Cap, " (___________) ".to_string()),
        (Part::Stem, format!("    | {eyes} |    ")),
        (Part::Stem, format!("    | {mouth} |    ")),
        (Part::Stem, "    '-----'    ".to_string()),
    ]
}

fn spores(mood: Mood, tick: u64) -> String {
    let mut row: Vec<char> = vec![' '; MASCOT_W as usize];
    match mood {
        Mood::Alert => {
            if (tick / 400) % 2 == 0 {
                row[7] = '!';
            }
        }
        Mood::Watch => {
            let z = ["z  ", " z ", "  Z"][((tick / 700) % 3) as usize];
            for (i, c) in z.chars().enumerate() {
                row[10 + i] = c;
            }
        }
        Mood::Busy => {
            // three spores drifting at different speeds
            for (k, base) in [(0u64, 3usize), (1, 7), (2, 11)] {
                let phase = (tick / (180 + k * 70) + k * 3) % 6;
                if phase < 4 {
                    let x = (base + phase as usize % 2).min(MASCOT_W as usize - 1);
                    row[x] = if phase < 2 { '·' } else { '˙' };
                }
            }
        }
        Mood::Idle => {
            if (tick / 900) % 5 == 0 {
                row[9] = '·';
            }
        }
    }
    row.into_iter().collect()
}

/// A one-line sprout for small empty states.
pub const SPROUT: &str = "⌒(•‿•)⌒";
