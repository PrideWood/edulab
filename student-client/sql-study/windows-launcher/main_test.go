package main

import (
    "archive/zip"
    "bytes"
    "os"
    "path/filepath"
    "testing"
    "strings"
)

func TestWindowsRuntimeFailuresHaveActionableHints(t *testing.T) {
    for _, code := range []uint32{0xc0000135, 0xc0000139} {
        if !strings.Contains(runtimeExitHint(code), "KB2999226") { t.Fatal("missing runtime hint") }
    }
    if !strings.Contains(runtimeExitHint(0xc000007b), "32/64") { t.Fatal("missing architecture hint") }
    if runtimeExitHint(1) != "" { t.Fatal("application failures must not be mislabeled as missing system updates") }
}

func fixture(t *testing.T, extra string) []byte {
    t.Helper()
    var out bytes.Buffer
    z := zip.NewWriter(&out)
    for _, name := range []string{"python.exe", "server.py", "study_control.py", "course_layout.py", "cloud_connection.py", "questions.json", "web/index.html", "web/app.js", "web/compat.js", extra} {
        if name == "" { continue }
        f, err := z.Create(name)
        if err != nil { t.Fatal(err) }
        f.Write([]byte("synthetic runtime file"))
    }
    if err := z.Close(); err != nil { t.Fatal(err) }
    return out.Bytes()
}

func TestMissingOrTruncatedCachedFilesAreRepaired(t *testing.T) {
    for _, name := range []string{"course_layout.py", "cloud_connection.py", "web/app.js"} {
        root := t.TempDir()
        data := fixture(t, "")
        cached, err := extractPayload(data, root)
        if err != nil { t.Fatal(err) }
        path := filepath.Join(cached, filepath.FromSlash(name))
        if err := os.Remove(path); err != nil { t.Fatal(err) }
        repaired, err := extractPayload(data, root)
        if err != nil || repaired != cached { t.Fatalf("repair failed: %v", err) }
        content, err := os.ReadFile(path)
        if err != nil || string(content) != "synthetic runtime file" { t.Fatal("missing file not repaired") }
        if err := os.WriteFile(path, []byte("truncated"), 0600); err != nil { t.Fatal(err) }
        if _, err := extractPayload(data, root); err != nil { t.Fatal(err) }
        content, _ = os.ReadFile(path)
        if string(content) != "synthetic runtime file" { t.Fatal("truncated file not repaired") }
        if err := os.WriteFile(path, bytes.Repeat([]byte("x"), len(content)), 0600); err != nil { t.Fatal(err) }
        if _, err := extractPayload(data, root); err != nil { t.Fatal(err) }
        content, _ = os.ReadFile(path)
        if string(content) != "synthetic runtime file" { t.Fatal("same-size corruption not repaired") }
    }
}

func TestExtractionAndReuse(t *testing.T) {
    root := t.TempDir()
    path, err := extractPayload(fixture(t, ""), root)
    if err != nil { t.Fatal(err) }
    again, err := extractPayload(fixture(t, ""), root)
    if err != nil || again != path { t.Fatalf("cache not reused: %v", err) }
    if _, err := os.Stat(filepath.Join(path, "web", "index.html")); err != nil { t.Fatal(err) }
}

func TestArchiveTraversalRejected(t *testing.T) {
    for _, path := range []string{"../escape", "/absolute", "C:/drive", "web\\escape", "file:stream"} {
        if _, err := extractPayload(fixture(t, path), t.TempDir()); err == nil { t.Fatalf("accepted %s", path) }
    }
}

func TestPythonArgumentsForceUTF8InIsolatedMode(t *testing.T) {
    args := pythonArguments("runtime", []string{"--no-browser"})
    expected := []string{"-I", "-X", "utf8", "-u", filepath.Join("runtime", "server.py"), "--no-browser"}
    if len(args) != len(expected) { t.Fatalf("unexpected Python arguments: %v", args) }
    for i := range expected { if args[i] != expected[i] { t.Fatalf("Python UTF-8 configuration missing: %v", args) } }
}
