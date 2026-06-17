package personalwechat

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/memohai/memoh/internal/attachment"
	"github.com/memohai/memoh/internal/channel"
	"github.com/memohai/memoh/internal/media"
)

// ResolveAttachment opens a sidecar-saved inbound attachment for Memoh media ingestion.
func (*Adapter) ResolveAttachment(ctx context.Context, cfg channel.ChannelConfig, att channel.Attachment) (channel.AttachmentPayload, error) {
	parsed, err := parseConfig(cfg.Credentials)
	if err != nil {
		return channel.AttachmentPayload{}, err
	}
	rawPath := strings.TrimSpace(att.Path)
	if rawPath == "" {
		return channel.AttachmentPayload{}, errors.New("personal_wechat attachment requires path")
	}
	resolvedPath, err := resolveMediaPath(parsed.MediaDir, rawPath)
	if err != nil {
		return channel.AttachmentPayload{}, err
	}
	if err := ctx.Err(); err != nil {
		return channel.AttachmentPayload{}, err
	}
	file, err := os.Open(resolvedPath)
	if err != nil {
		return channel.AttachmentPayload{}, fmt.Errorf("personal_wechat open attachment: %w", err)
	}
	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return channel.AttachmentPayload{}, fmt.Errorf("personal_wechat stat attachment: %w", err)
	}
	if !stat.Mode().IsRegular() {
		_ = file.Close()
		return channel.AttachmentPayload{}, errors.New("personal_wechat attachment path is not a regular file")
	}
	size := stat.Size()
	if size > media.MaxAssetBytes {
		_ = file.Close()
		return channel.AttachmentPayload{}, fmt.Errorf("%w: max %d bytes", media.ErrAssetTooLarge, media.MaxAssetBytes)
	}
	name := strings.TrimSpace(att.Name)
	if name == "" {
		name = filepath.Base(resolvedPath)
	}
	mimeType := attachment.NormalizeMime(att.Mime)
	if mimeType == "" {
		mimeType = attachment.NormalizeMime(mime.TypeByExtension(filepath.Ext(name)))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return channel.AttachmentPayload{
		Reader: file,
		Mime:   mimeType,
		Name:   name,
		Size:   size,
	}, nil
}

func resolveMediaPath(mediaDir, rawPath string) (string, error) {
	mediaRoot, err := filepath.Abs(filepath.Clean(strings.TrimSpace(mediaDir)))
	if err != nil {
		return "", fmt.Errorf("personal_wechat resolve media dir: %w", err)
	}
	mediaRoot, err = filepath.EvalSymlinks(mediaRoot)
	if err != nil {
		return "", fmt.Errorf("personal_wechat resolve media dir symlink: %w", err)
	}
	filePath, err := filepath.Abs(filepath.Clean(strings.TrimSpace(rawPath)))
	if err != nil {
		return "", fmt.Errorf("personal_wechat resolve attachment path: %w", err)
	}
	filePath, err = filepath.EvalSymlinks(filePath)
	if err != nil {
		return "", fmt.Errorf("personal_wechat resolve attachment symlink: %w", err)
	}
	if !pathWithin(mediaRoot, filePath) {
		return "", errors.New("personal_wechat attachment path is outside media directory")
	}
	return filePath, nil
}

func pathWithin(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return !filepath.IsAbs(rel)
}
