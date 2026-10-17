/** Persist installer failures before attempting a bounded, credential-free HTTPS upload. */
#pragma once
#include <winhttp.h>
#include "extract-report.h"

namespace installer_failure {
inline std::wstring Quote(const std::wstring& value) {
    std::wstring result = L"\"";
    for (wchar_t ch : value) {
        switch (ch) {
            case L'"': result += L"\\\""; break;
            case L'\\': result += L"\\\\"; break;
            case L'\r': result += L"\\r"; break;
            case L'\n': result += L"\\n"; break;
            case L'\t': result += L"\\t"; break;
            default:
                if (ch < 32) { wchar_t escaped[7]; swprintf_s(escaped, L"\\u%04x", static_cast<unsigned>(ch)); result += escaped; }
                else result += ch;
        }
    }
    return result + L"\"";
}

inline std::wstring Guid() {
    GUID id = {};
    if (FAILED(CoCreateGuid(&id))) return L"";
    wchar_t buffer[40] = {};
    StringFromGUID2(id, buffer, 40);
    return std::wstring(buffer + 1, 36);
}

inline std::wstring UtcTime() {
    SYSTEMTIME time = {}; GetSystemTime(&time);
    wchar_t buffer[32];
    swprintf_s(buffer, L"%04u-%02u-%02uT%02u:%02u:%02uZ", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond);
    return buffer;
}

inline bool Elevated() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    TOKEN_ELEVATION elevation = {}; DWORD size = 0;
    const bool ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) != FALSE;
    CloseHandle(token);
    return ok && elevation.TokenIsElevated != 0;
}

inline std::wstring Payload(const std::wstring& eventId, const std::wstring& deviceId,
    const std::wstring& version, const std::wstring& stage, int code, const std::wstring& error, const std::wstring& path) {
    wchar_t computer[MAX_COMPUTERNAME_LENGTH + 1] = {}; DWORD size = MAX_COMPUTERNAME_LENGTH + 1;
    GetComputerNameW(computer, &size);
    return L"{\"eventId\":" + Quote(eventId) + L",\"deviceId\":" + Quote(deviceId)
        + L",\"occurredAt\":" + Quote(UtcTime()) + L",\"appVersion\":" + Quote(version)
        + L",\"stage\":" + Quote(stage) + L",\"code\":" + std::to_wstring(code)
        + L",\"error\":" + Quote(error.substr(0, 8000)) + L",\"installPath\":" + Quote(path)
        + L",\"elevated\":" + (Elevated() ? L"true" : L"false")
        + L",\"windowsVersion\":" + Quote(extract_report::WindowsVersion()) + L",\"computerName\":" + Quote(computer) + L"}";
}

struct InternetHandle {
    HINTERNET value;
    ~InternetHandle() { if (value) WinHttpCloseHandle(value); }
};

inline bool Upload(const std::wstring& endpoint, const std::wstring& payload) {
    URL_COMPONENTS url = {}; url.dwStructSize = sizeof(url);
    url.dwHostNameLength = static_cast<DWORD>(-1); url.dwUrlPathLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(endpoint.c_str(), 0, 0, &url)) return false;
    const std::wstring host(url.lpszHostName, url.dwHostNameLength);
    // HTTP is allowed only for the same explicitly supported internal test server as the packaged runtime.
    if (url.nScheme != INTERNET_SCHEME_HTTPS && !(url.nScheme == INTERNET_SCHEME_HTTP && host == L"172.28.12.33" && url.nPort == 5080)) return false;
    InternetHandle session{WinHttpOpen(L"wanzai-installer/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session.value) return false;
    WinHttpSetTimeouts(session.value, 1000, 1000, 1000, 1500);
    InternetHandle connection{WinHttpConnect(session.value, host.c_str(), url.nPort, 0)};
    if (!connection.value) return false;
    const std::wstring path(url.lpszUrlPath, url.dwUrlPathLength);
    InternetHandle request{WinHttpOpenRequest(connection.value, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, url.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)};
    if (!request.value) return false;
    DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirects, sizeof(redirects));
    const int size = WideCharToMultiByte(CP_UTF8, 0, payload.c_str(), static_cast<int>(payload.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0 || size > 65536) return false;
    std::string bytes(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, payload.c_str(), static_cast<int>(payload.size()), &bytes[0], size, nullptr, nullptr);
    if (!WinHttpSendRequest(request.value, L"Content-Type: application/json\r\n", static_cast<DWORD>(-1), &bytes[0],
        static_cast<DWORD>(bytes.size()), static_cast<DWORD>(bytes.size()), 0) || !WinHttpReceiveResponse(request.value, nullptr)) return false;
    DWORD status = 0, length = sizeof(status);
    return WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &length, WINHTTP_NO_HEADER_INDEX) && status >= 200 && status < 300;
}

inline bool Report(LPCWSTR endpoint, LPCWSTR version, LPCWSTR stage, int code, LPCWSTR message, LPCWSTR path, LPCWSTR outputFile) {
    static const std::wstring deviceId = Guid();
    const std::wstring eventId = Guid();
    std::wstring error = message;
    if (code != 0) error += L"\r\nResult code: " + std::to_wstring(code)
        + (std::wstring(stage) == L"extract" ? L" " + extract_report::DescribeResult(code)
            : L" " + extract_report::Win32Message(static_cast<DWORD>(code)));
    if (outputFile && *outputFile) error += L"\r\n" + extract_report::ReadOutput(outputFile);
    const std::wstring payload = Payload(eventId, deviceId, version, stage, code, error, path);
    wchar_t local[MAX_PATH] = {};
    if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, local))) return false;
    const std::wstring file = std::wstring(local) + L"\\wanzai\\InstallerLogs\\" + eventId + L".json";
    const bool saved = extract_report::WriteUtf8(file.c_str(), payload);
    const bool uploaded = endpoint && *endpoint && Upload(endpoint, payload);
    extract_report::WriteUtf8((file + L".status").c_str(), uploaded ? L"Uploaded to AIGC" : L"Upload unavailable; local report retained");
    return saved;
}
}
