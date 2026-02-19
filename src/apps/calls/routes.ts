import { Router, Request, Response } from "express";
import multer from "multer";
import { AssemblyAI } from "assemblyai";
import { FriendsStore } from "../friends/store";
import { config } from "../../config";

export function createCallsRouter(store: FriendsStore): Router {
  const router = Router();

  const ALLOWED_AUDIO_TYPES = new Set([
    "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg",
    "audio/wav", "audio/x-m4a", "audio/aac",
  ]);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for longer calls
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_AUDIO_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid audio format: ${file.mimetype}`));
      }
    },
  });

  let client: AssemblyAI | null = null;
  function getClient(): AssemblyAI {
    if (!client) {
      if (!config.assemblyAiApiKey) throw new Error("ASSEMBLYAI_API_KEY not configured");
      client = new AssemblyAI({ apiKey: config.assemblyAiApiKey });
    }
    return client;
  }

  // POST /api/calls/transcribe — upload audio, get transcription with speaker labels
  router.post("/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
    try {
      if (!req.file) { res.status(400).json({ error: "No audio file provided" }); return; }

      console.log(`[calls] Received audio: ${req.file.size} bytes, type: ${req.file.mimetype}`);
      const assemblyClient = getClient();

      const uploadUrl = await assemblyClient.files.upload(req.file.buffer);
      console.log("[calls] Uploaded to AssemblyAI:", uploadUrl);

      const transcript = await assemblyClient.transcripts.transcribe({
        audio_url: uploadUrl,
        speaker_labels: true,
        speech_models: ["universal-3-pro"],
      });

      if (transcript.status === "error") {
        console.error("[calls] Transcription error:", transcript.error);
        res.status(500).json({ error: transcript.error });
        return;
      }

      const utterances = (transcript.utterances || []).map(u => ({
        speaker: u.speaker,
        text: u.text,
        start: u.start,
        end: u.end,
      }));

      res.json({
        assemblyai_id: transcript.id,
        text: transcript.text,
        utterances,
        duration: transcript.audio_duration || 0,
      });
    } catch (err: any) {
      console.error("[calls] Transcription failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/calls/save — save a completed call recording
  router.post("/save", (req: Request, res: Response) => {
    try {
      const { id, contact_id, title, call_type, duration_seconds, transcript_text,
        utterances_json, speaker_map_json, assemblyai_id, audio_captured, status, recorded_at } = req.body;

      if (!id) { res.status(400).json({ error: "id required" }); return; }

      store.saveCallRecording({
        id, contact_id, title, call_type,
        duration_seconds: duration_seconds || 0,
        transcript_text: transcript_text || "",
        utterances_json: typeof utterances_json === "string" ? utterances_json : JSON.stringify(utterances_json || []),
        speaker_map_json: typeof speaker_map_json === "string" ? speaker_map_json : JSON.stringify(speaker_map_json || {}),
        assemblyai_id: assemblyai_id || "",
        audio_captured: audio_captured || "mic",
        status: status || "done",
        error_message: "",
        recorded_at: recorded_at || Math.floor(Date.now() / 1000),
      });

      res.json({ ok: true, id });
    } catch (err: any) {
      console.error("[calls] Save error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/calls — list call recordings
  router.get("/", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const contactId = req.query.contact_id as string | undefined;
    const search = req.query.search as string | undefined;

    if (search) {
      res.json({ calls: store.searchCallTranscripts(search, limit) });
    } else {
      res.json({ calls: store.getCallRecordings(limit, offset, contactId) });
    }
  });

  // GET /api/calls/:id — get single call with full transcript
  router.get("/:id", (req: Request, res: Response) => {
    const call = store.getCallRecording(req.params.id as string);
    if (!call) { res.status(404).json({ error: "Call not found" }); return; }
    res.json({ call });
  });

  // PUT /api/calls/:id/contact — associate/change contact
  router.put("/:id/contact", (req: Request, res: Response) => {
    store.updateCallContact(req.params.id as string, req.body.contact_id || null);
    res.json({ ok: true });
  });

  // PUT /api/calls/:id/speakers — update speaker name mapping
  router.put("/:id/speakers", (req: Request, res: Response) => {
    const map = typeof req.body.speaker_map === "string" ? req.body.speaker_map : JSON.stringify(req.body.speaker_map || {});
    store.updateCallSpeakers(req.params.id as string, map);
    res.json({ ok: true });
  });

  // PUT /api/calls/:id/title — update call title
  router.put("/:id/title", (req: Request, res: Response) => {
    store.updateCallTitle(req.params.id as string, req.body.title || "");
    res.json({ ok: true });
  });

  // DELETE /api/calls/:id — delete a call recording
  router.delete("/:id", (req: Request, res: Response) => {
    store.deleteCallRecording(req.params.id as string);
    res.json({ ok: true });
  });

  return router;
}
