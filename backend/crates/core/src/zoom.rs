//! Zoom behind a trait.
//!
//! This build has no real provider and makes no outside call. `PlaceholderZoom` invents a
//! meeting and returns a sample recording with a sample transcript embedded in this crate;
//! everything it returns is simulated and the screens must say so.

use async_trait::async_trait;
use rand::Rng;
use serde::Serialize;

use crate::ProviderError;

#[derive(Debug, Clone)]
pub struct MeetingRequest {
    pub topic: String,
    /// Start time in UTC, `YYYY-MM-DD HH:MM:SS`.
    pub starts_at: String,
    pub duration_minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Meeting {
    pub meeting_id: String,
    /// What students open.
    pub join_url: String,
    /// What the teacher opens. Never send it to a student.
    pub start_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Recording {
    /// Where the recording plays. Video files are never stored locally.
    pub play_url: String,
    pub duration_seconds: i64,
    /// Zoom's own transcript as WebVTT; `None` while Zoom is still producing it.
    pub transcript_vtt: Option<String>,
}

/// A person who was expected at a meeting: a member of the campus. The caller passes them
/// so a placeholder can build a believable list; a real provider ignores them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitee {
    pub user_id: i64,
    pub email: String,
    pub full_name: String,
}

/// Someone Zoom saw in a meeting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Participant {
    /// The name shown in Zoom.
    pub name: String,
    /// The email Zoom has for the person, if any. A guest may have none: match by name.
    pub email: Option<String>,
    /// Seconds between the start of the meeting and the moment the person joined.
    pub joined_after_seconds: i64,
    /// Seconds the person stayed connected.
    pub duration_seconds: i64,
}

#[async_trait]
pub trait ZoomProvider: Send + Sync {
    /// Short name, for example `placeholder`.
    fn name(&self) -> &'static str;
    /// True when meetings and recordings are simulated; the UI then shows the "Simulado"
    /// badge.
    fn is_placeholder(&self) -> bool;
    /// Creates a meeting that records to the cloud automatically.
    async fn create_meeting(&self, request: &MeetingRequest) -> Result<Meeting, ProviderError>;
    /// The recording of a meeting, or `None` if there is none yet.
    async fn fetch_recording(&self, meeting_id: &str) -> Result<Option<Recording>, ProviderError>;
    /// Who joined a meeting. `invitees` are the campus members who were expected; the
    /// placeholder builds its made-up list from them, a real provider ignores them. The list
    /// is raw data to review: nothing here decides anyone's attendance.
    async fn fetch_participants(
        &self,
        meeting_id: &str,
        invitees: &[Invitee],
    ) -> Result<Vec<Participant>, ProviderError>;
}

/// The sample transcript every simulated recording carries. The people in it are invented.
pub const SAMPLE_TRANSCRIPT_VTT: &str = include_str!("../samples/clase_demo.vtt");

/// Invents meetings whose links point back at the app (`APP_BASE_URL`), so a click during
/// a demo opens a page of ours instead of a dead Zoom link.
pub struct PlaceholderZoom {
    app_base_url: String,
}

impl PlaceholderZoom {
    pub fn new(app_base_url: impl Into<String>) -> Self {
        Self {
            app_base_url: app_base_url.into().trim_end_matches('/').to_string(),
        }
    }
}

#[async_trait]
impl ZoomProvider for PlaceholderZoom {
    fn name(&self) -> &'static str {
        "placeholder"
    }

    fn is_placeholder(&self) -> bool {
        true
    }

    async fn create_meeting(&self, _request: &MeetingRequest) -> Result<Meeting, ProviderError> {
        let meeting_id = rand::thread_rng()
            .gen_range(10_000_000_000_u64..100_000_000_000)
            .to_string();
        let base = &self.app_base_url;
        Ok(Meeting {
            join_url: format!("{base}/simulado/zoom/{meeting_id}"),
            start_url: format!("{base}/simulado/zoom/{meeting_id}?anfitrion=1"),
            meeting_id,
        })
    }

    async fn fetch_recording(&self, meeting_id: &str) -> Result<Option<Recording>, ProviderError> {
        Ok(Some(Recording {
            play_url: format!("{}/simulado/grabacion/{meeting_id}", self.app_base_url),
            duration_seconds: vtt_duration_seconds(SAMPLE_TRANSCRIPT_VTT),
            transcript_vtt: Some(SAMPLE_TRANSCRIPT_VTT.to_string()),
        }))
    }

    async fn fetch_participants(
        &self,
        _meeting_id: &str,
        invitees: &[Invitee],
    ) -> Result<Vec<Participant>, ProviderError> {
        Ok(simulated_participants(invitees))
    }
}

/// The name of the made-up guest every simulated meeting has, who is nobody's account.
pub const PLACEHOLDER_GUEST_NAME: &str = "Invitado externo (simulado)";

