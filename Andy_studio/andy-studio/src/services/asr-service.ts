/**
 * ASR (Automatic Speech Recognition) service.
 *
 * Reserved for future use. The full pipeline will look like:
 *
 *   ESP32 (HTTP upload of WAV) → Next.js /api/audio → ASR service → text
 *
 * NOT implemented in this version. The module exists so that the
 * `src/services` directory layout matches the spec and future imports
 * have a stable path.
 */

export interface AsrResult {
  text: string;
  language?: string;
  confidence?: number;
}

export interface AsrService {
  transcribe(audio: ArrayBuffer): Promise<AsrResult>;
}

export const asrService: AsrService = {
  async transcribe(): Promise<AsrResult> {
    throw new Error("asrService.transcribe is not implemented yet");
  },
};
