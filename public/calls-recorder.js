/**
 * CallRecorder — shared class for recording calls with system audio + mic mixing.
 * Used by both calls.html (standalone) and friends.html (embedded tab).
 *
 * Usage:
 *   const recorder = new CallRecorder({ onStateChange, onTimer, onLevel });
 *   await recorder.start(audioSource); // "mic" | "system+mic"
 *   recorder.stop(); // returns Promise<Blob>
 */
class CallRecorder {
  constructor(opts = {}) {
    this.onStateChange = opts.onStateChange || (() => {});
    this.onTimer = opts.onTimer || (() => {});
    this.onLevel = opts.onLevel || (() => {}); // 0-1 audio level

    this.state = "idle"; // idle | recording | stopped
    this.audioSource = "mic"; // mic | system+mic
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioContext = null;
    this.analyser = null;
    this.streams = []; // all streams to stop
    this.startTime = 0;
    this.timerInterval = null;
    this.animFrame = null;
    this._blob = null;
  }

  get elapsed() {
    if (!this.startTime) return 0;
    return Date.now() - this.startTime;
  }

  get elapsedFormatted() {
    const ms = this.elapsed;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  get durationSeconds() {
    return Math.round(this.elapsed / 1000);
  }

  async start(audioSource = "mic") {
    if (this.state === "recording") return;
    this.audioSource = audioSource;
    this.audioChunks = [];
    this._blob = null;

    try {
      let rawStream;

      if (audioSource === "system+mic") {
        rawStream = await this._getSystemPlusMic();
      } else {
        rawStream = await this._getMicOnly();
      }

      // Create a 16kHz AudioContext for downsampling + mono conversion.
      // This dramatically reduces file size (48kHz stereo -> 16kHz mono = ~6x smaller PCM).
      // Combined with low-bitrate Opus encoding, a 1-hour call is ~20MB instead of ~120MB+.
      const TARGET_SAMPLE_RATE = 16000;
      let ctxOpts = {};
      try { ctxOpts = { sampleRate: TARGET_SAMPLE_RATE }; } catch {}
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)(ctxOpts);

      // Source -> ChannelMerger (force mono) -> Analyser (level meter) -> Destination (for recording)
      const source = this.audioContext.createMediaStreamSource(rawStream);

      // Force mono: merge all channels into 1
      const merger = this.audioContext.createChannelMerger(1);
      source.connect(merger);

      // Level meter
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      merger.connect(this.analyser);

      // Output destination for MediaRecorder (16kHz mono stream)
      const dest = this.audioContext.createMediaStreamDestination();
      this.analyser.connect(dest);

      const recordStream = dest.stream;

      // MediaRecorder with low bitrate — 48kbps Opus is plenty for speech
      const mimeType = this._getSupportedMimeType();
      const recorderOpts = { audioBitsPerSecond: 48000 };
      if (mimeType) recorderOpts.mimeType = mimeType;
      this.mediaRecorder = new MediaRecorder(recordStream, recorderOpts);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.start(1000);

      this.startTime = Date.now();
      this.state = "recording";
      this.onStateChange("recording");

      // Timer
      this.timerInterval = setInterval(() => {
        this.onTimer(this.elapsedFormatted, this.durationSeconds);
      }, 200);

      // Level meter
      this._drawLevel();

    } catch (err) {
      this.state = "idle";
      this.onStateChange("error");
      throw err;
    }
  }

  stop() {
    return new Promise((resolve) => {
      if (this.state !== "recording" || !this.mediaRecorder) {
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder.mimeType || "audio/webm";
        this._blob = new Blob(this.audioChunks, { type: mimeType });
        this._cleanup();
        this.state = "stopped";
        this.onStateChange("stopped");
        resolve(this._blob);
      };

      this.mediaRecorder.stop();
    });
  }

  getBlob() {
    return this._blob;
  }

  reset() {
    this._cleanup();
    this.state = "idle";
    this.audioChunks = [];
    this._blob = null;
    this.startTime = 0;
    this.onStateChange("idle");
  }

  // ── Private ──

  async _getMicOnly() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.streams.push(stream);
    return stream;
  }

  async _getSystemPlusMic() {
    // Try to capture system audio via getDisplayMedia
    let systemStream;
    try {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: true,
      });
    } catch (err) {
      // Some browsers require video:true; try with a minimal video track
      try {
        systemStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1 },
          audio: true,
        });
        // Kill the video track immediately
        systemStream.getVideoTracks().forEach(t => t.stop());
      } catch {
        console.warn("[CallRecorder] System audio unavailable, falling back to mic only");
        this.audioSource = "mic";
        return this._getMicOnly();
      }
    }
    this.streams.push(systemStream);

    // Check if we actually got audio tracks
    if (systemStream.getAudioTracks().length === 0) {
      console.warn("[CallRecorder] No system audio tracks, falling back to mic only");
      systemStream.getTracks().forEach(t => t.stop());
      this.audioSource = "mic";
      return this._getMicOnly();
    }

    // Get mic
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.streams.push(micStream);

    // Mix both streams into a single raw stream (downsampling happens later in start())
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();

    const sysSource = ctx.createMediaStreamSource(systemStream);
    sysSource.connect(dest);

    const micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(dest);

    this._mixingContext = ctx;
    return dest.stream;
  }

  _getSupportedMimeType() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }

  _drawLevel() {
    if (this.state !== "recording" || !this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length / 255; // 0-1
    this.onLevel(avg);
    this.animFrame = requestAnimationFrame(() => this._drawLevel());
  }

  _cleanup() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    cancelAnimationFrame(this.animFrame);
    this.animFrame = null;

    // Stop all streams
    for (const stream of this.streams) {
      stream.getTracks().forEach(t => t.stop());
    }
    this.streams = [];

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this._mixingContext) {
      this._mixingContext.close().catch(() => {});
      this._mixingContext = null;
    }
    this.analyser = null;
    this.mediaRecorder = null;
  }
}
