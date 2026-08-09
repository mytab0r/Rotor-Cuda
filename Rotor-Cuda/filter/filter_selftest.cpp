// Self-check for FilterCatalog. No framework: asserts + exit code.
// Verifies filters spec scenarios: binary-fuse membership (no false negative),
// save/load roundtrip, no-overwrite collision, checksum rejection.
#include "FilterCatalog.h"
#include <cassert>
#include <cstdio>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

using namespace rotor_filter;

static void rmrf(const std::string& p) {
#if defined(_WIN32)
    std::string c = "rmdir /s /q \"" + p + "\" >nul 2>&1";
#else
    std::string c = "rm -rf '" + p + "'";
#endif
    (void)!system(c.c_str());
}

int main() {
    const std::string root = "._filter_selftest";
    rmrf(root);

    // 10k synthetic members (stand-in for hash160/xpoint folds).
    std::vector<uint64_t> keys;
    for (uint64_t i = 0; i < 10000; ++i) keys.push_back(fold_key(&i, sizeof(i)));

    Manifest m;
    m.coin = "btc"; m.bits = 66; m.range_id = "20000000000000000-3ffffffffffffffff";
    std::string err;

    // publish
    bool ok = publish(root, m, keys, err);
    printf("publish: %d (%s)\n", ok, err.c_str());
    assert(ok);
    assert(m.key_count == 10000);
    assert(m.payload_checksum != 0);

    // load + no false negative for every member
    const std::string kd = canonical_dir(root, m);
    LoadedFilter lf;
    ok = load(kd, lf, err);
    printf("load: %d (%s)\n", ok, err.c_str());
    assert(ok);
    for (uint64_t i = 0; i < 10000; ++i) {
        assert(lf.contains(fold_key(&i, sizeof(i))) && "false negative for generated member");
    }
    // manifest survived roundtrip
    assert(lf.manifest.bits == 66 && lf.manifest.coin == "btc");
    assert(lf.manifest.key_count == 10000);

    // no silent overwrite: second publish to same canonical path must fail, no mutation
    Manifest m2 = m; std::string err2;
    bool ok2 = publish(root, m2, keys, err2);
    printf("overwrite-guard: publish returned %d (expected 0): %s\n", ok2, err2.c_str());
    assert(!ok2 && "collision must fail before mutation");

    // checksum rejection: corrupt filter.bin, load must reject
    {
        std::string fp = kd + "/filter.bin";
        std::fstream f(fp, std::ios::in | std::ios::out | std::ios::binary);
        assert(f);
        f.seekp(64); char junk = (char)0xFF; f.write(&junk, 1); f.close();
        LoadedFilter bad; std::string berr;
        bool bok = load(kd, bad, berr);
        printf("checksum-reject: load returned %d (expected 0): %s\n", bok, berr.c_str());
        assert(!bok && "corrupted payload must be rejected");
    }

    rmrf(root);
    printf("ALL FILTER SELFTESTS PASSED\n");
    return 0;
}
