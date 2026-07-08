// pty host → main の onData backpressure。MB/s 規模の出力を IPC で溢れさせないため、
// 未 ack 文字数の watermark で pty を pause / resume する（VS Code FlowControlConstants と同値）。
//
// ptyHost の process entry から node-pty を切り離してこの算術だけを単体テストできるよう、
// pause / resume を注入する純関数に分離する。pause / resume は閾値を跨いだ瞬間に 1 度だけ
// 呼ぶ edge-triggered 契約（毎データ pause を呼ぶと node-pty に無駄な syscall が飛ぶ）。

/** 未 ack がこの文字数を超えたら pause する（client が追いつくのを待つ） */
export const HIGH_WATERMARK_CHARS = 100_000;
/** pause 後、未 ack がこの文字数を下回ったら resume する */
export const LOW_WATERMARK_CHARS = 5_000;

export interface FlowController {
  /** host → main へ chars 文字送った。HIGH 超で初めて pause() を呼ぶ */
  onSent(chars: number): void;
  /** main が chars 文字を ack した。LOW 未満に落ちて初めて resume() を呼ぶ */
  onAck(chars: number): void;
}

export function createFlowController(pause: () => void, resume: () => void): FlowController {
  let unackedChars = 0;
  let paused = false;
  return {
    onSent(chars) {
      unackedChars += chars;
      if (!paused && unackedChars > HIGH_WATERMARK_CHARS) {
        paused = true;
        pause();
      }
    },
    onAck(chars) {
      unackedChars = Math.max(unackedChars - chars, 0);
      if (paused && unackedChars < LOW_WATERMARK_CHARS) {
        paused = false;
        resume();
      }
    },
  };
}
