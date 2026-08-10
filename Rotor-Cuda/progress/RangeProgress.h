#ifndef ROTOR_RANGE_PROGRESS_H
#define ROTOR_RANGE_PROGRESS_H

#include <cstdint>
#include <string>
#include <vector>
#include <optional>
#include <chrono>

namespace rotor_progress {

// Target identity + algorithm/backend + table manifest
struct JobIdentity {
    std::string target_pubkey_hash; // SHA256 compressed pubkey
    std::string algorithm; // "bsgs", "kangaroo", etc.
    std::string backend; // "cpu", "gpu", etc.
    uint32_t table_format_version = 1;
    std::string table_checksum; // FNV-1a/64 over baby-step folds
    bool compatible(const JobIdentity& o) const {
        return target_pubkey_hash == o.target_pubkey_hash &&
               algorithm == o.algorithm &&
               backend == o.backend &&
               table_format_version == o.table_format_version &&
               table_checksum == o.table_checksum;
    }
};

// Half-open interval [start, end) in scalar space
struct Interval {
    uint64_t start = 0; // inclusive
    uint64_t end = 0;   // exclusive, end > start
    bool valid() const { return end > start; }
    uint64_t length() const { return end - start; }
};

// Event type for append-only journal (JSONL)
enum class EventType {
    CLAIM = 1,
    COMPLETE = 2,
    ABORT = 3
};

// One journal line (JSONL)
struct JournalEntry {
    EventType type;
    JobIdentity job;
    Interval interval;
    uint64_t timestamp_ms;
    uint64_t nonce;
    std::string seed;
    std::string cmd_params;
    // Optional for COMPLETE/ABORT:
    std::optional<uint64_t> keys_found;
};

// Progress metrics
struct Progress {
    uint64_t covered = 0; // sum completed interval lengths
    uint64_t uncovered = 0; // sum uncovered interval lengths
    uint64_t unknown_after_crash = 0; // sum intervals CLAIM but no COMPLETE/ABORT
    uint64_t total_range = 0; // end - start full search space
    double pct_covered = 0.0; // covered / total_range
    double pct_unknown = 0.0; // unknown / total_range
    uint64_t last_checkpoint_ts = 0; // journal generation / durable timestamp
};

// Range progress tracker (single worker, append-only JSONL + atomic snapshot)
class RangeTracker {
public:
    // Open/create tracker for job. If journal exists, replays to reconstruct state.
    // Returns false on schema mismatch corruption.
    bool open(const std::string& journal_path, const JobIdentity& job);

    // Set the full search range [start, end). Must be called before first claim
    // if no journal exists yet. Ignored if journal replay provides range.
    void set_full_range(uint64_t start, uint64_t end);

    // Close flush snapshot.
    void close();

    // Claim random uncovered interval for work.
    // Returns empty optional if exhausted or no room.
    // `max_len` caps interval length (0 = no cap).
    // `seed` + `nonce` must be deterministically chosen by caller.
    std::optional<Interval> claim(uint64_t max_len, const std::string& seed, uint64_t nonce);

    // Mark claimed interval complete (or aborted).
    // Must match exactly claimed interval.
    bool complete(const Interval& interval, bool aborted, uint64_t keys_found = 0);

    // Get current progress metrics.
    Progress progress() const;

    // Full uncovered intervals (sorted, disjoint) for external inspection.
    std::vector<Interval> uncovered() const;

    // Last error message (if any).
    std::string last_error() const { return error_; }

private:
    std::string journal_path_;
    JobIdentity job_;
    Interval full_range_; // full search space [start, end)
    bool full_range_set_ = false;
    std::vector<Interval> uncovered_;
    std::vector<Interval> claimed_;     // CLAIM without COMPLETE/ABORT
    std::vector<Interval> completed_;   // COMPLETE
    std::vector<Interval> aborted_;     // ABORT
    uint64_t journal_generation_ = 0;
    std::string error_;

    void rebuild_uncovered();
    bool append_entry(const JournalEntry& e);
    // Write atomic snapshot (tmp + rename).
    void write_snapshot();
};

} // namespace rotor_progress

#endif // ROTOR_RANGE_PROGRESS_H