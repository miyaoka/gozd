import { defineComponent, h, type PropType } from "vue";
import { activateExternalLink } from "../github-item";
import type { CommitMessageSegment } from "./linkifyCommitMessage";

/** `linkifyCommitMessage` の戻り値 (`CommitMessageSegment[]`) を render する dumb component。
 *
 * SFC ではなく render function (`h()`) で書くのは、SFC template に書いた改行・インデントが
 * Vue compiler 経由で text node 化して preformatted 親要素 (`<pre white-space:pre-wrap>`) 配下の
 * commit body の whitespace を壊すリスクを構造的に消すため。`h()` は VNode を直接組み立てるため
 * source の整形に関係なく余分な text node が混入しない。
 *
 * commit message 中の issue リンクの `a` は本 component だけが組み立てる。利用側
 * (GitGraphPane の commit row / CommitDetailPane の subject + body) は
 * `<CommitSegmentList :segments="...">` を呼ぶだけで、`a` の attribute 揃え漏れが起きない。
 *
 * `href` は付けるが遷移させない。OS への受け渡しは `activateExternalLink` が担う。それでも
 * href を外さないのは、a[href] のリンク意味論 (キーボードフォーカス到達、Enter による起動、
 * 支援技術への link としての露出、UA の cursor: pointer) が同時に落ちるため。 */
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
              class: "text-primary-text hover:underline",
              title: `Open ${seg.value} on GitHub`,
              onClick: (e: MouseEvent) => activateExternalLink(e, seg.href),
              onAuxclick: (e: MouseEvent) => activateExternalLink(e, seg.href),
            },
            seg.value,
          );
        }
        return seg.value;
      });
  },
});
