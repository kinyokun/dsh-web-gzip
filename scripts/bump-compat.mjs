#!/usr/bin/env node
/** 更新兼容基线：node scripts/bump-compat.mjs <version> */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/bump-compat.mjs <version>");
  process.exit(1);
}
const file = fileURLToPath(new URL("../.dsh-compat.json", import.meta.url));
const data = JSON.parse(readFileSync(file, "utf8"));
data.testedVersion = version;
data.testedAt = new Date().toISOString().slice(0, 10);
writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
console.log(`compat baseline -> ${version} (${data.testedAt})`);
