import noDefineExpose from "./rules/noDefineExpose";
import noRawTailwindPalette from "./rules/noRawTailwindPalette";

const plugin = {
  rules: {
    "no-define-expose": noDefineExpose,
    "no-raw-tailwind-palette": noRawTailwindPalette,
  },
};

export default plugin;
