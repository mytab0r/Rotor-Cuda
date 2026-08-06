// FilterCatalog implementation. Uses vendored binaryfusefilter.h (MIT).
#include "FilterCatalog.h"
#include "binaryfusefilter.h"

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <sys/stat.h>

#if defined(_WIN32)
  #include <direct.h>
  #include <windows.h>
  static int mkdir_one(const char* p) { return _mkdir(p); }
  static bool path_exists(const std::string& p) {
      DWORD a = GetFileAttributesA(p.c_str());
      return a != INVALID_FILE_ATTRIBUTES;
  }
  static bool rename_dir(const std::string& a, const std::string& b) {
      return MoveFileExA(a.c_str(), b.c_str(), 0) != 0; // fails if b exists -> atomic guard
  }
#else
  #include <unistd.h>
  static int mkdir_one(const char* p) { return mkdir(p, 0755); }
  static bool path_exists(const std::string& p) {
      struct stat st; return stat(p.c_str(), &st) == 0;
  }
  static bool rename_dir(const std::string& a, const std::string& b) {
      if (path_exists(b)) return false; // POSIX rename would overwrite empty dir; guard explicitly
      return std::rename(a.c_str(), b.c_str()) == 0;
  }
#endif

namespace rotor_filter {

static const char SEP = '/'; // both OSes accept '/' in path APIs used here

static void mkdirs(const std::string& path) {
    std::string acc;
    for (size_t i = 0; i < path.size(); ++i) {
        char c = path[i];
        if (c == '/' || c == '\\') {
            if (acc.size() > 1) mkdir_one(acc.c_str());
        }
        acc.push_back(c);
    }
    if (!acc.empty()) mkdir_one(acc.c_str());
}

static uint64_t fnv1a(const uint8_t* p, size_t n) {
    uint64_t h = 1469598103934665603ULL;
    for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}

uint64_t fold_key(const void* buf, size_t len) {
    return fnv1a(reinterpret_cast<const uint8_t*>(buf), len);
}

std::string canonical_dir(const std::string& root, const Manifest& m) {
    std::ostringstream o;
    o << root << SEP << m.coin << SEP << m.bits << SEP << m.range_id << SEP << m.kind;
    return o.str();
}

static bool write_all(const std::string& path, const char* data, size_t n) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    f.write(data, (std::streamsize)n);
    return (bool)f;
}

static std::string manifest_text(const Manifest& m) {
    std::ostringstream o;
    o << "format_version=" << m.format_version << "\n"
      << "coin=" << m.coin << "\n"
      << "bits=" << m.bits << "\n"
      << "range_id=" << m.range_id << "\n"
      << "kind=" << m.kind << "\n"
      << "curve=" << m.curve << "\n"
      << "endianness=" << m.endianness << "\n"
      << "key_count=" << m.key_count << "\n"
      << "payload_checksum=" << m.payload_checksum << "\n";
    return o.str();
}

static bool parse_manifest(const std::string& path, Manifest& m, std::string& err) {
    std::ifstream f(path);
    if (!f) { err = "cannot open manifest"; return false; }
    std::string line;
    while (std::getline(f, line)) {
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = line.substr(0, eq), v = line.substr(eq + 1);
        if (!v.empty() && v.back() == '\r') v.pop_back();
        if      (k == "format_version")  m.format_version = (uint32_t)std::stoul(v);
        else if (k == "coin")            m.coin = v;
        else if (k == "bits")            m.bits = (uint32_t)std::stoul(v);
        else if (k == "range_id")        m.range_id = v;
        else if (k == "kind")            m.kind = v;
        else if (k == "curve")           m.curve = v;
        else if (k == "endianness")      m.endianness = v;
        else if (k == "key_count")       m.key_count = std::stoull(v);
        else if (k == "payload_checksum")m.payload_checksum = std::stoull(v);
    }
    return true;
}

