// Exercise the exact native JSON serializer, Win32 error rendering and transport restrictions.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <cassert>
#include "../installer/failure-report.h"
extern "C" __declspec(dllimport) int __cdecl InstallerReportFailure(LPCWSTR endpoint, LPCWSTR version,
    LPCWSTR stage, int code, LPCWSTR message, LPCWSTR path, LPCWSTR outputFile);

int wmain(int argc, wchar_t** argv) {
    assert(argc == 2 || argc == 3);
    const std::wstring path = L"D:\\Program Files (x86)\\wanzai";
    const std::wstring error = L"Access denied\r\n\"quoted\"\\file " + extract_report::Win32Message(ERROR_ACCESS_DENIED);
    const auto payload = installer_failure::Payload(installer_failure::Guid(), installer_failure::Guid(),
        L"0.1.7-alpha.2.20261013.1", L"preflight", ERROR_ACCESS_DENIED, error, path);
    assert(payload.find(L"\"code\":5") != std::wstring::npos);
    assert(payload.find(L"\\r\\n\\\"quoted\\\"\\\\file") != std::wstring::npos);
    assert(payload.find(L"\"elevated\":") != std::wstring::npos);
    assert(payload.find(L"\"windowsVersion\":") != std::wstring::npos);
    assert(extract_report::WriteUtf8(argv[1], payload));
    assert(!installer_failure::Upload(L"http://localhost:12345/diagnostics", payload));
    if (argc == 3) assert(InstallerReportFailure(L"", L"installer-diagnostics-smoke", L"preflight",
        ERROR_ACCESS_DENIED, L"Intentional permission diagnostic test", argv[1], L"") == 1);
    return 0;
}
