/**
 * TTS (Text-to-Speech) service.
 *
 * Reserved for future use. Intended flow:
 *
 *   LLM reply → TTS service → WAV bytes → HTTP response to ESP32
 *
 * NOT implemented in this version.
 */

export interface TtsService {
  synthesize(text: string): Promise<ArrayBuffer>;
}

export const ttsService: TtsService = {
  async synthesize(): Promise<ArrayBuffer> {
    throw new Error("ttsService.synthesize is not implemented yet");
  },
};
