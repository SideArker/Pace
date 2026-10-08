#!/usr/bin/env node
import { ensureLocalBinInPath } from "../core/system/keys.js";

process.env.NODE_ENV = process.env.NODE_ENV || "production";
ensureLocalBinInPath();

await import("./cli-app.js");

