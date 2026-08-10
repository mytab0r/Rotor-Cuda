#include "RangeProgress.h"
#include <fstream>
#include <sstream>
#include <algorithm>
#include <chrono>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

namespace rotor_progress {

static uint64_t fnv1a64(const uint8_t* data, size_t len) {
    uint64_t h = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < len; ++i) {
        h ^= data[i];
        h *= 0x100000001b3ULL;
    }
    return h;
}

static uint64_t now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static std::string event_type_str(EventType t) {
    switch (t) {
        case EventType::CLAIM: return "CLAIM";
        case EventType::COMPLETE: return "COMPLETE";
        case EventType::ABORT: return "ABORT";
    }
    return "UNKNOWN";
}

static EventType str_event_type(const std::string& s) {
    if (s == "CLAIM") return EventType::CLAIM;
    if (s == "COMPLETE") return EventType::COMPLETE;
    if (s == "ABORT") return EventType::ABORT;
    return EventType::CLAIM; // default; caller validates against type string
}

static std::string to_json(const JobIdentity& j) {
    std::ostringstream o;
    o << R"({"target_pubkey_hash":")" << j.target_pubkey_hash
      << R"(","algorithm":")" << j.algorithm
      << R"(","backend":")" << j.backend
      << R"(","table_format_version":)" << j.table_format_version
      << R"(,"table_checksum":")" << j.table_checksum << R"("})";
    return o.str();
}

static std::string to_json(const Interval& i) {
    std::ostringstream o;
    o << R"({"start":)" << i.start << R"(,"end":)" << i.end << '}';
    return o.str();
}

static std::string to_json(const JournalEntry& e) {
    std::ostringstream o;
    o << R"({"type":")" << event_type_str(e.type) << R"(","job":)" << to_json(e.job)
      << R"(,"interval":)" << to_json(e.interval)
      << R"(,"timestamp_ms":)" << e.timestamp_ms
      << R"(,"nonce":)" << e.nonce
      << R"(,"seed":")" << e.seed << R"(","cmd_params":")" << e.cmd_params << R"(")";
    if (e.keys_found) o << R"(,"keys_found":)" << *e.keys_found;
    o << '}';
    return o.str();
}

static bool extract_string(const std::string& s, const std::string& key, std::string& out) {
    std::string k = '"' + key + "\":\"";
    size_t p = s.find(k);
    if (p == std::string::npos) return false;
    p += k.size();
    size_t q = s.find('"', p);
    if (q == std::string::npos) return false;
    out = s.substr(p, q - p);
    return true;
}

static bool extract_uint64(const std::string& s, const std::string& key, uint64_t& out) {
    std::string k = '"' + key + "\":";
    size_t p = s.find(k);
    if (p == std::string::npos) return false;
    p += k.size();
    uint64_t v = 0;
    while (p < s.size() && s[p] >= '0' && s[p] <= '9') {
        v = v * 10 + static_cast<uint64_t>(s[p] - '0');
        ++p;
    }
    out = v;
    return true;
}

static bool extract_uint32(const std::string& s, const std::string& key, uint32_t& out) {
    std::string k = '"' + key + "\":";
    size_t p = s.find(k);
    if (p == std::string::npos) return false;
    p += k.size();
    uint32_t v = 0;
    while (p < s.size() && s[p] >= '0' && s[p] <= '9') {
        v = v * 10 + static_cast<uint32_t>(s[p] - '0');
        ++p;
    }
    out = v;
    return true;
}

static bool parse_json_job(const std::string& s, JobIdentity& out) {
    if (!extract_string(s, "target_pubkey_hash", out.target_pubkey_hash)) return false;
    if (!extract_string(s, "algorithm", out.algorithm)) return false;
    if (!extract_string(s, "backend", out.backend)) return false;
    if (!extract_uint32(s, "table_format_version", out.table_format_version)) return false;
    if (!extract_string(s, "table_checksum", out.table_checksum)) return false;
    return true;
}

static bool parse_json_interval(const std::string& s, Interval& out) {
    if (!extract_uint64(s, "start", out.start)) return false;
    if (!extract_uint64(s, "end", out.end)) return false;
    return out.valid();
}

