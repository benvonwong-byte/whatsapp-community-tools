import { Router, Request, Response } from "express";
import multer from "multer";
import { AssemblyAI } from "assemblyai";
import { RelationshipStore } from "../relationship/store";
import { config } from "../../config";

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function createRecordingRouter(
  relationshipStore: RelationshipStore
): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  });

  // Initialize AssemblyAI client lazily
  let client: AssemblyAI | null = null;
  function getClient(): AssemblyAI {
    if (!client) {
      if (!config.assemblyAiApiKey) {
        throw new Error("ASSEMBLYAI_API_KEY not configured");
      }
      client = new AssemblyAI({ apiKey: config.assemblyAiApiKey });
    }
    return client;
  }

  // POST /api/recording/transcribe
  // Receives audio file via multipart/form-data, uploads to AssemblyAI,
  // returns transcript with speaker-labeled utterances.
  router.post("/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No audio file provided" });
        return;
      }

      console.log(`[recording] Received audio: ${req.file.size} bytes, type: ${req.file.mimetype}`);

      const assemblyClient = getClient();

      const uploadUrl = await assemblyClient.files.upload(req.file.buffer);
      console.log("[recording] Uploaded to AssemblyAI:", uploadUrl);

      const transcript = await assemblyClient.transcripts.transcribe({
        audio_url: uploadUrl,
        speaker_labels: true,
        speech_models: ["universal-3-pro"],
      });

      if (transcript.status === "error") {
        console.error("[recording] Transcription error:", transcript.error);
        res.status(500).json({ error: transcript.error });
        return;
      }

      res.json({
        id: transcript.id,
        text: transcript.text,
        utterances: (transcript.utterances || []).map((u) => ({
          speaker: u.speaker,
          text: u.text,
          start: u.start,
          end: u.end,
        })),
      });
    } catch (err: any) {
      console.error("[recording] Transcription failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/recording/save-transcript
  // Saves speaker-assigned utterances directly to the relationship store.
  // Expected body: {
  //   utterances: [{ speaker: "self"|"hope", body: string, timestamp: number }]
  //   source?: string  (defaults to "in-person")
  // }
  router.post("/save-transcript", (req: Request, res: Response) => {
    const { utterances, source } = req.body;

    if (!Array.isArray(utterances) || utterances.length === 0) {
      res.status(400).json({ error: "Missing 'utterances' array" });
      return;
    }

    const msgSource = source || "in-person";
    let imported = 0;
    const errors: string[] = [];

    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];

      if (!u.speaker || !["self", "hope"].includes(u.speaker)) {
        errors.push(`utterance[${i}]: invalid speaker "${u.speaker}" (must be "self" or "hope")`);
        continue;
      }
      if (!u.body || typeof u.body !== "string") {
        errors.push(`utterance[${i}]: missing body`);
        continue;
      }
      if (!u.timestamp || typeof u.timestamp !== "number") {
        errors.push(`utterance[${i}]: missing/invalid timestamp`);
        continue;
      }

      const hash = simpleHash(u.timestamp + u.speaker + u.body);
      const id = `${msgSource}_${u.timestamp}_${hash}`;

      if (!relationshipStore.isDuplicate(id)) {
        relationshipStore.saveMessage({
          id,
          speaker: u.speaker,
          body: u.body,
          transcript: "",
          timestamp: u.timestamp,
          type: "text",
          source: msgSource,
        });
        imported++;
      }
    }

    console.log(`[recording] Saved ${imported} in-person messages (${utterances.length - imported - errors.length} duplicates, ${errors.length} errors)`);

    res.json({
      ok: true,
      imported,
      total: utterances.length,
      duplicates: utterances.length - imported - errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  return router;
}
