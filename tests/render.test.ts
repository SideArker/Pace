import { describe, expect, it } from "vitest";
import React from "react";
import { Header } from "../src/components/Transcript.js";

describe("Header component", () => {
  it("creates React element without error", () => {
    const el = React.createElement(Header, {
      project: process.cwd(),
      vexState: "connected",
      width: 80,
    });
    expect(el).toBeDefined();
    expect(el.props.project).toBe(process.cwd());
    expect(el.props.vexState).toBe("connected");
  });

  it("handles responsive narrow widths", () => {
    const narrow = React.createElement(Header, {
      project: "/some/path/my-project",
      vexState: "connecting",
      width: 30,
    });
    expect(narrow).toBeDefined();

    const tiny = React.createElement(Header, {
      project: "/some/path/my-project",
      vexState: "failed",
      width: 15,
    });
    expect(tiny).toBeDefined();
  });
});
