/**
 * ratio ベースのドラッグリサイズを管理する composable。
 * split tree の branch ノード間に配置するハンドル用。
 */
import { useEventListener } from "@vueuse/core";
import { ref } from "vue";
import type { Ref, ShallowRef } from "vue";
import type { Axis, SplitNode } from "./splitTree";
import { getMinSize } from "./splitTree";

interface UseSplitResizeOptions {
  axis: Axis;
  firstNode: Ref<SplitNode>;
  secondNode: Ref<SplitNode>;
  ratio: Ref<number>;
  /** branch の主軸方向のコンテンツサイズ（gap 除く px） */
  availablePx: Ref<number>;
  onUpdate: (newRatio: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function useSplitResize(
  handleRef: Readonly<ShallowRef<HTMLElement | null>>,
  options: UseSplitResizeOptions,
) {
  const isDragging = ref(false);

  useEventListener(handleRef, "mousedown", (e: MouseEvent) => {
    e.preventDefault();
    isDragging.value = true;
    options.onDragStart?.();

    const isHorizontal = options.axis === "horizontal";
    const availablePx = options.availablePx.value;
    const startPos = isHorizontal ? e.clientX : e.clientY;
    const startRatio = options.ratio.value;

    const cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    const firstMin = getMinSize(options.firstNode.value, options.axis);
    const secondMin = getMinSize(options.secondNode.value, options.axis);

    const minRatio = availablePx > 0 ? firstMin / availablePx : 0;
    const maxRatio = availablePx > 0 ? 1 - secondMin / availablePx : 1;

    const cleanupMove = useEventListener(document, "mousemove", (moveEvent: MouseEvent) => {
      const currentPos = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
      const deltaPx = currentPos - startPos;
      const deltaRatio = availablePx > 0 ? deltaPx / availablePx : 0;
      const newRatio = Math.max(minRatio, Math.min(maxRatio, startRatio + deltaRatio));
      options.onUpdate(newRatio);
    });

    useEventListener(
      document,
      "mouseup",
      () => {
        isDragging.value = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupMove();
        options.onDragEnd?.();
      },
      { once: true },
    );
  });

  return { isDragging };
}