/// A made-up participant list, the same for the same invitees: every fifth invitee (the
/// fifth, tenth, ...) never joins, every fifth from the fourth joins twenty minutes late, the
/// rest join within the first minute and stay the whole class. One guest with no email joins
/// as well, so a match by name has something to leave unmatched.
fn simulated_participants(invitees: &[Invitee]) -> Vec<Participant> {
    let mut list: Vec<Participant> = invitees
        .iter()
        .enumerate()
        .filter(|(index, _)| index % 5 != 4)
        .map(|(index, invitee)| {
            let late = index % 5 == 3;
            Participant {
                name: invitee.full_name.clone(),
                email: Some(invitee.email.clone()),
                joined_after_seconds: if late { 1200 } else { (index as i64 % 3) * 20 },
                duration_seconds: if late { 4200 } else { 5400 },
            }
        })
        .collect();
    list.push(Participant {
        name: PLACEHOLDER_GUEST_NAME.to_string(),
        email: None,
        joined_after_seconds: 300,
        duration_seconds: 1800,
    });
    list
}

/// The end time of the last cue of a WebVTT text, in whole seconds (0 if there is no cue).
pub fn vtt_duration_seconds(vtt: &str) -> i64 {
    vtt.lines()
        .filter_map(|line| line.split_once("-->"))
        .filter_map(|(_, end)| parse_timestamp(end.split_whitespace().next()?))
        .max()
        .unwrap_or(0)
}

/// Parses `HH:MM:SS.mmm` or `MM:SS.mmm` into whole seconds.
fn parse_timestamp(text: &str) -> Option<i64> {
    let whole = text.split('.').next()?;
    let parts: Vec<i64> = whole
        .split(':')
        .map(|part| part.parse::<i64>().ok())
        .collect::<Option<_>>()?;
    match parts.as_slice() {
        [hours, minutes, seconds] => Some(hours * 3600 + minutes * 60 + seconds),
        [minutes, seconds] => Some(minutes * 60 + seconds),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn placeholder_meeting_links_point_at_the_app() {
        let zoom = PlaceholderZoom::new("http://localhost:3000/");
        let request = MeetingRequest {
            topic: "Clase 1".into(),
            starts_at: "2026-11-13 21:00:00".into(),
            duration_minutes: 90,
        };
        let first = zoom.create_meeting(&request).await.unwrap();
        let second = zoom.create_meeting(&request).await.unwrap();
        assert_ne!(first.meeting_id, second.meeting_id);
        assert_eq!(first.meeting_id.len(), 11);
        assert_eq!(
            first.join_url,
            format!("http://localhost:3000/simulado/zoom/{}", first.meeting_id)
        );
        assert_ne!(first.join_url, first.start_url);
    }

    #[tokio::test]
    async fn placeholder_recording_carries_the_sample_transcript() {
        let zoom = PlaceholderZoom::new("http://localhost:3000");
        let recording = zoom.fetch_recording("12345678901").await.unwrap().unwrap();
        assert_eq!(recording.duration_seconds, 180);
        let vtt = recording.transcript_vtt.unwrap();
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("-->"));
    }

    fn invitees(count: i64) -> Vec<Invitee> {
        (1..=count)
            .map(|id| Invitee {
                user_id: id,
                email: format!("alumno{id}@demo.test"),
                full_name: format!("Alumno {id}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn placeholder_participants_are_built_from_the_invitees() {
        let zoom = PlaceholderZoom::new("http://localhost:3000");
        let list = zoom
            .fetch_participants("12345678901", &invitees(6))
            .await
            .unwrap();
        // The fifth invitee never joins; the fourth is late; a guest joins too.
        let names: Vec<&str> = list.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Alumno 1",
                "Alumno 2",
                "Alumno 3",
                "Alumno 4",
                "Alumno 6",
                PLACEHOLDER_GUEST_NAME
            ]
        );
        assert_eq!(list[3].joined_after_seconds, 1200);
        assert_eq!(list[0].email.as_deref(), Some("alumno1@demo.test"));
        assert_eq!(list.last().unwrap().email, None);
        let again = zoom
            .fetch_participants("other-meeting", &invitees(6))
            .await
            .unwrap();
        assert_eq!(list, again, "the list depends only on the invitees");
    }

    #[tokio::test]
    async fn placeholder_participants_of_an_empty_campus_are_just_the_guest() {
        let zoom = PlaceholderZoom::new("http://localhost:3000");
        let list = zoom.fetch_participants("1", &[]).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, PLACEHOLDER_GUEST_NAME);
    }

    #[test]
    fn vtt_duration_handles_short_and_missing_timestamps() {
        assert_eq!(
            vtt_duration_seconds("WEBVTT\n\n00:01.000 --> 01:05.250\nhola"),
            65
        );
        assert_eq!(vtt_duration_seconds("WEBVTT\n"), 0);
    }
}
