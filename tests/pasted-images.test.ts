import { expect, it } from "vitest";
import { imageExtension } from "../src/components/pasted-images.js";
import { turnImageInput } from "../src/integrations/image-input.js";

it("recognizes clipboard image signatures", () => {
  expect(imageExtension(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("png");
  expect(imageExtension(Buffer.from([255, 216, 255]))).toBe("jpg");
  expect(imageExtension(Buffer.from("GIF89a"))).toBe("gif");
  expect(imageExtension(Buffer.concat([Buffer.from("RIFF0000WEBP")]))).toBe("webp");
  expect(imageExtension(Buffer.from("plain text"))).toBeUndefined();
});

it("attaches every pasted image to main turns only", () => {
  const prompt = "Compare [Pace image: /project/.pace/pasted-images/a.png] and [Pace image: /project/.pace/pasted-images/b.jpg]";
  expect(turnImageInput(prompt, "main").slice(1)).toEqual([
    { type: "localImage", path: "/project/.pace/pasted-images/a.png" },
    { type: "localImage", path: "/project/.pace/pasted-images/b.jpg" },
  ]);
  expect(turnImageInput(prompt, "side")).toEqual([{ type: "text", text: prompt }]);
  const restored = `Retained conversation:\n[{"user":"[Pace image: /project/.pace/pasted-images/old.png]"}]\n\nCurrent user request:\n${prompt}`;
  expect(turnImageInput(restored, "main").slice(1)).toHaveLength(2);
});
