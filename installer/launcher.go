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
)

const (
	MB_OK      = 0x00000000
	MB_ICONERR = 0x00000010
)

func msgBox(text, caption string) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	messageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), MB_OK|MB_ICONERR)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func main() {
	dir, _ := filepath.Abs(filepath.Dir(os.Args[0]))
	electron := filepath.Join(dir, "electron", "electron.exe")
	runjs := filepath.Join(dir, "_run.js")
	asar := filepath.Join(dir, "resources", "app.asar")
	logFile := filepath.Join(dir, "_run.log")

	// Pre-flight checks with specific error messages
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

	// Launch electron with stderr/stdout capture
	cmd := exec.Command(electron, runjs)
	cmd.Dir = dir

	// Write a launch marker to the log so we know the wrapper ran
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		fmt.Fprintf(f, "[%s] launcher: starting electron\n", time.Now().Format(time.RFC3339))
		f.Close()
	}

	if err := cmd.Start(); err != nil {
		msgBox(fmt.Sprintf("Failed to start electron.exe.\n\nError: %s\n\nPath: %s", err.Error(), electron), "Redbook — Launch Error")
		os.Exit(1)
	}

	// Wait 3 seconds — if electron dies immediately, show the error
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		// Electron exited within 3 seconds — something crashed
		if err != nil {
			// Read log file for clues
			logContent := ""
			if data, e := os.ReadFile(logFile); e == nil {
				lines := strings.Split(string(data), "\n")
				// Last 15 lines
				start := len(lines) - 15
				if start < 0 {
					start = 0
				}
				logContent = strings.Join(lines[start:], "\n")
			}
			msg := fmt.Sprintf("Electron exited immediately with an error.\n\nExit: %s\n\nInstall dir: %s", err.Error(), dir)
			if logContent != "" {
				msg += "\n\nLog tail:\n" + logContent
			}
			msgBox(msg, "Redbook — Crash")
		}
	case <-time.After(3 * time.Second):
		// Still running after 3 seconds — all good, exit wrapper
	}
}
