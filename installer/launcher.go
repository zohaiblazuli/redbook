package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	user32      = syscall.NewLazyDLL("user32.dll")
	messageBoxW = user32.NewProc("MessageBoxW")
)

func msgBox(text, caption string) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	messageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
}

func main() {
	dir, _ := filepath.Abs(filepath.Dir(os.Args[0]))
	electron := filepath.Join(dir, "electron", "electron.exe")
	runjs := filepath.Join(dir, "_run.js")

	cmd := exec.Command(electron, runjs)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	if err := cmd.Start(); err != nil {
		msgBox("Failed to launch electron\\electron.exe.\nMake sure Electron is installed.", "Redbook")
		os.Exit(1)
	}
}
