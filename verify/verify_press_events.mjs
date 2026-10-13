// 按键派发计数台：断言「一次按键到底往页面插了几次字符」。
//
// 由来：issue #14（wangyuncai2024）——`browser_press` 的 `cmdPress` 在 `keyDown`
// 已经带 `text` 的情况下**又补发一个独立的 `char` 事件**，Chrome 从两处各插一次：
// 输入框里按一下 `x` 得到 `xx`，按一下 Enter 表单**提交两次**（`browser_type` 的
// `submit:true` 走的也是这条通道）。同一个仓库里这个坑早就在 `cmdInput` 的 type
// 模式修过，注释就写着「an explicit char event duplicates the input」，CHANGELOG
// v1.0.2 也记了一笔——只有 `cmdPress` 没跟上，从 v0.2.0 一直留到 v1.0.15。
//
// 报告方还有一点更扎心但属实：`verify/` 里以前**没有任何一条**按键事件断言，
// 对 `browser_press` 只测了模型可见文本。所以这个台子存在的意义就是把
// 「派发次数」变成被钉住的东西，而不是等下一次有人发现表单被提交两次。
//
// 用法：node verify/verify_press_events.mjs
import { bootBackground } from "./ext_harness.mjs";

// 可以指向另一份 background.js（比如修复前的版本）来跑同一批断言：
// 台子必须对旧代码判红，否则它什么都没钉住。
const CANDIDATE = process.argv[2];


let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/**
 * 起一份扩展代码。`prewarm:false` 时不先焐 CDP 会话（用于「抛错时一个事件都不该发」
 * 这类断言——焐热本身会往 log 里留下 DOM.enable 之类的调用）。
 */
async function boot({ prewarm = true } = {}) {
  const { model, ctx } = await bootBackground(CANDIDATE ? { backgroundPath: CANDIDATE } : {});
  const tabId = model.addTab(1, "https://press.test");
  if (prewarm) {
    await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", {}));
    model.dbg.log.length = 0; // 把焐热会话的调用清掉，只计这一次按键
  }
  return { model, ctx, tabId };
}

const keyEvents = (model) => model.dbg.log
  .filter((e) => e.method === "Input.dispatchKeyEvent")
  .map((e) => e.params ?? {});

/** 会往页面插入字符的事件：带非空 text 的那一个（keyDown 带 text，或独立 char）。 */
const inserting = (events) => events.filter((p) => typeof p.text === "string" && p.text.length > 0);

// ---- 1) 单个可打印字符：只许插入一次 ----
{
  const { model, ctx, tabId } = await boot();
  await ctx.cmdPress({ key: "x", tabId });
  const ev = keyEvents(model);
  const ins = inserting(ev);
  check("press 'x'：只发出 keyDown + keyUp 两个事件", ev.length === 2 &&
    ev[0].type === "keyDown" && ev[1].type === "keyUp",
    ev.map((e) => e.type).join(","));
  check("press 'x'：插入字符的事件恰好 1 个（#14 的双倍插入）", ins.length === 1,
    ins.map((e) => `${e.type}:${JSON.stringify(e.text)}`).join(" | "));
  check("press 'x'：插入发生在 keyDown 的 text 上，且没有独立 char 事件",
    ins[0]?.type === "keyDown" && ins[0]?.text === "x" && !ev.some((e) => e.type === "char"),
    JSON.stringify(ins[0]));
  check("press 'x'：keyCode/code 都算对了",
    ev[0].windowsVirtualKeyCode === 88 && ev[0].code === "KeyX",
    `vk=${ev[0].windowsVirtualKeyCode} code=${ev[0].code}`);
}

// ---- 2) Enter：隐式提交只能有一次 ----
{
  const { model, ctx, tabId } = await boot();
  await ctx.cmdPress({ key: "Enter", tabId });
  const ev = keyEvents(model);
  const ins = inserting(ev);
  check("press Enter：恰好一个带 \\r 的插入事件（表单提交一次）",
    ins.length === 1 && ins[0].text === "\r" && ins[0].type === "keyDown",
    ins.map((e) => `${e.type}:${JSON.stringify(e.text)}`).join(" | "));
  check("press Enter：没有多余的 char 事件", !ev.some((e) => e.type === "char"),
    ev.map((e) => e.type).join(","));
  check("press Enter：keydown 仍在（依赖 keydown 的组件不受影响）",
    ev.some((e) => e.type === "keyDown" && e.code === "Enter"), JSON.stringify(ev[0]));
}

