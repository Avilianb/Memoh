package personalwechat

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/memohai/memoh/internal/channel"
)

func TestResolveAttachmentReadsMediaDirFile(t *testing.T) {
	t.Parallel()

	mediaDir := t.TempDir()
	filePath := filepath.Join(mediaDir, "report.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	adapter := NewAdapter(nil)
	payload, err := adapter.ResolveAttachment(context.Background(), channel.ChannelConfig{
		Credentials: map[string]any{
			"dataDir":  t.TempDir(),
			"mediaDir": mediaDir,
		},
	}, channel.Attachment{Path: filePath})
	if err != nil {
		t.Fatalf("ResolveAttachment returned error: %v", err)
	}
	defer func() {
		_ = payload.Reader.Close()
	}()
	body, err := io.ReadAll(payload.Reader)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if string(body) != "hello" {
		t.Fatalf("payload body = %q", string(body))
	}
	if payload.Name != "report.txt" {
		t.Fatalf("payload name = %q", payload.Name)
	}
	if payload.Mime != "text/plain" {
		t.Fatalf("payload mime = %q", payload.Mime)
	}
	if payload.Size != int64(len("hello")) {
		t.Fatalf("payload size = %d", payload.Size)
	}
}

func TestResolveAttachmentRejectsOutsideMediaDir(t *testing.T) {
	t.Parallel()

	mediaDir := t.TempDir()
	outsideDir := t.TempDir()
	filePath := filepath.Join(outsideDir, "report.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	adapter := NewAdapter(nil)
	_, err := adapter.ResolveAttachment(context.Background(), channel.ChannelConfig{
		Credentials: map[string]any{
			"dataDir":  t.TempDir(),
			"mediaDir": mediaDir,
		},
	}, channel.Attachment{Path: filePath})
	if err == nil {
		t.Fatal("expected outside-media-dir error")
	}
	if !strings.Contains(err.Error(), "outside media directory") {
		t.Fatalf("unexpected error: %v", err)
	}
}
