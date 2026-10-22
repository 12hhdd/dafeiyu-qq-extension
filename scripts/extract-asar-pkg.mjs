/**
 * 从 Electron asar 里抽出一个包到目标目录（用于在本机复现 DSH 运行时依赖，
 * 例如 @deepseek-ai/dsh-home-paths 只存在于 app.asar 内，profile 的
 * node_modules 里没有，所以单独 import 插件模块会 ERR_MODULE_NOT_FOUND）。
 *
 * 用法：node extract-asar-pkg.mjs <asarPath> <entryPrefix> <destDir>
 * 例：  node extract-asar-pkg.mjs D:/deepseek/resources/app.asar \
 *         dsh/node_modules/@deepseek-ai/dsh-home-paths ./tmp/dsh-home-paths
 */
import fs from "node:fs";
import path from "node:path";

const [asarPath, entryPrefix, destDir] = process.argv.slice(2);
if (!asarPath || !entryPrefix || !destDir) {
  console.error("用法: node extract-asar-pkg.mjs <asarPath> <entryPrefix> <destDir>");
  process.exit(2);
}

const buf = fs.readFileSync(asarPath);

// asar = [uint32 4][uint32 headerPickleSize][uint32 headerStringSize+?][uint32 jsonLen] <json> <data>
const headerJsonLen = buf.readUInt32LE(12);
const headerJson = buf.toString("utf8", 16, 16 + headerJsonLen);
const header = JSON.parse(headerJson);

// 数据区起点：16 + jsonLen，再按 4 字节对齐
let dataOffset = 16 + headerJsonLen;
if (dataOffset % 4 !== 0) dataOffset += 4 - (dataOffset % 4);

function getNode(p) {
  const parts = p.split("/").filter(Boolean);
  let cur = header;
  for (const seg of parts) {
    if (!cur.files) return null;
    cur = cur.files[seg];
    if (!cur) return null;
  }
  return cur;
}

const root = getNode(entryPrefix);
if (!root) {
  console.error(`✗ asar 里找不到 ${entryPrefix}`);
  process.exit(1);
}

let count = 0;
function walk(node, rel) {
  if (!node.files) return;
  for (const name of Object.keys(node.files)) {
    const child = node.files[name];
    const childRel = rel ? `${rel}/${name}` : name;
    if (child.files) {
      walk(child, childRel);
      continue;
    }
    const outPath = path.join(destDir, childRel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const start = dataOffset + Number(child.offset);
    fs.writeFileSync(outPath, buf.subarray(start, start + Number(child.size)));
    count++;
  }
}
walk(root, "");
console.log(`✓ 抽出 ${count} 个文件 → ${destDir}`);
