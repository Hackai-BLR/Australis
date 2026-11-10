fn main() {
    // `sqlx::migrate!` embeds the SQL files at compile time; rebuild when one is added or changed.
    println!("cargo:rerun-if-changed=migrations");
}