// ---- 3) 数字键 ----
{
  const { model, ctx, tabId } = await boot();
  await ctx.cmdPress({ key: "7", tabId });
  const ev = keyEvents(model);
  check("press '7'：插入一次且 code 是 Digit7",
    inserting(ev).length === 1 && ev[0].code === "Digit7", JSON.stringify(ev[0]));
}

// ---- 4) 把已经正确的 cmdInput type 模式钉住（同一个坑的另一半）----
{
  const { model, ctx, tabId } = await boot();
  // 这个假页面里要有一个能定位、能读回的输入框：定位与读回都走 Runtime.evaluate
  model.dbg.results["Runtime.evaluate"] = (params, m) => {
    const expr = String(params?.expression ?? "");
    if (expr.includes("document.title")) return { result: { value: m.page.title } };
    if (expr.includes("location.href")) return { result: { value: m.page.url } };
    return { result: { value: { tag: "input", value: "abc" } } };
  };
  await ctx.cmdInput({ selector: "#q", value: "abc", mode: "type", tabId });
  const ev = keyEvents(model);
  const ins = inserting(ev);
  check("input type 模式：三个字符恰好三次插入", ins.length === 3,
    ins.map((e) => `${e.type}:${JSON.stringify(e.text)}`).join(" | "));
  check("input type 模式：同样不发独立 char 事件", !ev.some((e) => e.type === "char"),
    ev.map((e) => e.type).join(","));
}

// ---- 5) 组合键：以前 'Shift+ArrowRight' 静默无效，现在要么真发要么明确报错 ----
{
  const { model, ctx, tabId } = await boot();
  await ctx.cmdPress({ key: "Shift+ArrowRight", tabId });
  const ev = keyEvents(model);
  check("press 'Shift+ArrowRight'：解析成 ArrowRight + shift 位",
    ev.length === 2 && ev[0].key === "ArrowRight" && (ev[0].modifiers & 8) === 8,
    JSON.stringify(ev[0]));
  check("press 'Shift+ArrowRight'：组合键不该插入字符", inserting(ev).length === 0,
    JSON.stringify(inserting(ev)));

  const { model: m2, ctx: c2, tabId: t2 } = await boot();
  await c2.cmdPress({ key: "a", modifiers: ["ctrl"], tabId: t2 });
  const ev2 = keyEvents(m2);
  check("press modifiers:['ctrl']：ctrl 位为 2 且不插入",
    (ev2[0].modifiers & 2) === 2 && inserting(ev2).length === 0, JSON.stringify(ev2[0]));

  const { model: m3, ctx: c3, tabId: t3 } = await boot();
  await c3.cmdPress({ key: "b", modifiers: ["shift"], tabId: t3 });
  check("press modifiers:['shift']：shift 单独存在时仍然打字",
    inserting(keyEvents(m3)).length === 1, JSON.stringify(keyEvents(m3)[0]));
}

// ---- 6) 未知键名必须响亮地失败，而不是带着 undefined 静默派发 ----
{
  const { model, ctx, tabId } = await boot({ prewarm: false });
  const err = await ctx.cmdPress({ key: "Nonexistent", tabId }).then(() => null, (e) => String(e.message));
  check("未知键名：抛错而不是静默无效", typeof err === "string" && /unknown key/i.test(err), String(err));
  const dispatched = model.dbg.log.filter((e) => e.method === "Input.dispatchKeyEvent").length;
  check("未知键名：抛错时一个按键事件都不发", dispatched === 0, `派发 ${dispatched} 次`);

  const badMod = await ctx.cmdPress({ key: "Hyper+A", tabId }).then(() => null, (e) => String(e.message));
  check("未知修饰键：报出合法清单", typeof badMod === "string" && /unknown modifier/i.test(badMod) && /shift/.test(badMod),
    String(badMod));
  check("未知修饰键：同样零派发",
    model.dbg.log.filter((e) => e.method === "Input.dispatchKeyEvent").length === 0);

  const { ctx: c4, tabId: t4 } = await boot({ prewarm: false });
  const plus = await c4.cmdPress({ key: "+", tabId: t4 }).then((r) => r, (e) => String(e.message));
  check("单字符 '+' 不被误当成组合串", typeof plus === "object" && plus.key === "+", JSON.stringify(plus));
}

console.log(fails === 0 ? "\n按键派发次数全部符合契约" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
