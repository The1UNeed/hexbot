//! Generated bot faces: a shape and a colour, `{shape, color}`. The clients
//! draw them (`apps/web/src/lib/face-geometry.ts`); the daemon only picks one.
//! A bot gets its face once, at random, when it is created, and keeps it
//! whatever it is called, until someone picks another or uploads a photo.
use rand::seq::SliceRandom;
use serde_json::{Value, json};

/// Every shape a face can take, in the clients' order.
pub const SHAPES: &[&str] = &[
    "round", "squircle", "square", "pill", "triangle", "hexagon", "cloud", "drop", "star", "heart",
    "flower", "clover", "ghost", "cat", "egg", "diamond", "shield", "burst", "leaf",
];
/// The colours a face is given without being asked: the clients' palette
/// without white, brown and gray, in the clients' order.
pub const COLORS: &[&str] = &[
    "crimson", "red", "coral", "orange", "peach", "amber", "yellow", "lime", "green", "pine",
    "teal", "blue", "navy", "indigo", "violet", "lilac", "magenta", "pink",
];
/// The shapes and colours a display name gave a bot before faces were stored,
/// in the order the name indexes them (`NAME_SHAPES` and `NAME_COLORS` in the
/// clients). They never grow, so a name gives the face it always did.
const NAME_SHAPES: &[&str] = &[
    "round", "squircle", "square", "pill", "triangle", "hexagon", "cloud", "drop",
];
const NAME_COLORS: &[&str] = &[
    "red", "orange", "amber", "green", "teal", "blue", "violet", "pink",
];

/// A random face, one none of `taken` has while any is left.
pub fn random(taken: &[Value]) -> Value {
    let all = SHAPES
        .iter()
        .flat_map(|shape| {
            COLORS
                .iter()
                .map(move |color| json!({"shape":shape,"color":color}))
        })
        .collect::<Vec<_>>();
    let free = all
        .iter()
        .filter(|face| !taken.contains(face))
        .collect::<Vec<_>>();
    let mut rng = rand::thread_rng();
    free.choose(&mut rng)
        .copied()
        .or_else(|| all.choose(&mut rng))
        .cloned()
        .unwrap_or_else(|| json!({"shape":SHAPES[0],"color":COLORS[0]}))
}

/// The face the clients drew from a bot's display name before faces were
/// stored (`styleForName` in `apps/web/src/lib/avatar-builder.ts`), so a bot
/// from then keeps the face it had.
pub fn for_name(name: &str) -> Value {
    let mut hash: u32 = 0;
    for unit in name.encode_utf16() {
        hash = (hash * 31 + u32::from(unit)) % 360_000;
    }
    let hue = (hash % 360) as usize;
    json!({
        "shape": NAME_SHAPES[(hue / 7) % NAME_SHAPES.len()],
        "color": NAME_COLORS[hue % NAME_COLORS.len()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_give_the_faces_the_clients_drew() {
        for (name, shape, color) in [
            ("network", "square", "violet"),
            ("HexBot", "triangle", "teal"),
            ("Ünïcode 🦉", "square", "orange"),
            ("", "round", "red"),
        ] {
            assert_eq!(for_name(name), json!({"shape":shape,"color":color}));
        }
    }

    #[test]
    fn a_random_face_avoids_the_taken_ones_while_it_can() {
        let mut taken = Vec::new();
        for _ in 0..SHAPES.len() * COLORS.len() {
            let face = random(&taken);
            assert!(!taken.contains(&face));
            taken.push(face);
        }
        assert!(taken.contains(&random(&taken)));
    }

    #[test]
    fn the_palette_matches_the_clients() {
        let geometry = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/web/src/lib/face-geometry.ts"
        ))
        .unwrap();
        let ids = geometry
            .split("id: '")
            .skip(1)
            .filter_map(|rest| rest.split('\'').next())
            .collect::<Vec<_>>();
        let colors = ids
            .iter()
            .copied()
            .filter(|id| !SHAPES.contains(id) && !["white", "brown", "gray"].contains(id))
            .collect::<Vec<_>>();
        let shapes = ids
            .iter()
            .copied()
            .filter(|id| SHAPES.contains(id))
            .collect::<Vec<_>>();
        assert_eq!(shapes, SHAPES);
        assert_eq!(colors, COLORS);
        // The lists a name indexes are the clients' too.
        let list = |name: &str| {
            let rest = geometry
                .split(&format!("{name}: readonly string[] = ["))
                .nth(1);
            rest.and_then(|rest| rest.split(']').next())
                .unwrap()
                .split(',')
                .map(|id| id.trim().trim_matches('\'').to_string())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
        };
        assert_eq!(list("NAME_SHAPES"), NAME_SHAPES);
        assert_eq!(list("NAME_COLORS"), NAME_COLORS);
    }
}
