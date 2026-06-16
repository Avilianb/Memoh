package personalwechat

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/memohai/memoh/internal/channel"
)

type bufferWriteCloser struct {
	bytes.Buffer
}

func (*bufferWriteCloser) Close() error { return nil }

func TestOpenStreamUsesSourceMessageIDAsReply(t *testing.T) {
	t.Parallel()

	adapter := NewAdapter(nil)
	stream, err := adapter.OpenStream(context.Background(), channel.ChannelConfig{}, "room:room-1", channel.StreamOptions{
		SourceMessageID: "source-1",
	})
	if err != nil {
		t.Fatalf("OpenStream error = %v", err)
	}
	pwStream, ok := stream.(*outboundStream)
	if !ok {
		t.Fatalf("stream type = %T, want *outboundStream", stream)
	}
	if pwStream.reply == nil || pwStream.reply.MessageID != "source-1" || pwStream.reply.Target != "room:room-1" {
		t.Fatalf("unexpected reply: %#v", pwStream.reply)
	}
}

func TestOutboundStreamFinalSendsBridgeCommand(t *testing.T) {
	t.Parallel()

	adapter := NewAdapter(nil)
	stdin := &bufferWriteCloser{}
	cfg := channel.ChannelConfig{ID: "cfg-1", ChannelType: Type}
	adapter.clients[cfg.ID] = &bridgeClient{cfgID: cfg.ID, stdin: stdin}

	stream, err := adapter.OpenStream(context.Background(), cfg, "contact:wxid_alice", channel.StreamOptions{})
	if err != nil {
		t.Fatalf("OpenStream error = %v", err)
	}
	if err := stream.Push(context.Background(), channel.PreparedStreamEvent{
		Type: channel.StreamEventFinal,
		Final: &channel.PreparedStreamFinalizePayload{
			Message: channel.PreparedMessage{
				Message: channel.Message{Text: "hello from memoh"},
			},
		},
	}); err != nil {
		t.Fatalf("Push final error = %v", err)
	}

	var cmd bridgeSendCommand
	if err := json.Unmarshal(bytes.TrimSpace(stdin.Bytes()), &cmd); err != nil {
		t.Fatalf("bridge command json error = %v; raw=%q", err, stdin.String())
	}
	if cmd.Type != "send" || cmd.Target != "contact:wxid_alice" || cmd.Message.Text != "hello from memoh" {
		t.Fatalf("unexpected bridge command: %#v", cmd)
	}
}
