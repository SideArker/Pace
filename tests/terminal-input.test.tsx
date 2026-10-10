import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { expect, it } from "vitest";
import { HeaderLogo } from "../src/components/Header.js";
import { interactiveInkOptions } from "../src/entrypoints/terminal-options.js";

it("renders the Linux logo without querying unsupported Kitty keyboard mode", async () => {
  class Output extends Writable {
    isTTY = true;
    columns = 80;
    rows = 24;
    writes: string[] = [];
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
      this.writes.push(chunk.toString());
      done();
    }
  }
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new Output();
  const instance = render(<HeaderLogo width={80} />, {
    stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false, alternateScreen: false,
    ...interactiveInkOptions,
  });
  try {
    await instance.waitUntilRenderFlush();
    const output = stdout.writes.join("");
    expect(output).toContain("██████");
    expect(output).not.toContain("\x1b[?u");
    expect(output).not.toContain("\x1b[?0u");
  } finally { instance.unmount(); }
});
