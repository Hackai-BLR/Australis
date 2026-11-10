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

    #[test]
    fn vtt_duration_handles_short_and_missing_timestamps() {
        assert_eq!(
            vtt_duration_seconds("WEBVTT\n\n00:01.000 --> 01:05.250\nhola"),
            65
        );
        assert_eq!(vtt_duration_seconds("WEBVTT\n"), 0);
    }
}