static bool extract_nested_object(const std::string& line, const std::string& key, std::string& out) {
    std::string k = '"' + key + "\":{";
    size_t p = line.find(k);
    if (p == std::string::npos) return false;
    p += k.size();
    size_t end = p;
    int depth = 1;
    while (end < line.size() && depth > 0) {
        if (line[end] == '{') depth++;
        else if (line[end] == '}') depth--;
        end++;
    }
    if (depth != 0) return false;
    out = line.substr(p, end - p - 1);
    return true;
}

static bool parse_journal_line(const std::string& line, JournalEntry& out) {
    std::string type_str;
    if (!extract_string(line, "type", type_str)) return false;
    out.type = str_event_type(type_str);
    if (event_type_str(out.type) != type_str) return false;

    std::string job_obj, interval_obj;
    if (!extract_nested_object(line, "job", job_obj)) return false;
    if (!parse_json_job(job_obj, out.job)) return false;
    if (!extract_nested_object(line, "interval", interval_obj)) return false;
    if (!parse_json_interval(interval_obj, out.interval)) return false;

    if (!extract_uint64(line, "timestamp_ms", out.timestamp_ms)) return false;
    if (!extract_uint64(line, "nonce", out.nonce)) return false;
    if (!extract_string(line, "seed", out.seed)) return false;
    if (!extract_string(line, "cmd_params", out.cmd_params)) return false;

    uint64_t kf = 0;
    if (extract_uint64(line, "keys_found", kf)) out.keys_found = kf;
    return true;
}

static void merge_intervals(std::vector<Interval>& v) {
    if (v.empty()) return;
    std::sort(v.begin(), v.end(), [](const Interval& a, const Interval& b) {
        return a.start < b.start;
    });
    size_t w = 0;
    for (size_t i = 1; i < v.size(); ++i) {
        if (v[i].start <= v[w].end) {
            if (v[i].end > v[w].end) v[w].end = v[i].end;
        } else {
            v[++w] = v[i];
        }
    }
    v.resize(w + 1);
}

static void subtract_intervals(
    const std::vector<Interval>& base,
    const std::vector<Interval>& sub,
    std::vector<Interval>& out) {
    out.clear();
    if (base.empty()) return;
    if (sub.empty()) { out = base; return; }
    size_t i = 0, j = 0;
    while (i < base.size()) {
        Interval cur = base[i];
        while (j < sub.size() && sub[j].end <= cur.start) ++j;
        while (j < sub.size() && sub[j].start < cur.end) {
            if (sub[j].start > cur.start) {
                out.push_back({cur.start, std::min(sub[j].start, cur.end)});
            }
            cur.start = std::max(cur.start, sub[j].end);
            if (cur.start >= cur.end) break;
            ++j;
        }
        if (cur.start < cur.end) out.push_back(cur);
        ++i;
    }
}

bool RangeTracker::open(const std::string& journal_path, const JobIdentity& job) {
    journal_path_ = journal_path;
    job_ = job;
    uncovered_.clear();
    claimed_.clear();
    completed_.clear();
    aborted_.clear();
    journal_generation_ = 0;
    error_.clear();

    struct stat st;
    if (stat(journal_path_.c_str(), &st) != 0) {
        if (full_range_set_) rebuild_uncovered();
        return true;
    }

    std::ifstream in(journal_path_);
    if (!in) { error_ = "cannot open journal for replay"; return false; }
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty()) continue;
        JournalEntry e;
        if (!parse_journal_line(line, e)) {
            error_ = "malformed journal line";
            return false;
        }
        if (!e.job.compatible(job_)) {
            error_ = "journal job identity mismatch";
            return false;
        }
        if (e.type == EventType::CLAIM) claimed_.push_back(e.interval);
        else if (e.type == EventType::COMPLETE) completed_.push_back(e.interval);
        else if (e.type == EventType::ABORT) aborted_.push_back(e.interval);
        journal_generation_ = e.timestamp_ms;
    }
    rebuild_uncovered();
    return true;
}

void RangeTracker::close() {
    write_snapshot();
}

void RangeTracker::set_full_range(uint64_t start, uint64_t end) {
    full_range_ = {start, end};
    full_range_set_ = true;
    rebuild_uncovered();
}

