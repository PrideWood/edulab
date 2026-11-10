package main

import (
    "syscall"
    "unsafe"
)

func prepareConsole() {
    kernel := syscall.NewLazyDLL("kernel32.dll")
    kernel.NewProc("SetConsoleOutputCP").Call(65001)
    kernel.NewProc("SetConsoleCP").Call(65001)
    title, _ := syscall.UTF16PtrFromString("EduLab SQL · 实验期间请保留此窗口")
    kernel.NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(title)))
}

func minimizeConsole() { setConsoleState(6) }
func restoreConsole() { setConsoleState(9) }
func setConsoleState(state uintptr) {
 kernel:=syscall.NewLazyDLL("kernel32.dll");window,_,_:=kernel.NewProc("GetConsoleWindow").Call()
 if window!=0 { syscall.NewLazyDLL("user32.dll").NewProc("ShowWindow").Call(window,state) }
}
