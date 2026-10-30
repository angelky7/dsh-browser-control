// Cookie 三条命令的台：get 归一化/过滤、set 字段透传与锚点校验、remove 的复查语义。
//
// 为什么单独一台：cookie 的值是凭据，「模型能看到什么」由 render 契约管（verify_render_contract），
// 这里管的是**行为**——CDP 参数真的按工具面传进来的那样发出、浏览器拒绝时如实报错、
// 删除后按同一片可见范围复查而不是假装删干净了。
//
// 用法：node verify/verify_cookies.mjs
//   node verify/verify_cookies.mjs ../../old/background.js   # 对未实现版本判红
import { bootBackground, makeModel } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const errOf = (p) => p.then(() => null, (e) => String(e?.message ?? e));

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

/**
 * 一台有状态的假 cookie 存储：get 按请求的 urls 过滤可见域，set 按 Chrome 的常见拒绝
 * 规则（Secure 配非 https 锚点）返回 success:false，delete 真删。
 */
function installCookieStore(model, store) {
  const visible = (urls) => {
    const hosts = (urls ?? []).map(hostOf);
    return store.filter((c) => hosts.some((h) => c.domain === h || c.domain === `.${h}` || h.endsWith(c.domain.replace(/^\./, ""))));
  };
  // 假件按**真 CDP 的响应形状**回：Network.getCookies 的 cookies 在顶层，
  // Network.setCookie 回 {success}——别套 Runtime.evaluate 那种 {result:{value}} 信封。
  model.dbg.results["Network.getCookies"] = (params) => ({ cookies: visible(params?.urls) });
  model.dbg.results["Network.setCookie"] = (params) => {
    if (params?.secure === true && !String(params.url ?? "https://x/").startsWith("https")) {
      return { success: false };
    }
    const domain = params.domain
      ? String(params.domain).replace(/^\./, "")
      : hostOf(params.url);
    const at = store.findIndex((c) => c.name === params.name && c.domain === domain);
    if (at >= 0) store.splice(at, 1);
    store.push({
      name: params.name, value: params.value, domain, path: params.path ?? "/",
      expires: params.expires ?? -1, size: String(params.name).length + String(params.value).length,
      httpOnly: params.httpOnly === true, secure: params.secure === true, ...(params.sameSite ? { sameSite: params.sameSite } : {}),
    });
    return { success: true };
  };
  model.dbg.results["Network.deleteCookies"] = (params) => {
    const at = store.findIndex((c) => c.name === params.name
      && (!params.domain || c.domain.replace(/^\./, "") === String(params.domain).replace(/^\./, ""))
      && (!params.path || c.path === params.path));
    if (at >= 0) store.splice(at, 1);
    return {};
  };
  model.dbg.results["Network.enable"] = () => ({});
  return store;
}

const sent = (model, method) => model.dbg.log.filter((e) => e.method === method);

async function boot({ store = [], storage } = {}) {
  const model = makeModel();
  model.addTab(1, "https://shop.test/");
  const s = installCookieStore(model, store);
  const opts = {};
  if (CANDIDATE) opts.backgroundPath = CANDIDATE;
  if (storage) opts.storage = storage;
  const { ctx } = await bootBackground({ model, ...opts });
  return { ctx, model, store: s };
}

// ---- 1) get：归一化、排序、值原样带回；可见范围由 CDP 决定（count===total）----
{
  const { ctx } = await boot({ store: [
    { name: "tz", value: "Asia%2FShanghai", domain: ".shop.test", path: "/", expires: -1, size: 16, httpOnly: false, secure: false },
    { name: "sid", value: "s.3cr3t", domain: "shop.test", path: "/", expires: 4102444800, size: 10, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "other", value: "x", domain: "ads.example", path: "/", expires: -1, size: 6, httpOnly: false, secure: false },
  ] });
  const res = await ctx.runCommand("cookies.get", {});
  // CDP 按 urls 取「这页可见的」cookie：别的域根本不在回包里，所以 count===total。
  // total 单独存在是为了「将来按浏览器级查询」时不改形状。
  check("get：只回本页可见域的 cookie（别的域不混进来）", res?.count === 2 && res?.total === 2, JSON.stringify({ count: res?.count, total: res?.total }));
  check("get：按名字排序（输出稳定，模型好引用）", res?.cookies?.[0]?.name === "sid" && res?.cookies?.[1]?.name === "tz",
    JSON.stringify(res?.cookies?.map((c) => c.name)));
  const sid = res?.cookies?.[0];
  check("get：值原样带回（复制登录态靠它）", sid?.value === "s.3cr3t", JSON.stringify(sid?.value));
  check("get：字段归一（httpOnly/secure 布尔、sameSite 保留）",
    sid?.httpOnly === true && sid?.secure === true && sid?.sameSite === "Lax", JSON.stringify(sid));
  check("get：会话 cookie 的 expires 归一成 -1", res?.cookies?.[1]?.expires === -1, JSON.stringify(res?.cookies?.[1]?.expires));
  const filtered = await ctx.runCommand("cookies.get", { domain: "NOPE" });
  check("get：domain 过滤大小写不敏感（不匹配就是 0 条）", filtered?.count === 0, String(filtered?.count));
  const both = await ctx.runCommand("cookies.get", { domain: "shop.test" });
  check("get：domain 过滤同时命中 host-only 与 dot 域", both?.count === 2, String(both?.count));
}

