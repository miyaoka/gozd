import { describe, expect, test } from "bun:test";
import { computed, nextTick, ref } from "vue";
import { nextPosition, useListNavigation } from "./useListNavigation";

describe("nextPosition", () => {
  test("選択が候補から外れていたら先頭へ戻す", () => {
    expect(nextPosition(-1, 1, 5, true)).toBe(0);
    expect(nextPosition(-1, -1, 5, false)).toBe(0);
  });

  test("途中では wrap の有無に関わらず 1 つ進む / 戻る", () => {
    expect(nextPosition(2, 1, 5, true)).toBe(3);
    expect(nextPosition(2, 1, 5, false)).toBe(3);
    expect(nextPosition(2, -1, 5, true)).toBe(1);
    expect(nextPosition(2, -1, 5, false)).toBe(1);
  });

  test("wrap ありは端で回り込む", () => {
    expect(nextPosition(4, 1, 5, true)).toBe(0);
    expect(nextPosition(0, -1, 5, true)).toBe(4);
  });

  // 継ぎ足しで伸びる一覧では下端は終端ではない。回り込むと先頭へ飛ばされる
  test("wrap なしは端でクランプする", () => {
    expect(nextPosition(4, 1, 5, false)).toBe(4);
    expect(nextPosition(0, -1, 5, false)).toBe(0);
  });

  test("要素 1 個ならどちらでもその場に留まる", () => {
    expect(nextPosition(0, 1, 1, true)).toBe(0);
    expect(nextPosition(0, 1, 1, false)).toBe(0);
  });
});

describe("useListNavigation の範囲外保護", () => {
  function setup(initialCount: number) {
    const count = ref(initialCount);
    const nav = useListNavigation({
      listRef: ref(null),
      itemCount: computed(() => count.value),
    });
    return { nav, count };
  }

  // 範囲外を指したままだと Enter が黙って効かない（選択 item が undefined になる）
  test("一覧が縮んで範囲外になったら先頭へ戻す", async () => {
    const { nav, count } = setup(5);
    nav.reset(4);
    count.value = 2;
    await nextTick();
    expect(nav.selectedIndex.value).toBe(0);
  });

  test("範囲内に収まっていれば動かさない", async () => {
    const { nav, count } = setup(5);
    nav.reset(1);
    count.value = 3;
    await nextTick();
    expect(nav.selectedIndex.value).toBe(1);
  });

  // 0 は「まだ何も選んでいない」位置。空を素通りさせると、次の結果集合でも選択可能だった
  // 場合に前の選択がそのまま残る
  test("空になったら 0 へ戻す", async () => {
    const { nav, count } = setup(5);
    nav.reset(4);
    count.value = 0;
    await nextTick();
    expect(nav.selectedIndex.value).toBe(0);
  });

  // 一覧を空にしてから埋める利用側（検索）は、この経路で次の結果の先頭へスナップする
  test("空を経由すると、次の結果では先頭の選択可能な位置に居る", async () => {
    const { nav, count } = setup(5);
    nav.reset(4);
    count.value = 0;
    await nextTick();
    count.value = 6;
    await nextTick();
    expect(nav.selectedIndex.value).toBe(0);
  });
});

describe("useListNavigation の選択可能保護（separator あり）", () => {
  function setup(indices: number[], count: number) {
    const selectable = ref(indices);
    const itemCount = ref(count);
    const nav = useListNavigation({
      listRef: ref(null),
      itemCount: computed(() => itemCount.value),
      selectableIndices: computed(() => selectable.value),
    });
    return { nav, selectable, itemCount };
  }

  // 範囲チェックだけだと、範囲内のまま選択できない行を指す状態が残る
  test("範囲内でも選択可能でなくなったら先頭へ戻す", async () => {
    const { nav, selectable } = setup([1, 2, 3], 4);
    nav.reset(3);
    selectable.value = [1, 2];
    await nextTick();
    expect(nav.selectedIndex.value).toBe(1);
  });

  test("選択可能なままなら動かさない", async () => {
    const { nav, selectable } = setup([1, 2, 3], 4);
    nav.reset(2);
    selectable.value = [1, 2];
    await nextTick();
    expect(nav.selectedIndex.value).toBe(2);
  });

  test("選択可能が空になったら 0 へ戻す", async () => {
    const { nav, selectable } = setup([1, 2], 3);
    nav.reset(2);
    selectable.value = [];
    await nextTick();
    expect(nav.selectedIndex.value).toBe(0);
  });

  // 検索は結果を空にしてから埋める。先頭行が selectable 外（file ヘッダ）でも先頭マッチへ寄る
  test("空を経由した後、先頭が選択可能でなければ最初の選択可能な位置へ寄る", async () => {
    const { nav, selectable } = setup([1, 2], 3);
    nav.reset(2);
    selectable.value = [];
    await nextTick();
    selectable.value = [1, 2, 4, 5];
    await nextTick();
    expect(nav.selectedIndex.value).toBe(1);
  });
});
