// See SelfUpdate.h. version_cmp is portable (tested on ubuntu). The Windows
// block uses WinHTTP (ships with the OS -> no new dependency) for HTTPS GET and
// MoveFileEx for the live-exe swap.
#include "SelfUpdate.h"
#include <cctype>
#include <cstdlib>
#ifdef _WIN32
// All system headers BEFORE the namespace, or their templates land inside it.
// NOMINMAX: windows.h min/max macros otherwise break <__msvc_bit_utils.hpp>.
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include <vector>
#include "../hash/sha256.h"
#pragma comment(lib, "winhttp.lib")
#endif

namespace rotor_update {

int version_cmp(const std::string& a, const std::string& b) {
    size_t i = 0, j = 0;
    while (i < a.size() || j < b.size()) {
        while (i < a.size() && !std::isdigit((unsigned char)a[i])) ++i;
        while (j < b.size() && !std::isdigit((unsigned char)b[j])) ++j;
        long va = 0, vb = 0;
        while (i < a.size() && std::isdigit((unsigned char)a[i])) va = va*10 + (a[i++]-'0');
        while (j < b.size() && std::isdigit((unsigned char)b[j])) vb = vb*10 + (b[j++]-'0');
        if (va != vb) return va < vb ? -1 : 1;
        if (i >= a.size() && j >= b.size()) break;
    }
    return 0;
}

#ifdef _WIN32

// Minimal HTTPS GET via WinHTTP. host like "api.github.com", path like "/repos/..".
// Follows the default redirect policy; returns body bytes or false on any error.
static bool https_get(const wchar_t* host, const std::wstring& path,
                      std::vector<uint8_t>& body, std::string& err) {
    body.clear();
    HINTERNET s = WinHttpOpen(L"Rotor-Cuda-Updater/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) { err = "WinHttpOpen failed"; return false; }
    HINTERNET c = WinHttpConnect(s, host, INTERNET_DEFAULT_HTTPS_PORT, 0);
    HINTERNET r = c ? WinHttpOpenRequest(c, L"GET", path.c_str(), NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : NULL;
    bool ok = false;
    // GitHub API requires a User-Agent; releases assets need it too.
    if (r && WinHttpAddRequestHeaders(r, L"User-Agent: Rotor-Cuda-Updater\r\nAccept: */*", (DWORD)-1L, WINHTTP_ADDREQ_FLAG_ADD)
          && WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
          && WinHttpReceiveResponse(r, NULL)) {
        DWORD n = 0;
        do {
            if (!WinHttpQueryDataAvailable(r, &n)) { err = "query data failed"; break; }
            if (!n) { ok = true; break; }
            size_t off = body.size(); body.resize(off + n);
            DWORD got = 0;
            if (!WinHttpReadData(r, body.data()+off, n, &got)) { err = "read failed"; break; }
            body.resize(off + got);
        } while (n > 0);
    } else if (err.empty()) err = "WinHTTP request failed";
    if (r) WinHttpCloseHandle(r);
    if (c) WinHttpCloseHandle(c);
    if (s) WinHttpCloseHandle(s);
    return ok;
}

// Crude JSON string-field extractor: first "key":"value" after position 0.
// ponytail: no JSON lib for two fields. Upgrade to a real parser only if the
// release payload shape ever gets nested enough to fool a substring scan.
static std::string json_str(const std::string& j, const std::string& key) {
    std::string pat = "\"" + key + "\"";
    size_t p = j.find(pat); if (p == std::string::npos) return "";
    p = j.find(':', p + pat.size()); if (p == std::string::npos) return "";
    p = j.find('"', p); if (p == std::string::npos) return "";
    size_t e = j.find('"', p + 1); if (e == std::string::npos) return "";
    return j.substr(p + 1, e - p - 1);
}

// Find the browser_download_url whose asset name ends with `suffix`.
static std::string asset_url(const std::string& j, const std::string& suffix) {
    size_t pos = 0;
    while (true) {
        size_t np = j.find("\"name\"", pos); if (np == std::string::npos) break;
        std::string name = json_str(j.substr(np), "name");
        size_t up = j.find("browser_download_url", np);
        std::string url = up != std::string::npos ? json_str(j.substr(up), "browser_download_url") : "";
        if (name.size() >= suffix.size() &&
            name.compare(name.size()-suffix.size(), suffix.size(), suffix) == 0 && !url.empty())
            return url;
        pos = np + 6;
    }
    return "";
}

static std::wstring widen(const std::string& s) { return std::wstring(s.begin(), s.end()); }

// Split "https://host/path" -> host,path. Assumes https.
static bool split_url(const std::string& url, std::wstring& host, std::wstring& path) {
    const std::string pfx = "https://";
    if (url.compare(0, pfx.size(), pfx) != 0) return false;
    size_t slash = url.find('/', pfx.size());
    host = widen(url.substr(pfx.size(), slash - pfx.size()));
    path = widen(slash == std::string::npos ? "/" : url.substr(slash));
    return true;
}

bool check_latest(const std::string& repo, const std::string& current,
                  UpdateInfo& out, std::string& err) {
    std::vector<uint8_t> body;
    std::wstring path = L"/repos/" + widen(repo) + L"/releases/latest";
    if (!https_get(L"api.github.com", path, body, err)) return false;
    std::string j((char*)body.data(), body.size());
    out.latest  = json_str(j, "tag_name");
    if (out.latest.empty()) { err = "no tag_name in release JSON"; return false; }
    out.exe_url = asset_url(j, "Rotor-Cuda.exe");        // matches the packaged asset
    out.sha_url = asset_url(j, ".exe.sha256");
    out.available = version_cmp(current, out.latest) < 0;
    return true;
}

static std::string self_path() {
    wchar_t buf[MAX_PATH]; DWORD n = GetModuleFileNameW(NULL, buf, MAX_PATH);
    std::wstring w(buf, n); return std::string(w.begin(), w.end());
}

static bool download_to(const std::string& url, const std::string& file, std::string& err) {
    std::wstring host, path; if (!split_url(url, host, path)) { err = "bad url"; return false; }
    std::vector<uint8_t> body;
    if (!https_get(host.c_str(), path, body, err)) return false;
    FILE* f = fopen(file.c_str(), "wb"); if (!f) { err = "cannot write "+file; return false; }
    fwrite(body.data(), 1, body.size(), f); fclose(f);
    return true;
}

// hex sha256 of a file, reusing the fork's sha256().
static std::string sha256_file(const std::string& file) {
    FILE* f = fopen(file.c_str(), "rb"); if (!f) return "";
    std::vector<uint8_t> data; uint8_t buf[65536]; size_t r;
    while ((r = fread(buf, 1, sizeof buf, f)) > 0) data.insert(data.end(), buf, buf+r);
    fclose(f);
    uint8_t dg[32]; sha256(data.data(), (int)data.size(), dg);
    return sha256_hex(dg);
}

bool apply_update(const UpdateInfo& info, int argc, char** argv,
                  bool restart, std::string& err) {
    if (info.exe_url.empty() || info.sha_url.empty()) { err = "release missing exe/sha asset"; return false; }
    std::string self = self_path();
    std::string neu = self + ".new", old = self + ".old";

    if (!download_to(info.exe_url, neu, err)) return false;

    // Expected hash = first token of the .sha256 body.
    std::vector<uint8_t> shab; std::wstring h, p; split_url(info.sha_url, h, p);
    if (!https_get(h.c_str(), p, shab, err)) { DeleteFileA(neu.c_str()); return false; }
    std::string want((char*)shab.data(), shab.size());
    want = want.substr(0, want.find_first_of(" \r\n\t"));
    std::string got = sha256_file(neu);
    for (auto& ch : want) ch = (char)tolower((unsigned char)ch);
    if (want.empty() || got != want) { DeleteFileA(neu.c_str()); err = "sha256 mismatch"; return false; }

    // Swap: live exe aside, new into place. Rollback if the second move fails.
    DeleteFileA(old.c_str());
    if (!MoveFileExA(self.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING)) { err = "cannot rename running exe"; return false; }
    if (!MoveFileExA(neu.c_str(), self.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        MoveFileExA(old.c_str(), self.c_str(), MOVEFILE_REPLACE_EXISTING);  // rollback
        err = "cannot install new exe (rolled back)"; return false;
    }

    if (restart) {
        std::string cmd = "\"" + self + "\"";
        for (int i = 1; i < argc; ++i) { cmd += " \""; cmd += argv[i]; cmd += "\""; }
        STARTUPINFOA si{}; si.cb = sizeof si; PROCESS_INFORMATION pi{};
        std::vector<char> mut(cmd.begin(), cmd.end()); mut.push_back(0);
        if (CreateProcessA(self.c_str(), mut.data(), NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        }
        ExitProcess(0);
    }
    return true;
}

void cleanup_old() {
    std::string old = self_path() + ".old";
    DeleteFileA(old.c_str());   // no-op if absent
}
#endif // _WIN32

} // namespace rotor_update
