package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32      = syscall.NewLazyDLL("user32.dll")
	messageBoxW = user32.NewProc("MessageBoxW")
	kernel32    = syscall.NewLazyDLL("kernel32.dll")
	loadLibrary = kernel32.NewProc("LoadLibraryW")
)

const (
	MB_OK        = 0x00000000
	MB_ICONERR   = 0x00000010
	MB_ICONWARN  = 0x00000030
	MB_YESNO     = 0x00000004
	IDYES        = 6
)

func msgBox(text, caption string) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	messageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), MB_OK|MB_ICONERR)
}

func msgBoxYesNo(text, caption string) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	ret, _, _ := messageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), MB_YESNO|MB_ICONWARN)
	return int(ret)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func dllExists(name string) bool {
	p, _ := syscall.UTF16PtrFromString(name)
	h, _, _ := loadLibrary.Call(uintptr(unsafe.Pointer(p)))
	if h != 0 {
		syscall.FreeLibrary(syscall.Handle(h))
		return true
	}
	return false
}

func main() {
	dir, _ := filepath.Abs(filepath.Dir(os.Args[0]))
	electron := filepath.Join(dir, "electron", "electron.exe")
	runjs := filepath.Join(dir, "_run.js")
	asar := filepath.Join(dir, "resources", "app.asar")
	logFile := filepath.Join(dir, "_run.log")

	// Pre-flight: check required files
	var missing []string
	if !fileExists(electron) {
		missing = append(missing, fmt.Sprintf("  - electron\\electron.exe\n    (%s)", electron))
	}
	if !fileExists(runjs) {
		missing = append(missing, fmt.Sprintf("  - _run.js\n    (%s)", runjs))
	}
	if !fileExists(asar) {
		missing = append(missing, fmt.Sprintf("  - resources\\app.asar\n    (%s)", asar))
	}

	if len(missing) > 0 {
		msg := "Redbook cannot launch. The following files are missing:\n\n" +
			strings.Join(missing, "\n\n") +
			"\n\nInstall directory:\n" + dir +
			"\n\nTry re-running the Redbook installer."
		if !fileExists(asar) {
			msg += "\n\nNote: app.asar comes from Bluebook. Make sure Bluebook is installed,\nthen re-run the Redbook installer to copy it."
		}
		msgBox(msg, "Redbook — Missing Files")
		os.Exit(1)
	}

	// Build electron args: _run.js + chromium flags for VM/sandbox compat
	args := []string{
		runjs,
		"--no-sandbox",
		"--disable-gpu-sandbox",
		"--disable-gpu",
		"--disable-gpu-compositing",
		"--in-process-gpu",
	}

	// Pass through any extra args from the user
	if len(os.Args) > 1 {
		args = append(args, os.Args[1:]...)
	}

	cmd := exec.Command(electron, args...)
	cmd.Dir = dir

	// Write detailed launch diagnostics to the log
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		fmt.Fprintf(f, "\n[%s] === launcher start ===\n", time.Now().Format(time.RFC3339))
		fmt.Fprintf(f, "  dir:      %s\n", dir)
		fmt.Fprintf(f, "  electron: %s\n", electron)
		fmt.Fprintf(f, "  args:     %s\n", strings.Join(args, " "))
		fmt.Fprintf(f, "  exe:      %s\n", os.Args[0])
		f.Close()
	}

	if err := cmd.Start(); err != nil {
		msgBox(fmt.Sprintf("Failed to start electron.exe.\n\nError: %s\n\nPath: %s", err.Error(), electron), "Redbook — Launch Error")
		os.Exit(1)
	}

	// Log the PID
	if f2, e := os.OpenFile(logFile, os.O_WRONLY|os.O_APPEND, 0644); e == nil {
		fmt.Fprintf(f2, "  pid:      %d\n", cmd.Process.Pid)
		f2.Close()
	}

	// Wait 4 seconds — if electron exits for ANY reason, show diagnostic dialog
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		// Electron exited within 4 seconds — always suspicious
		logContent := readLogTail(logFile, 25)

		exitCode := 0
		exitStr := "exit code 0 (clean)"
		if err != nil {
			exitStr = err.Error()
			if ee, ok := err.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			}
		}

		hint := ""
		if exitCode == 0 {
			hint = "\n\nElectron exited cleanly but too quickly (under 4s).\n" +
				"This usually means the app loaded but failed silently.\n" +
				"Check the log for errors."
		} else if strings.Contains(exitStr, "80000003") {
			hint = "\n\nThis usually means:\n" +
				"  1. Missing Visual C++ Redistributable (x86)\n" +
				"     Download: https://aka.ms/vs/17/release/vc_redist.x86.exe\n" +
				"  2. GPU/driver issue in a VM — try --disable-gpu\n" +
				"  3. Corrupted Electron download — re-run installer"
		}

		msg := fmt.Sprintf("Electron exited within 4 seconds.\n\nExit: %s\n\nInstall dir: %s%s", exitStr, dir, hint)
		if logContent != "" {
			msg += "\n\nLog tail:\n" + logContent
		}
		msg += "\n\nFull log: " + logFile
		msgBox(msg, "Redbook — Launch Failed")

	case <-time.After(4 * time.Second):
		// Still running — all good
	}
}

func readLogTail(path string, lines int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	all := strings.Split(string(data), "\n")
	start := len(all) - lines
	if start < 0 {
		start = 0
	}
	return strings.Join(all[start:], "\n")
}
