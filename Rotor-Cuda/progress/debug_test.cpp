#include "RangeProgress.h"
#include <cstdio>
#include <unistd.h>
using namespace rotor_progress;

int main() {
    const char* path = "/tmp/rp_debug.journal";
    unlink(path);
    JobIdentity job{"abc123", "bsgs", "cpu", 1, "chk"};
    RangeTracker t;
    if (!t.open(path, job)) { fprintf(stderr, "open: %s\n", t.last_error().c_str()); return 1; }
    fprintf(stderr, "open ok\n");

    // Check uncovered after open
    auto uncovered = t.uncovered();
    fprintf(stderr, "uncovered intervals: %zu\n", uncovered.size());
    for (const auto& u : uncovered) {
        fprintf(stderr, "  [%llu, %llu)\n", (unsigned long long)u.start, (unsigned long long)u.end);
    }

    auto iv1 = t.claim(100, "seed1", 1);
    if (!iv1) { fprintf(stderr, "claim1 fail - error: '%s'\n", t.last_error().c_str()); return 1; }
    fprintf(stderr, "claim1 ok: [%llu, %llu)\n", (unsigned long long)iv1->start, (unsigned long long)iv1->end);
    return 0;
}