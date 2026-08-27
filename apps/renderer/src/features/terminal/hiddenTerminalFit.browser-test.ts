import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";

/**
 * 表示されていない端末に寸法の自動調整を掛けてはいけない、という契約の根拠を固定する。
 *
 * 自動調整は容器の解決済みスタイルから寸法を導く。表示されていない要素では百分率が数値として
 * そのまま読まれるため、提案される寸法は実寸と無関係な極端に小さい値になる。その値は PTY にも
 * 伝わるため、掛けた時点で動いているプログラムの出力幅が壊れる。
 *
 * ここが落ちたら端末実装側の測定戦略が変わった合図で、XtermTerminal の起動時の分岐と
 * docs/terminal.md の契約を見直す。
 */
test("表示されていない端末は実寸とかけ離れた寸法を提案する", () => {
  const outer = document.createElement("div");
  outer.style.width = "800px";
  outer.style.height = "600px";
  document.body.appendChild(outer);

  // 実運用と同じ入れ子。容器は親いっぱいに広がる指定を持つ
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  outer.appendChild(container);

  const term = new Terminal();
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  const visible = fit.proposeDimensions();
  expect(visible?.cols).toBeGreaterThan(40);

  // 表示を落とす（レイアウト上の寸法が失われる）
  outer.style.display = "none";
  expect(container.clientWidth).toBe(0);

  // 提案は undefined にならず、百分率が px として読まれた極小の値になる
  const hidden = fit.proposeDimensions();
  expect(hidden).toBeDefined();
  expect(hidden?.cols).toBeLessThan(20);

  // 自動調整を掛けると端末自身がその寸法まで縮む（PTY へも伝わる値）
  fit.fit();
  expect(term.cols).toBe(hidden?.cols ?? 0);

  term.dispose();
  outer.remove();
});
