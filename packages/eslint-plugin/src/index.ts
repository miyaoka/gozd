import noDefineExpose from "./rules/noDefineExpose";
import noIconifyClass from "./rules/noIconifyClass";
import noRawTailwindPalette from "./rules/noRawTailwindPalette";

const plugin = {
  rules: {
    "no-define-expose": noDefineExpose,
    "no-iconify-class": noIconifyClass,
    "no-raw-tailwind-palette": noRawTailwindPalette,
  },
};

export default plugin;
