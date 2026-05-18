import { defineComponent, h, type PropType } from "vue";
import type { CommitMessageSegment } from "./linkifyCommitMessage";

/** `linkifyCommitMessage` の戻り値 (`CommitMessageSegment[]`) を render する dumb component。
 *
 * SFC ではなく render function (`h()`) で書くのは、SFC template に書いた改行・インデントが
 * Vue compiler 経由で text node 化して preformatted 親要素 (`<pre white-space:pre-wrap>`) 配下の
 * commit body の whitespace を壊すリスクを構造的に消すため。`h()` は VNode を直接組み立てるため
 * source の整形に関係なく余分な text node が混入しない。
 *
 * `<a>` の class / title / rel / target / `@click.stop` の組み合わせは renderer 内で 1 箇所に
 * 集約 (SSOT)。利用側 (GitGraphPane の commit row / CommitDetailPane の subject + body) は
 * `<CommitSegmentList :segments="...">` を呼ぶだけで、`a` の attribute 揃え漏れが起きない。 */
export default defineComponent({
  name: "CommitSegmentList",
  props: {
    segments: {
      type: Array as PropType<CommitMessageSegment[]>,
      required: true,
    },
  },
  setup(props) {
    return () =>
      props.segments.map((seg) => {
        if (seg.type === "issue") {
          return h(
            "a",
            {
              href: seg.href,
              target: "_blank",
              rel: "noopener noreferrer",
              class: "text-blue-400 hover:underline",
              title: `Open ${seg.value} on GitHub`,
              // 行クリック (commit 選択) の伝播を止めて、リンクだけを発火させる
              onClick: (e: MouseEvent) => e.stopPropagation(),
            },
            seg.value,
          );
        }
        return seg.value;
      });
  },
});
