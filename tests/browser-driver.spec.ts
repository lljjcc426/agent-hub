import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentBrowserDriver } from "../src/browser-driver.ts";
import { browserConfigSchema } from "../src/browser-contract.ts";

it.skipIf(process.platform === "win32")("inserts whole clipboard/IME text through stdin and streams individual characters", async () => {
  const root = mkdtempSync(join(tmpdir(), "roppo-browser-input-"));
  const stream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => stream.on("listening", resolve));
  const port = (stream.address() as { port: number }).port;
  const events: unknown[] = [];
  stream.on("connection", (socket) => socket.on("message", (data) => events.push(JSON.parse(String(data)))));
  const command = join(root, "driver.cjs"), receipt = join(root, "receipt.json");
  writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('stream')) console.log(JSON.stringify({success:true,data:{port:${port}}}));
else {
  const commands = JSON.parse(fs.readFileSync(0,'utf8'));
  fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,commands}));
  console.log(JSON.stringify(commands.map(command=>({command,success:true,result:{inserted:true}}))));
}
`, { mode: 0o700 });
  const driver = new AgentBrowserDriver(root, browserConfigSchema.parse({ command }));
  const session = { id: "input-test", directory: root };
  const close = await driver.frames(session, () => {});
  try {
    for (const text of ["第一行 😀\n第二行 👩‍💻", "你好", "\n"]) {
      await driver.input(session, { type: "text", text });
      const saved = JSON.parse(readFileSync(receipt, "utf8"));
      expect(saved.commands).toEqual([["keyboard", "inserttext", text]]);
      expect(saved.args).not.toContain(text);
    }
    expect(events).toEqual([]);
    await driver.input(session, { type: "text", text: "😀" });
    expect(events).toEqual([{ type: "input_keyboard", eventType: "char", text: "😀", key: "", code: "" }]);
  } finally {
    close();
    await new Promise<void>((resolve) => stream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
