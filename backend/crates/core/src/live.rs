//! In-process publish/subscribe for live pages (synced presentations).
//!
//! One `tokio::sync::broadcast` channel per topic, for example `slides:42`. Messages are
//! JSON text. The database stays the source of truth: a subscriber that connects late or
//! lags behind reads the current state from the database and then follows the channel.

use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
};

use tokio::sync::broadcast;

const TOPIC_CAPACITY: usize = 64;

#[derive(Default)]
pub struct LiveHub {
    topics: Mutex<HashMap<String, broadcast::Sender<String>>>,
}

impl LiveHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Follows a topic from now on. Wrap the receiver in
    /// `tokio_stream::wrappers::BroadcastStream` to turn it into an SSE stream.
    pub fn subscribe(&self, topic: &str) -> broadcast::Receiver<String> {
        self.lock()
            .entry(topic.to_string())
            .or_insert_with(|| broadcast::channel(TOPIC_CAPACITY).0)
            .subscribe()
    }

    /// Sends a message to everyone following the topic and returns how many received it.
    pub fn publish(&self, topic: &str, message: impl Into<String>) -> usize {
        let mut topics = self.lock();
        let Some(sender) = topics.get(topic) else {
            return 0;
        };
        match sender.send(message.into()) {
            Ok(receivers) => receivers,
            Err(_) => {
                // Nobody is listening any more: forget the topic.
                topics.remove(topic);
                0
            }
        }
    }

    pub fn subscriber_count(&self, topic: &str) -> usize {
        self.lock()
            .get(topic)
            .map_or(0, |sender| sender.receiver_count())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, broadcast::Sender<String>>> {
        // A poisoned lock only means another thread panicked mid-insert; the map is still usable.
        self.topics
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribers_receive_only_their_topic() {
        let hub = LiveHub::new();
        let mut a1 = hub.subscribe("a");
        let mut a2 = hub.subscribe("a");
        let mut b = hub.subscribe("b");

        assert_eq!(hub.publish("a", "one"), 2);
        assert_eq!(a1.recv().await.unwrap(), "one");
        assert_eq!(a2.recv().await.unwrap(), "one");
        assert!(b.try_recv().is_err());
    }

    #[tokio::test]
    async fn publishing_without_subscribers_is_harmless_and_forgets_the_topic() {
        let hub = LiveHub::new();
        assert_eq!(hub.publish("nobody", "x"), 0);

        drop(hub.subscribe("gone"));
        assert_eq!(hub.subscriber_count("gone"), 0);
        assert_eq!(hub.publish("gone", "x"), 0);
        assert!(hub.lock().get("gone").is_none());

        let mut back = hub.subscribe("gone");
        assert_eq!(hub.publish("gone", "y"), 1);
        assert_eq!(back.recv().await.unwrap(), "y");
    }
}
