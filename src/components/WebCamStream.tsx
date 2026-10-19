import { useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

export function WebcamStream() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<string>("Idle");

  const handleStartStream = async () => {
    const video = videoRef.current;
    if (!video) return;

    setStatus("Initializing MediaSource...");

    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener(
      "sourceopen",
      async () => {
        try {
          // Matches `profile="constrained-baseline"` from h264_caps in Rust
          const mimeCodec = 'video/mp4; codecs="avc1.42E01E"';
          const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

          // NOTE: Do NOT set `sourceBuffer.mode = "sequence"` with cmafmux!
          // cmafmux writes exact `tfdt` timestamps; "segments" mode (default) is much smoother on WebKitGTK.

          let queue: Uint8Array[] = [];

          const processQueue = () => {
            if (!sourceBuffer.updating && queue.length > 0) {
              // Merge all waiting chunks into a single append call so SourceBuffer never falls behind!
              const totalLength = queue.reduce((acc, chunk) => acc + chunk.byteLength, 0);
              const combined = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of queue) {
                combined.set(chunk, offset);
                offset += chunk.byteLength;
              }
              queue = [];

              try {
                sourceBuffer.appendBuffer(combined);
              } catch (err) {
                console.error("SourceBuffer append error:", err);
              }
            }
          };

          sourceBuffer.addEventListener("updateend", () => {
            processQueue();

            if (video.paused && video.buffered.length > 0) {
              video.play().catch(console.error);
              setStatus("Streaming fMP4");
            }

            // Keep latency tight by hugging the live edge
            if (video.buffered.length > 0) {
              const liveEdge = video.buffered.end(video.buffered.length - 1);
              const lag = liveEdge - video.currentTime;

              if (lag > 0.25) {
                video.currentTime = liveEdge - 0.04;
              } else if (lag > 0.08) {
                video.playbackRate = 1.05;
              } else {
                video.playbackRate = 1.0;
              }
            }
          });

          const onFrame = new Channel<ArrayBuffer | number[]>();

          onFrame.onmessage = (data) => {
            const chunk =
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data);

            queue.push(chunk);
            processQueue();
          };

          setStatus("Starting GStreamer pipeline...");
          await invoke("start_stream", { onFrame });
        } catch (err) {
          console.error("Failed to start stream:", err);
          setStatus(`Error: ${err}`);
        }
      },
      { once: true }
    );
  };

  return (
    <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button
          onClick={handleStartStream}
          style={{ padding: "8px 16px", cursor: "pointer" }}
        >
          Start Webcam (fMP4)
        </button>
        <span>
          Status: <strong>{status}</strong>
        </span>
      </div>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: "100%",
          maxWidth: "960px",
          backgroundColor: "#111",
          borderRadius: "8px",
        }}
      />
    </div>
  );
}
