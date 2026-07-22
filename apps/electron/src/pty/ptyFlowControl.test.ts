// flow control の watermark 状態機械の単体テスト。pause / resume は fake で受け、
// edge-triggered（閾値を跨いだ瞬間に 1 度だけ発火）であることを呼び出し回数で検証する。

import { describe, expect, test } from "bun:test";
import { createFlowController, HIGH_WATERMARK_CHARS, LOW_WATERMARK_CHARS } from "./ptyFlowControl";

function setup() {
  const calls: string[] = [];
  const fc = createFlowController(
    () => calls.push("pause"),
    () => calls.push("resume"),
  );
  return { fc, calls };
}

describe("ptyFlowControl", () => {
  test("High 以下では pause しない", () => {
    const { fc, calls } = setup();
    fc.onSent(HIGH_WATERMARK_CHARS); // ちょうど High は「超えて」いないので pause しない
    expect(calls).toEqual([]);
  });

  test("High を超えたら 1 度だけ pause する", () => {
    const { fc, calls } = setup();
    fc.onSent(HIGH_WATERMARK_CHARS + 1);
    fc.onSent(1000); // 既に paused なので再 pause しない
    expect(calls).toEqual(["pause"]);
  });

  test("ack で Low 未満に落ちたら 1 度だけ resume する", () => {
    const { fc, calls } = setup();
    fc.onSent(HIGH_WATERMARK_CHARS + 1); // pause
    // Low 以上残る分だけ ack しても resume しない
    fc.onAck(HIGH_WATERMARK_CHARS + 1 - LOW_WATERMARK_CHARS);
    expect(calls).toEqual(["pause"]);
    // さらに ack して Low 未満へ
    fc.onAck(1);
    expect(calls).toEqual(["pause", "resume"]);
  });

  test("paused でない時の ack では resume しない", () => {
    const { fc, calls } = setup();
    fc.onSent(LOW_WATERMARK_CHARS); // pause していない
    fc.onAck(LOW_WATERMARK_CHARS);
    expect(calls).toEqual([]);
  });

  test("未 ack は 0 未満にならない（過剰 ack を吸収）", () => {
    const { fc, calls } = setup();
    fc.onSent(HIGH_WATERMARK_CHARS + 1); // pause
    fc.onAck(HIGH_WATERMARK_CHARS * 10); // 過剰 ack。未 ack は 0 に clamp され resume
    expect(calls).toEqual(["pause", "resume"]);
    // 0 から再度 High 超まで積めば再び pause できる（clamp が壊れていないこと）
    fc.onSent(HIGH_WATERMARK_CHARS + 1);
    expect(calls).toEqual(["pause", "resume", "pause"]);
  });
});
