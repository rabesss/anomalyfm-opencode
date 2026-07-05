/**
 * StreamPlayer interface — the shared contract across all four backends.
 *
 * This backend (statusline-only) implements it as a no-op. The three audio
 * backends (mpv / ffplay / in-process) implement it for real against their
 * respective engines. The RadioController talks only to this interface, so it
 * is identical across backends.
 */

export type PlayerState = "PAUSED" | "CONNECTING" | "PLAYING" | "ERROR" | "UNSUPPORTED";

export interface StreamPlayer {
  play(): Promise<void>;
  pause(): void;
  readonly state: PlayerState;
  readonly error?: string;
}

/**
 * No-audio implementation. play() immediately reports UNSUPPORTED with a
 * pointer to the web player; pause() is a no-op. The statusline keeps working;
 * only the audio glyph shows ⚠.
 */
export class NoAudioStreamPlayer implements StreamPlayer {
  readonly error: string =
    "this build has no audio backend; open https://anomaly.fm in a browser to listen";

  async play(): Promise<void> {
    // Nothing to do — state is terminal. Resolves immediately.
  }

  pause(): void {
    // No-op: there is never audio to pause.
  }

  get state(): PlayerState {
    return "UNSUPPORTED";
  }
}
