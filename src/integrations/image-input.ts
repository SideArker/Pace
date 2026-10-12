import { artifactPrompt } from "../core/system/artifacts.js";

const imageMarker = /\[Pace image: ([^\]\n]+\.(?:png|jpg|gif|webp))\]/g;

export function turnImageInput(prompt: string, mode: "main" | "side", artifactDirectory?: string) {
  if (mode === "side") return [{ type: "text" as const, text: prompt }];
  const currentPrompt = prompt.split("\n\nCurrent user request:\n").at(-1)!;
  const images = [...new Set([...currentPrompt.matchAll(imageMarker)].map(match => match[1]!))];
  return [
    { type: "text" as const, text: artifactPrompt(prompt, artifactDirectory) },
    ...images.map(path => ({ type: "localImage" as const, path })),
  ];
}