// ---- 2) set：字段透传 + 结果形状 ----
{
  const { ctx, model, store } = await boot();
  const res = await ctx.runCommand("cookies.set", {
    name: "sid", value: "v1", url: "https://shop.test/", path: "/",
    secure: true, httpOnly: true, sameSite: "Lax", expires: 4102444800,
  });
  check("set：成功回执如实回显（url 锚点不冒充 domain——domain 是 Chrome 算的，工具没去猜）",
    res?.set === true && res?.cookie?.name === "sid" && res?.cookie?.url === "https://shop.test/" && res?.cookie?.domain === undefined,
    JSON.stringify(res));
  const call = sent(model, "Network.setCookie").at(-1)?.params;
  check("set：CDP 参数按工具面透传（布尔、sameSite、expires 都在）",
    call?.name === "sid" && call?.value === "v1" && call?.secure === true && call?.httpOnly === true
    && call?.sameSite === "Lax" && call?.expires === 4102444800, JSON.stringify(call));
  check("set：之后 get 看得到它", (await ctx.runCommand("cookies.get", {}))?.count === 1
    && store[0]?.value === "v1");
}

// ---- 3) set 的校验与浏览器的拒绝 ----
{
  const { ctx, model } = await boot();
  const noAnchor = await errOf(ctx.runCommand("cookies.set", { name: "a", value: "b" }));
  check("set：没有 url/domain 锚点 → 报错且一次 CDP 都不发",
    noAnchor !== null && /锚点|anchor|url|domain/i.test(noAnchor) && sent(model, "Network.setCookie").length === 0, String(noAnchor)?.slice(0, 80));
  const noValue = await errOf(ctx.runCommand("cookies.set", { name: "a", url: "https://shop.test/" }));
  check("set：缺 value → 报错（清空要传空字符串）", noValue !== null && /value/.test(noValue), String(noValue)?.slice(0, 70));
  const badSameSite = await errOf(ctx.runCommand("cookies.set", { name: "a", value: "b", url: "https://shop.test/", sameSite: "maybe" }));
  check("set：sameSite 非法 → 报错并给出合法清单", badSameSite !== null && /Strict, Lax, None/.test(badSameSite), String(badSameSite)?.slice(0, 70));
  const rejected = await errOf(ctx.runCommand("cookies.set", { name: "a", value: "b", url: "http://shop.test/", secure: true }));
  check("set：浏览器拒绝（Secure 配 http 锚点）→ 如实报错而不是 pressed:true 式的假成功",
    rejected !== null && /被浏览器拒绝/.test(rejected), String(rejected)?.slice(0, 80));
}

// ---- 4) remove：真删 + 复查 remaining ----
{
  const store = [
    { name: "sid", value: "v", domain: "shop.test", path: "/", expires: -1, size: 6, httpOnly: false, secure: false },
  ];
  const { ctx } = await boot({ store });
  const res = await ctx.runCommand("cookies.remove", { name: "sid", url: "https://shop.test/" });
  check("remove：回执 removed=true", res?.removed === true, JSON.stringify(res));
  check("remove：按同一片可见范围复查（remaining=0 才是删干净）", res?.remaining === 0, JSON.stringify(res?.remaining));
  check("remove：复查的 urls 与删除的锚点一致", res?.checkedUrl === "https://shop.test/", JSON.stringify(res?.checkedUrl));
}

// ---- 5) remove 没删干净时如实报 remaining（CDP 不回执，不复查就是装） ----
{
  const { ctx, model } = await boot({ store: [
    { name: "sid", value: "v", domain: "shop.test", path: "/", expires: -1, size: 6, httpOnly: false, secure: false },
    { name: "sid", value: "v2", domain: ".shop.test", path: "/", expires: -1, size: 6, httpOnly: false, secure: false },
  ] });
  // 只删 host-only 那颗：domain 精确匹配 shop.test，剩下 .shop.test 那颗还在
  const res = await ctx.runCommand("cookies.remove", { name: "sid", domain: "shop.test" });
  check("remove：同名多颗时只删匹配锚点的那颗", res?.removed === true && res?.remaining === 1,
    JSON.stringify(res));
  check("remove：remaining 里写明还剩哪颗（在哪个域上）", Array.isArray(res?.left) && res.left[0] === ".shop.test",
    JSON.stringify(res?.left));
  const miss = sent(model, "Network.deleteCookies").at(-1)?.params;
  check("remove：CDP 参数带上了精确 domain（不靠「删了再说」）", miss?.domain === "shop.test", JSON.stringify(miss));
}

// ---- 6) 复查失败时如实说 remainingChecked:false，不假装删干净 ----
{
  const { ctx, model } = await boot({ store: [] });
  model.dbg.results["Network.getCookies"] = () => { throw new Error("storage busy"); };
  const res = await ctx.runCommand("cookies.remove", { name: "gone", url: "https://shop.test/" });
  check("remove：复查失败 → remainingChecked=false（不是 remaining=0）", res?.removed === true && res?.remainingChecked === false,
    JSON.stringify(res));
}

console.log(fails === 0 ? "\nCookie 三条命令全部符合契约" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
