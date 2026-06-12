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

	if _, err := os.Stat(electron); os.IsNotExist(err) {
		msgBox("electron\\electron.exe is missing.\n\nThe Redbook installer should have downloaded Electron during setup.\nTry running RedbookSetup.exe again.", "Redbook")
		os.Exit(1)
	}

	cmd := exec.Command(electron, runjs)
	cmd.Dir = dir

	if err := cmd.Start(); err != nil {
		msgBox("Failed to launch electron\\electron.exe.\nMake sure Electron is installed.", "Redbook")
		os.Exit(1)
	}
}
