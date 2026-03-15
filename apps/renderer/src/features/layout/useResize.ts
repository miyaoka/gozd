import { useEventListener } from "@vueuse/core";
import { ref } from "vue";
import type { Ref, ShallowRef } from "vue";

type Direction = "horizontal" | "vertical";

interface UseResizeOptions {
  direction: Direction;
  /** 左（上）ペインの最小サイズ（px） */
  beforeMinSize: number;
  /** 右（下）ペインの最小サイズ（px） */
  afterMinSize: number;
  /** ドラッグ開始時の左（上）ペインサイズを取得する関数。DOM 実測幅が必要な場合に使う */
  getBeforeSize?: () => number;
  /** ドラッグ開始時の右（下）ペインサイズを取得する関数。DOM 実測幅が必要な場合に使う */
  getAfterSize?: () => number;
}

/**
 * ドラッグによるペインリサイズを管理する composable。
 * ハンドルの左右（上下）のペインサイズを連動して増減する。
 * delta 分を一方に加え、他方から引くことで他のペインに影響を与えない。
 *
 * beforeSize / afterSize の値が undefined の場合（親がモデルをバインドしていない場合）、
 * そのペインの ref は更新しない。getBeforeSize / getAfterSize で開始サイズだけ取得する。
 */
export function useResize(
  handleRef: Readonly<ShallowRef<HTMLElement | null>>,
  beforeSize: Ref<number | undefined>,
  afterSize: Ref<number | undefined>,
  options: UseResizeOptions,
) {
  const isDragging = ref(false);

  // 親がモデルをバインドしているかを初期値で判定
  const shouldWriteBefore = beforeSize.value !== undefined;
  const shouldWriteAfter = afterSize.value !== undefined;

  let startPos = 0;
  let startBeforeSize = 0;
  let startAfterSize = 0;

  const readBeforeSize = () => options.getBeforeSize?.() ?? beforeSize.value ?? 0;
  const readAfterSize = () => options.getAfterSize?.() ?? afterSize.value ?? 0;

  // ハンドル要素の mousedown を常時監視
  useEventListener(handleRef, "mousedown", (e: MouseEvent) => {
    e.preventDefault();
    isDragging.value = true;
    startPos = options.direction === "horizontal" ? e.clientX : e.clientY;
    startBeforeSize = readBeforeSize();
    startAfterSize = readAfterSize();

    const cursor = options.direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    // ドラッグ中のみ mousemove を登録
    const cleanupMove = useEventListener(document, "mousemove", (moveEvent: MouseEvent) => {
      const rawDelta =
        options.direction === "horizontal"
          ? moveEvent.clientX - startPos
          : moveEvent.clientY - startPos;

      // 両ペインの最小サイズを尊重して delta をクランプ
      const maxExpand = startAfterSize - options.afterMinSize;
      const maxShrink = startBeforeSize - options.beforeMinSize;
      const delta = Math.max(-maxShrink, Math.min(maxExpand, rawDelta));

      if (shouldWriteBefore) beforeSize.value = startBeforeSize + delta;
      if (shouldWriteAfter) afterSize.value = startAfterSize - delta;
    });

    // mouseup: once で自動解除、mousemove も解除する
    useEventListener(
      document,
      "mouseup",
      () => {
        isDragging.value = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupMove();
      },
      { once: true },
    );
  });

  return {
    isDragging,
  };
}
