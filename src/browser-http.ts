import type { IncomingMessage, ServerResponse } from "node:http";
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {browserFilename} from './browser-files.ts';
import { z } from "zod";
import {browserInput} from "./browser-input.ts";
import type { Runtime } from "./runtime.ts";
import {
  browserAction,
  profileInput,
  credentialInput,
} from "./browser-contract.ts";

const client = z.string().uuid(),
  lease = z.object({ client, epoch: z.number().int().min(0) }).strict();
export async function browserRequest(
  host: Runtime,
  user: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: () => Promise<any>,
  stillAuthorized: () => boolean,
) {
  const url = new URL(req.url!, "http://localhost"),
    path = url.pathname,
    manager = host.browser;
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const clientId = url.searchParams.has("client")
    ? client.parse(url.searchParams.get("client"))
    : undefined;
  const screenshot=path.match(/^\/api\/browser\/screenshots\/([a-f0-9-]{36})$/);
  if(screenshot&&(req.method==='GET'||req.method==='HEAD')){
    const file=manager.screenshot(user,z.string().uuid().parse(screenshot[1]));
    res.writeHead(200,{'content-type':file.mime,'content-length':file.bytes,'cache-control':'private, no-store','content-disposition':(url.searchParams.get('preview')==='1'?'inline':'attachment')+'; filename="'+file.name+'"','content-security-policy':"default-src 'none'; sandbox"});
    if(req.method==='HEAD')res.end();else await pipeline(createReadStream(file.path),res);
    return;
  }
  if (path === "/api/browser" && req.method === "GET") {
    const conversationId=url.searchParams.has('conversation')?z.string().uuid().parse(url.searchParams.get('conversation')):undefined
    if(conversationId) {
      host.chat.view(conversationId,user);
      await manager.restoreWorkspace(user);
    }
    send(manager.list(user, clientId, conversationId));
    return;
  }
  if (path === "/api/browser/profiles" && req.method === "POST") {
    send(manager.saveProfile(user, profileInput.parse(await body())), 201);
    return;
  }
  if(path==='/api/browser/open'&&req.method==='POST'){
    const input=z.object({client,conversationId:z.string().uuid()}).strict().parse(await body());
    host.chat.view(input.conversationId,user);
    send(await manager.openDefault(user,input.client,input.conversationId));return;
  }
  const profile = path.match(
    /^\/api\/browser\/profiles\/([a-f0-9-]{36})(?:\/(open))?$/,
  );
  if (profile && req.method === "POST") {
    const id = z.string().uuid().parse(profile[1]);
    if (profile[2] === "open") {
      const input = z
        .object({ client, conversationId:z.string().uuid().optional() })
        .strict()
        .parse(await body());
      if(input.conversationId)host.chat.view(input.conversationId,user)
      send(await manager.openPersonal(user, id, input.client,input.conversationId));
    } else
      send(manager.saveProfile(user, profileInput.parse(await body()), id));
    return;
  }
  if (path === "/api/browser/accounts" && req.method === "POST") {
    send(
      manager.saveCredential(user, credentialInput.parse(await body())),
      201,
    );
    return;
  }
  const account = path.match(
    /^\/api\/browser\/accounts\/([a-f0-9-]{36})(?:\/(remove))?$/,
  );
  if (account && req.method === "POST") {
    const id = z.string().uuid().parse(account[1]);
    if (account[2]) {
      manager.removeCredential(user, id);
      send({ removed: true });
    } else
      send(
        manager.saveCredential(user, credentialInput.parse(await body()), id),
      );
    return;
  }
  const session = path.match(
    /^\/api\/browser\/sessions\/([a-f0-9-]{36})(?:\/(stream|takeover|release|renew|action|input|viewport|selection|close|downloads|download|upload-targets|upload))?$/,
  );
  if (session) {
    const id = z.string().uuid().parse(session[1]),
      action = session[2];
    if(action==='downloads'&&req.method==='GET'){send(manager.downloads(user,id));return}
    if(action==='download'&&req.method==='GET'){
      const name=browserFilename.parse(url.searchParams.get('name')),file=manager.download(user,id,name);
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':file.bytes,'cache-control':'private, no-store','content-disposition':"attachment; filename=\"download\"; filename*=UTF-8''"+encodeURIComponent(name),'content-security-policy':"default-src 'none'; sandbox"});
      await pipeline(file.stream,res);return;
    }
    if(action==='upload'&&req.method==='POST'){
      const input=z.object({client,epoch:z.coerce.number().int().min(0),target:z.string().regex(/^[a-f0-9-]{36}-\d+$/),name:browserFilename}).strict().parse(Object.fromEntries(url.searchParams));
      send(await manager.upload(user,id,input.client,input.epoch,input.target,input.name,req,stillAuthorized));return;
    }
    if (!action && req.method === "GET") {
      send(await manager.inspect(user, id, clientId));
      return;
    }
    if (action === "stream" && req.method === "GET") {
      let seq = 0;
      const push = (status = false) => {
        if (!res.headersSent || res.destroyed || res.writableEnded) return;
        if (!stillAuthorized()) {
          res.end();
          return;
        }
        // Slow clients resume at the latest frame on drain, without queueing old JPEGs.
        if (res.writableNeedDrain) return;
        try {
          const frame = manager.frame(user, id);
          if (frame && frame.seq !== seq) {
            seq = frame.seq;
            if (!res.write("event: frame\ndata: " + JSON.stringify(frame) + "\n\n")) return;
          }
          if (status) res.write("event: status\ndata: " +
            JSON.stringify({connected: manager.streamStatus(user, id)}) + "\n\n");
        } catch {
          res.end("event: closed\ndata: {}\n\n");
        }
      };
      const nextFrame = () => push();
      const unsubscribe = await manager.subscribe(user, id, nextFrame);
      if (res.destroyed) {
        unsubscribe();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      const heartbeat = setInterval(() => push(true), 660);
      heartbeat.unref();
      res.on("drain", nextFrame);
      res.once("close", () => {
        clearInterval(heartbeat);
        res.off("drain", nextFrame);
        unsubscribe();
      });
      push(true);
      return;
    }
    if (req.method === "POST") {
      const raw = await body();
      if(action==='upload-targets'){
        const input=lease.parse(raw);send(await manager.uploadTargets(user,id,input.client,input.epoch));return;
      }
      if (action === "takeover") {
        const input = z
          .object({ client, force: z.boolean().default(false) })
          .strict()
          .parse(raw);
        send(await manager.takeover(user, id, input.client, input.force));
        return;
      }
      if (action === "action") {
        const input = lease
          .extend({ operation: browserAction })
          .strict()
          .parse(raw);
        send(
          await manager.action(
            user,
            id,
            input.client,
            input.epoch,
            input.operation,
          ),
        );
        return;
      }
      if (action === "input") {
        const input = lease.extend({ event: browserInput }).strict().parse(raw);
        send(
          await manager.input(user, id, input.client, input.epoch, input.event),
        );
        return;
      }
      if(action==='viewport'){
        const input=lease.extend({width:z.number().int().min(320).max(3840),height:z.number().int().min(200).max(2160)}).strict().parse(raw);
        send(await manager.resize(user,id,input.client,input.epoch,input.width,input.height));return;
      }
      if(action==='selection'){
        const input=lease.parse(raw);
        send(await manager.selection(user,id,input.client,input.epoch));return;
      }
      const input = lease.parse(raw);
      if (action === "release") {
        send(await manager.release(user, id, input.client, input.epoch));
        return;
      }
      if (action === "renew") {
        send(manager.renew(user, id, input.client, input.epoch));
        return;
      }
      if (action === "close") {
        send(await manager.closeOwned(user, id, input.client, input.epoch));
        return;
      }
    }
  }
  send({ code: "not_found" }, 404);
}