bool publish(const std::string& root, Manifest& m,
             const std::vector<uint64_t>& keys, std::string& err) {
    if (keys.size() < 2) { err = "need at least 2 keys"; return false; }
    if (m.coin.empty() || m.range_id.empty()) { err = "coin and range_id required"; return false; }

    const std::string final_dir = canonical_dir(root, m);
    if (path_exists(final_dir)) { err = "canonical path exists: " + final_dir; return false; }

    // Build fuse over a copy (populate mutates the key array).
    std::vector<uint64_t> ks = keys;
    binary_fuse8_t filter;
    if (!binary_fuse8_allocate((uint32_t)ks.size(), &filter)) { err = "fuse allocate failed"; return false; }
    if (!binary_fuse8_populate(ks.data(), (uint32_t)ks.size(), &filter)) {
        binary_fuse8_free(&filter);
        err = "fuse populate failed (duplicate keys or bad luck; retry)"; return false;
    }

    // Serialize to buffer.
    size_t nbytes = binary_fuse8_serialization_bytes(&filter);
    std::vector<char> buf(nbytes);
    binary_fuse8_serialize(&filter, buf.data());
    binary_fuse8_free(&filter);

    m.key_count = keys.size();
    m.payload_checksum = fnv1a(reinterpret_cast<const uint8_t*>(buf.data()), nbytes);

    // Stage in a sibling temp dir, then atomically rename into <range_id>/<kind>.
    const std::string parent = root + SEP + m.coin + SEP + std::to_string(m.bits) + SEP + m.range_id;
    mkdirs(parent);
    const std::string tmp = parent + SEP + ".tmp-" + m.kind;
    mkdirs(tmp);
    if (!write_all(tmp + SEP + "filter.bin", buf.data(), nbytes)) { err = "write filter.bin failed"; return false; }
    const std::string mt = manifest_text(m);
    if (!write_all(tmp + SEP + "manifest.txt", mt.data(), mt.size())) { err = "write manifest failed"; return false; }

    if (!rename_dir(tmp, final_dir)) { err = "atomic publish failed (collision?)"; return false; }
    return true;
}

// ---- load ----
struct FuseImpl { binary_fuse8_t f; std::vector<char> owned; };

LoadedFilter::~LoadedFilter() {
    if (impl) {
        auto* fi = reinterpret_cast<FuseImpl*>(impl);
        // Fingerprints points into owned buffer via deserialize_header, so no fuse_free.
        delete fi; impl = nullptr;
    }
}

bool LoadedFilter::contains(uint64_t key) const {
    if (!impl) return false;
    auto* fi = reinterpret_cast<FuseImpl*>(impl);
    return binary_fuse8_contain(key, &fi->f);
}

bool load(const std::string& kind_dir, LoadedFilter& out, std::string& err) {
    Manifest m;
    if (!parse_manifest(kind_dir + SEP + "manifest.txt", m, err)) return false;
    if (m.format_version != FILTER_FORMAT_VERSION) { err = "unsupported format_version"; return false; }
    if (m.curve != "secp256k1") { err = "curve mismatch"; return false; }

    std::ifstream f(kind_dir + SEP + "filter.bin", std::ios::binary);
    if (!f) { err = "cannot open filter.bin"; return false; }
    std::vector<char> buf((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    uint64_t chk = fnv1a(reinterpret_cast<const uint8_t*>(buf.data()), buf.size());
    if (chk != m.payload_checksum) { err = "payload checksum mismatch"; return false; }

    auto* fi = new FuseImpl();
    fi->owned = std::move(buf);
    // deserialize_header points Fingerprints into owned buffer (no alloc).
    const char* fp = binary_fuse8_deserialize_header(&fi->f, fi->owned.data());
    fi->f.Fingerprints = reinterpret_cast<uint8_t*>(const_cast<char*>(fp));
    out.impl = fi;
    out.manifest = m;
    return true;
}

} // namespace rotor_filter
