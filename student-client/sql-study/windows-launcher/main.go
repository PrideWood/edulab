// EduLab's launcher bundles only CPython + application assets, never a browser.
package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Generated from the verified official Windows embeddable Python distribution.
//
//go:embed payload.zip
var payload []byte

func extractPayload(data []byte, base string) (string, error) {
	sum := sha256.Sum256(data)
	version := hex.EncodeToString(sum[:])
	target := filepath.Join(base, version)
	marker := filepath.Join(target, ".complete")
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	validCache := func() bool {
		value, err := os.ReadFile(marker)
		if err != nil || string(value) != version {
			return false
		}
		for _, entry := range archive.File {
			if entry.FileInfo().IsDir() {
				continue
			}
			file, err := os.Lstat(filepath.Join(target, filepath.FromSlash(entry.Name)))
			if err != nil || !file.Mode().IsRegular() || uint64(file.Size()) != entry.UncompressedSize64 {
				return false
			}
			input, err := os.Open(filepath.Join(target, filepath.FromSlash(entry.Name)))
			if err != nil {
				return false
			}
			checksum := crc32.NewIEEE()
			_, copyErr := io.Copy(checksum, input)
			closeErr := input.Close()
			if copyErr != nil || closeErr != nil || checksum.Sum32() != entry.CRC32 {
				return false
			}
		}
		return true
	}
	if validCache() {
		return target, nil
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(base, ".extract-")
	if err != nil {
		return "", err
	}
	// Only this call's freshly-created staging folder can be removed.
	defer os.RemoveAll(stage)
	var total uint64
	for _, entry := range archive.File {
		name := entry.Name
		// Reject path traversal, Windows drive paths, alternate streams and links.
		if strings.Contains(name, "\\") || strings.Contains(name, ":") || strings.HasPrefix(name, "/") || entry.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("invalid runtime archive path")
		}
		dest := filepath.Join(stage, filepath.FromSlash(name))
		rel, err := filepath.Rel(stage, dest)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return "", errors.New("runtime archive escapes its directory")
		}
		total += entry.UncompressedSize64
		if total > 150*1024*1024 {
			return "", errors.New("runtime archive too large")
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(dest, 0700); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			return "", err
		}
		input, err := entry.Open()
		if err != nil {
			return "", err
		}
		output, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			input.Close()
			return "", err
		}
		_, copyErr := io.Copy(output, input)
		inputErr, outputErr := input.Close(), output.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if inputErr != nil {
			return "", inputErr
		}
		if outputErr != nil {
			return "", outputErr
		}
	}
	for _, required := range []string{"python.exe", "boot.py", "server.py", "study_control.py", "course_layout.py", "cloud_connection.py", "questions.json", "web/index.html", "web/app.js", "web/compat.js"} {
		if info, err := os.Stat(filepath.Join(stage, required)); err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("missing runtime file: %s", required)
		}
	}
	if err := os.WriteFile(filepath.Join(stage, ".complete"), []byte(version), 0600); err != nil {
		return "", err
	}
	if validCache() {
		return target, nil
	}
	if _, err := os.Stat(target); err == nil {
		// Antivirus or an incomplete copy can remove only one cached file.
		// Preserve the damaged runtime (never student data) and extract afresh.
		if err := os.Rename(target, stage+".damaged-runtime"); err != nil {
			if validCache() {
				return target, nil
			}
			return "", errors.New("运行文件不完整且仍被占用，请关闭旧 EduLab 窗口后重试；不要删除学生数据")
		}
	}
	if err := os.Rename(stage, target); err != nil {
		// Two launches may extract simultaneously. Reuse only a complete target.
		if validCache() {
			return target, nil
		}
		return "", err
	}
	return target, nil
}

// Minimize only after Python confirms it launched the browser. Earlier failures stay visible.
type readyOutput struct {
	mu      sync.Mutex
	output  io.Writer
	tail    string
	once    sync.Once
	onReady func()
}

func (w *readyOutput) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	count, err := w.output.Write(data)
	w.tail += string(data)
	if strings.Contains(w.tail, "[EDULAB_READY]") {
		w.once.Do(w.onReady)
	}
	if len(w.tail) > 128 {
		w.tail = w.tail[len(w.tail)-128:]
	}
	return count, err
}

// Explicit -X utf8 is required: -I deliberately ignores PYTHONUTF8 environment variables.
func pythonArguments(runtime string, extra []string) []string {
	return append([]string{"-I", "-X", "utf8", "-u", filepath.Join(runtime, "boot.py")}, extra...)
}

func runtimeExitHint(code uint32) string {
	switch code {
	case 0xc0000135, 0xc0000139:
		return "\nWindows运行库或系统更新不完整。Win7请确认已安装SP1、Universal C Runtime（KB2999226或替代更新）和安全DLL加载更新（KB2533623/KB3063858或替代更新），由机房管理员检查；请勿从未知网站单独下载DLL。"
	case 0xc000007b:
		return "\n运行文件的32/64位不匹配或已损坏，请重新解压对应系统位数的完整程序包。"
	}
	return ""
}

func launch() error {
	fmt.Println("[1/4] EduLab SQL 0.15.0 starting. If this never appears, use Start-Classroom.cmd.")
	prepareConsole()
	fmt.Println("EduLab SQL · Windows 轻量版")
	fmt.Println("首次启动会在本机展开运行文件，无需安装 Python，无需下载浏览器。")
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return errors.New("无法找到 LOCALAPPDATA，请联系实验人员检查 Windows 用户目录")
	}
	fmt.Println("[2/4] Checking and extracting the bundled runtime...")
	runtime, err := extractPayload(payload, filepath.Join(local, "EduLab-SQL", "runtime"))
	if err != nil {
		return fmt.Errorf("准备本机运行环境失败：%w", err)
	}
	arguments := pythonArguments(runtime, os.Args[1:])
	command := exec.Command(filepath.Join(runtime, "python.exe"), arguments...)
	command.Dir = runtime
	output := &readyOutput{output: os.Stdout, onReady: minimizeConsole}
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, output, output
	command.Env = os.Environ()
	if err := command.Start(); err != nil {
		return err
	}
	fmt.Println("[3/4] Python started; waiting for the classroom to be ready...")
	err = command.Wait()
	if err != nil {
		restoreConsole()
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("%w%s", err, runtimeExitHint(uint32(exit.ExitCode())))
		}
	}
	return err
}

func main() {
	if err := launch(); err != nil {
		fmt.Fprintln(os.Stderr, "启动未完成：", err)
		fmt.Fprintln(os.Stderr, "请保留上面的错误信息并联系实验人员。按 Enter 退出。")
		bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(1)
	}
}
