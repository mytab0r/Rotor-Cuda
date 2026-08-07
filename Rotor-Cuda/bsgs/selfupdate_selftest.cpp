// Self-check for version_cmp (portable). Asserts + exit code, no framework.
#include "SelfUpdate.h"
#include <cassert>
#include <cstdio>
using rotor_update::version_cmp;

int main() {
    assert(version_cmp("v1.2.3", "v1.2.3") == 0);
    assert(version_cmp("1.2.3",  "v1.2.3") == 0);      // 'v' is just a separator
    assert(version_cmp("v1.2.3", "v1.2.10") < 0);      // 10 > 3 numerically
    assert(version_cmp("v1.2.10","v1.2.3")  > 0);
    assert(version_cmp("v1.2",   "v1.2.0")  == 0);      // missing component == 0
    assert(version_cmp("v1.2.0", "v1.2")    == 0);
    assert(version_cmp("v2.0.0", "v1.9.9")  > 0);
    assert(version_cmp("v0.0.0", "v1.0.0")  < 0);
    assert(version_cmp("v1.10.0","v1.9.0")  > 0);
    assert(version_cmp("dev",    "v1.0.0")  < 0);       // no digits -> 0.0.0, any release newer
    printf("ALL SELFUPDATE version_cmp SELFTESTS PASSED\n");
    return 0;
}
