//! WebVTT to plain text.

/// Converts a WebVTT transcript to plain text: the header, notes, cue numbers and timestamps
/// are dropped, inline tags are removed, and only the spoken lines remain (one per line).
pub fn vtt_to_text(vtt: &str) -> String {
    let normalized = vtt.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        // Header, NOTE and STYLE blocks have no timing line and are skipped.
        let Some(timing) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        for line in &lines[timing + 1..] {
            let clean = strip_tags(line);
            let clean = clean.trim();
            if !clean.is_empty() {
                out.push_str(clean);
                out.push('\n');
            }
        }
    }
    out
}

fn strip_tags(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_tag = false;
    for c in line.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::vtt_to_text;

    #[test]
    fn drops_header_cue_numbers_and_timestamps() {
        let vtt = "WEBVTT\n\nNOTE hola\n\n1\n00:00:02.000 --> 00:00:08.500\nAna: Buenas.\n\n2\n00:00:09.000 --> 00:00:10.000\n<v Bo>Segunda</v>\nlínea\n";
        assert_eq!(vtt_to_text(vtt), "Ana: Buenas.\nSegunda\nlínea\n");
    }
}
