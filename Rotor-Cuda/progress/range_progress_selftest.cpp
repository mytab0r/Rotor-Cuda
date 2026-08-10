#include "RangeProgress.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unistd.h>

using namespace rotor_progress;

static void test_basic_claim_complete() {
    const char* path = "/tmp/rp_basic.journal";
    unlink(path);
    JobIdentity job{"abc123", "bsgs", "cpu", 1, "chk"};
    RangeTracker t;
    if (!t.open(path, job)) { fprintf(stderr, "open: %s\n", t.last_error().c_str()); exit(1); }
    t.set_full_range(0, 1000000);

    auto iv1 = t.claim(100, "seed1", 1);
    if (!iv1) { fprintf(stderr, "claim1 fail\n"); exit(1); }
    if (!t.complete(*iv1, false, 0)) { fprintf(stderr, "complete1: %s\n", t.last_error().c_str()); exit(1); }

    auto iv2 = t.claim(100, "seed1", 2);
    if (!iv2) { fprintf(stderr, "claim2 fail\n"); exit(1); }
    if (!t.complete(*iv2, false, 0)) { fprintf(stderr, "complete2 fail\n"); exit(1); }

    Progress p = t.progress();
    if (p.covered == 0 || p.unknown_after_crash != 0) {
        fprintf(stderr, "unexpected progress: covered=%llu unknown=%llu\n",
                (unsigned long long)p.covered, (unsigned long long)p.unknown_after_crash);
        exit(1);
    }
    t.close();
    unlink(path);
    printf("test_basic_claim_complete: PASS\n");
}

static void test_resume_after_crash() {
    const char* path = "/tmp/rp_resume.journal";
    unlink(path);
    JobIdentity job{"abc123", "bsgs", "cpu", 1, "chk"};

    {
        RangeTracker t;
        if (!t.open(path, job)) { fprintf(stderr, "open1 fail\n"); exit(1); }
        t.set_full_range(0, 10000000);
        auto iv = t.claim(1000, "seed1", 1);
        if (!iv) { fprintf(stderr, "claim fail\n"); exit(1); }
        // crash before complete
        t.close();
    }

    {
        RangeTracker t;
        if (!t.open(path, job)) { fprintf(stderr, "open2: %s\n", t.last_error().c_str()); exit(1); }
        t.set_full_range(0, 10000000);
        Progress p = t.progress();
        if (p.unknown_after_crash == 0) {
            fprintf(stderr, "expected unknown > 0 after crash, got 0\n");
            exit(1);
        }
        if (p.covered != 0) {
            fprintf(stderr, "expected covered == 0 after crash\n");
            exit(1);
        }
        printf("  resume: covered=%llu unknown=%llu\n",
               (unsigned long long)p.covered, (unsigned long long)p.unknown_after_crash);
        t.close();
    }
    unlink(path);
    printf("test_resume_after_crash: PASS\n");
}

static void test_abort() {
    const char* path = "/tmp/rp_abort.journal";
    unlink(path);
    JobIdentity job{"abc123", "bsgs", "cpu", 1, "chk"};
    RangeTracker t;
    if (!t.open(path, job)) { fprintf(stderr, "open fail\n"); exit(1); }
    t.set_full_range(0, 1000000);
    auto iv = t.claim(500, "seed1", 1);
    if (!iv) { fprintf(stderr, "claim fail\n"); exit(1); }
    if (!t.complete(*iv, true, 0)) { fprintf(stderr, "abort fail: %s\n", t.last_error().c_str()); exit(1); }

    Progress p = t.progress();
    if (p.unknown_after_crash != 0) { fprintf(stderr, "aborted in unknown\n"); exit(1); }
    auto unc = t.uncovered();
    bool found = false;
    for (const auto& u : unc) {
        if (u.start <= iv->start && u.end >= iv->end) { found = true; break; }
    }
    if (!found) { fprintf(stderr, "aborted range not in uncovered\n"); exit(1); }
    t.close();
    unlink(path);
    printf("test_abort: PASS\n");
}