void RangeTracker::rebuild_uncovered() {
    std::vector<Interval> all_covered = claimed_;
    all_covered.insert(all_covered.end(), completed_.begin(), completed_.end());
    // aborted_ intervals should be returned to uncovered, so we DON'T add them here
    merge_intervals(all_covered);

    if (full_range_set_) {
        subtract_intervals({full_range_}, all_covered, uncovered_);
    } else if (!all_covered.empty()) {
        uint64_t full_start = all_covered.front().start;
        uint64_t full_end = all_covered.back().end;
        subtract_intervals({{full_start, full_end}}, all_covered, uncovered_);
    } else {
        uncovered_.clear();
    }
}

std::optional<Interval> RangeTracker::claim(uint64_t max_len, const std::string& seed, uint64_t nonce) {
    if (uncovered_.empty()) return std::nullopt;

    uint64_t total = 0;
    for (const auto& iv : uncovered_) total += iv.length();
    if (total == 0) return std::nullopt;

    std::string combined = seed + "|" + std::to_string(nonce);
    uint64_t hash = fnv1a64(reinterpret_cast<const uint8_t*>(combined.data()), combined.size());
    uint64_t offset = hash % total;

    for (const auto& iv : uncovered_) {
        uint64_t len = iv.length();
        if (offset >= len) { offset -= len; continue; }
        uint64_t claim_start = iv.start + offset;
        uint64_t claim_end = (max_len == 0) ? iv.end : std::min(claim_start + max_len, iv.end);
        if (claim_end <= claim_start) return std::nullopt;
        Interval claimed = {claim_start, claim_end};

        JournalEntry e;
        e.type = EventType::CLAIM;
        e.job = job_;
        e.interval = claimed;
        e.timestamp_ms = now_ms();
        e.nonce = nonce;
        e.seed = seed;
        if (!append_entry(e)) { error_ = "failed to append claim"; return std::nullopt; }

        claimed_.push_back(claimed);
        rebuild_uncovered();
        return claimed;
    }
    return std::nullopt;
}

bool RangeTracker::complete(const Interval& interval, bool aborted, uint64_t keys_found) {
    auto it = std::find_if(claimed_.begin(), claimed_.end(),
        [&](const Interval& x) { return x.start == interval.start && x.end == interval.end; });
    if (it == claimed_.end()) { error_ = "complete: interval not found in claimed"; return false; }

    JournalEntry e;
    e.type = aborted ? EventType::ABORT : EventType::COMPLETE;
    e.job = job_;
    e.interval = interval;
    e.timestamp_ms = now_ms();
    e.nonce = 0;
    e.seed.clear();
    e.cmd_params.clear();
    e.keys_found = keys_found;

    if (!append_entry(e)) { error_ = "failed to append complete"; return false; }

    if (!aborted) completed_.push_back(interval);
    else aborted_.push_back(interval);
    claimed_.erase(it);
    rebuild_uncovered();
    return true;
}

Progress RangeTracker::progress() const {
    Progress p;
    for (const auto& iv : completed_) p.covered += iv.length();
    for (const auto& iv : uncovered_) p.uncovered += iv.length();
    for (const auto& iv : claimed_) p.unknown_after_crash += iv.length();
    p.total_range = p.covered + p.uncovered + p.unknown_after_crash;
    if (p.total_range > 0) {
        p.pct_covered = double(p.covered) / double(p.total_range) * 100.0;
        p.pct_unknown = double(p.unknown_after_crash) / double(p.total_range) * 100.0;
    }
    p.last_checkpoint_ts = journal_generation_;
    return p;
}

std::vector<Interval> RangeTracker::uncovered() const {
    return uncovered_;
}

bool RangeTracker::append_entry(const JournalEntry& e) {
    std::ofstream out(journal_path_, std::ios::app);
    if (!out) return false;
    out << to_json(e) << '\n';
    out.flush();
    int fd = ::open(journal_path_.c_str(), O_WRONLY);
    if (fd >= 0) { ::fsync(fd); ::close(fd); }
    journal_generation_ = e.timestamp_ms;
    return true;
}

void RangeTracker::write_snapshot() {
    // ponytail: snapshot not needed for minimal version; journal replay is sufficient.
}

} // namespace rotor_progress
