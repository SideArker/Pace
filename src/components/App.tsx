import React from "react";
import { AppView } from "./app/AppView.js";
import { useAppController } from "./app/useAppController.js";

export { commands, isRegisteredCommand, commandArguments, skillArguments, normalizeNewCommand } from "./app/commands.js";

export default function App({ onClear }: { onClear: () => void }) {
  const model = useAppController(onClear);
  return <AppView model={model} />;
}
