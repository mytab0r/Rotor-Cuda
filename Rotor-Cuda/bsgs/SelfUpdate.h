// Self-update for Rotor-Cuda (Windows). Opt-in via --check-update / --update.
// Mechanism (why it works): a running .exe cannot be overwritten, but Windows
// DOES allow renaming it. So we download+verify a new exe, MoveFileEx the live
// exe aside to .old, move the new one into place, relaunch, and delete .old on
// next start. No helper .bat, no second process, atomic-ish with rollback.
//
// Verification: version_cmp() is portable and unit-tested (selfupdate_selftest).
// The WinHTTP download + MoveFileEx swap are Windows-only and compile-checked in
// cloud; the real network+replace path is UNVERIFIED until run on a real box.
#ifndef ROTOR_SELFUPDATE_H
#define ROTOR_SELFUPDATE_H

#include <string>

namespace rotor_update {

// Component-wise numeric compare of version strings ("v1.2.10" > "v1.2.3").
// Non-digit runs are separators; missing components count as 0.
// Returns -1 if a<b, 0 if equal, +1 if a>b.
int version_cmp(const std::string& a, const std::string& b);

struct UpdateInfo {
    bool        available = false;
    std::string latest;      // tag_name from the release
    std::string exe_url;     // browser_download_url of Rotor-Cuda.exe
    std::string sha_url;     // browser_download_url of Rotor-Cuda.exe.sha256
};

#ifdef _WIN32
// Query GitHub releases/latest for `repo` ("owner/name"); compare against
// `current`. Fills `out.available` if a strictly-newer tag exists. Network or
// parse failure -> returns false and sets `err`.
bool check_latest(const std::string& repo, const std::string& current,
                  UpdateInfo& out, std::string& err);

// Download exe_url -> "<self>.new", verify SHA-256 against sha_url, then swap
// (<self> -> <self>.old, <self>.new -> <self>) with rollback on failure.
// If `restart`, relaunch the new exe with (argc,argv) and exit the caller.
bool apply_update(const UpdateInfo& info, int argc, char** argv,
                  bool restart, std::string& err);

// Delete a leftover "<self>.old" from a previous update. Safe no-op if absent.
void cleanup_old();
#endif // _WIN32

} // namespace rotor_update
#endif
