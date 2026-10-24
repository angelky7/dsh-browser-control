// 校验仓库所有 Markdown / txt 里的 release 下载链接，对照 GitHub Releases 资产清单。
// Node 的 fetch 不走代理，所以资产清单先自己抓一份再喂进来：
//   curl -s https://api.github.com/repos/angelky7/dsh-browser-control/releases?per_page=100 -o releases.json
//   node verify/verify_release_links.mjs releases.json
import { readFile, readdir } from "node:fs/promises";

const snapshot = process.argv[2] ?? "releases.json";
const releases = JSON.parse(await readFile(snapshot, "utf8"));
if (!Array.isArray(releases)) throw new Error(`${snapshot} 不是一个 release 数组`);
const valid = new Set(releases.flatMap((r) => (r.assets ?? []).map((a) => `${r.tag_name}/${a.name}`)));

const files = [];
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "verify") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p);
    else if (/\.(md|txt)$/i.test(e.name)) files.push(p);
  }
};
await walk(".");

let bad = 0;
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const m of text.matchAll(/releases\/download\/([^/]+)\/([^\s)\]"'`]+)/g)) {
    const key = `${m[1]}/${m[2]}`;
    const ok = valid.has(key);
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "DEAD"} ${key}   <- ${file}`);
  }
}
console.log(`\n扫描文档 ${files.length} 个，死链 ${bad} 条`);
if (bad > 0) process.exit(1);
