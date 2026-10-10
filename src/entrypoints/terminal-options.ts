// Some terminals print the reply to Ink's Kitty support query into the UI.
export const interactiveInkOptions = {
  kittyKeyboard: { mode: process.platform === "linux" ? "disabled" : "auto" },
  exitOnCtrlC: false,
} as const;