static void test_job_mismatch() {
    const char* path = "/tmp/rp_mismatch.journal";
    unlink(path);
    JobIdentity j1{"abc", "bsgs", "cpu", 1, "c"};
    JobIdentity j2{"xyz", "bsgs", "cpu", 1, "c"};

    {
        RangeTracker t;
        if (!t.open(path, j1)) { fprintf(stderr, "open1 fail\n"); exit(1); }
        t.set_full_range(0, 1000000);
        auto iv = t.claim(100, "s", 1);
        if (!iv) { fprintf(stderr, "claim fail\n"); exit(1); }
        t.complete(*iv, false, 0);
        t.close();
    }
    {
        RangeTracker t;
        if (t.open(path, j2)) {
            fprintf(stderr, "expected mismatch fail\n");
            exit(1);
        }
        if (t.last_error().find("mismatch") == std::string::npos) {
            fprintf(stderr, "wrong error: %s\n", t.last_error().c_str());
            exit(1);
        }
    }
    unlink(path);
    printf("test_job_mismatch: PASS\n");
}

static void test_deterministic() {
    const char* path = "/tmp/rp_det.journal";
    JobIdentity job{"abc", "bsgs", "cpu", 1, "c"};

    Interval iv1, iv2;
    {
        unlink(path);
        RangeTracker t;
        if (!t.open(path, job)) exit(1);
        t.set_full_range(0, 1000000);
        auto iv = t.claim(100, "seed1", 1);
        if (!iv) exit(1);
        iv1 = *iv;
        t.close();
    }
    {
        unlink(path);
        RangeTracker t;
        if (!t.open(path, job)) exit(1);
        t.set_full_range(0, 1000000);
        auto iv = t.claim(100, "seed1", 1);
        if (!iv) exit(1);
        iv2 = *iv;
        t.close();
    }
    if (iv1.start != iv2.start || iv1.end != iv2.end) {
        fprintf(stderr, "non-deterministic: [%llu,%llu) vs [%llu,%llu)\n",
                (unsigned long long)iv1.start, (unsigned long long)iv1.end,
                (unsigned long long)iv2.start, (unsigned long long)iv2.end);
        exit(1);
    }
    unlink(path);
    printf("test_deterministic: PASS\n");
}

static void test_exhaustion() {
    const char* path = "/tmp/rp_exhaust.journal";
    unlink(path);
    JobIdentity job{"abc", "bsgs", "cpu", 1, "c"};
    RangeTracker t;
    if (!t.open(path, job)) exit(1);
    t.set_full_range(0, 100000);
    int count = 0;
    while (true) {
        auto iv = t.claim(10, "s", (uint64_t)count);
        if (!iv) break;
        if (!t.complete(*iv, false, 0)) exit(1);
        count++;
        if (count > 100000) { fprintf(stderr, "infinite loop\n"); exit(1); }
    }
    auto iv = t.claim(10, "s", 9999);
    if (iv) { fprintf(stderr, "not exhausted\n"); exit(1); }
    Progress p = t.progress();
    if (p.uncovered != 0) { fprintf(stderr, "expected uncovered=0, got %llu\n", (unsigned long long)p.uncovered); exit(1); }
    t.close();
    unlink(path);
    printf("test_exhaustion: PASS (%d intervals)\n", count);
}

static void test_max_len_cap() {
    const char* path = "/tmp/rp_maxlen.journal";
    unlink(path);
    JobIdentity job{"abc", "bsgs", "cpu", 1, "c"};
    RangeTracker t;
    if (!t.open(path, job)) exit(1);
    t.set_full_range(0, 1000000);
    auto iv = t.claim(5, "s", 1);
    if (!iv) exit(1);
    if (iv->length() > 5) { fprintf(stderr, "max_len not respected\n"); exit(1); }
    t.complete(*iv, false, 0);
    t.close();
    unlink(path);
    printf("test_max_len_cap: PASS\n");
}

int main() {
    test_basic_claim_complete();
    test_resume_after_crash();
    test_abort();
    test_job_mismatch();
    test_deterministic();
    test_exhaustion();
    test_max_len_cap();
    printf("\n=== ALL TESTS PASSED ===\n");
    return 0;
}