#include <windows.h>
#include <string.h>

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    char dir[MAX_PATH];
    char exe[MAX_PATH];
    char cmd[MAX_PATH * 2];
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;

    GetModuleFileNameA(NULL, dir, MAX_PATH);
    char *last = strrchr(dir, '\\');
    if (last) *last = '\0';

    snprintf(exe, MAX_PATH, "%s\\electron\\electron.exe", dir);
    snprintf(cmd, sizeof(cmd), "\"%s\" \"%s\\_run.js\"", exe, dir);

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(exe, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        MessageBoxA(NULL, "Failed to launch electron\\electron.exe.\nMake sure Electron is installed.", "Redbook", MB_ICONERROR);
        return 1;
    }

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 0;
}
