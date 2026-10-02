import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const user = {
  id: "1",
  username: "bot",
  discriminator: "0001",
  bot: true,
  global_name: null,
  avatar: null,
  avatar_color: null,
  flags: 0,
};
const partSize = 2 * 1024 * 1024;

export async function startBrowserServer({
  port = 0,
  host = "127.0.0.1",
} = {}) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("scenario.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    sourcemap: "inline",
    target: "es2022",
  });
  const sockets = new Set();
  const uploads = [];
  let sequence = 1;
  let completionCount = 0;
  let pendingUploads = 0;
  let leakedCredentials = false;
  let message;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  const ws = new WebSocketServer({ server });
  const dispatch = (event, data) => {
    for (const socket of sockets) {
      if (socket.readyState === 1)
        socket.send(
          JSON.stringify({ op: 0, t: event, s: ++sequence, d: data }),
        );
    }
  };
  const json = (res, body, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    url.pathname = url.pathname.replace(/^\/v1(?=\/)/, "");
    if (url.pathname === "/") {
      uploads.length = 0;
      completionCount = 0;
      leakedCredentials = false;
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "browser-session=test; SameSite=Lax; Path=/",
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Talos browser tests</title><pre id="output">Running</pre><script type="module" src="/scenario.js"></script>',
      );
      return;
    }
    if (url.pathname === "/scenario.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(bundle.outputFiles[0].contents);
      return;
    }
    if (url.pathname === "/__status") {
      json(res, {
        sockets: sockets.size,
        uploads,
        completionCount,
        pendingUploads,
        leakedCredentials,
      });
      return;
    }
    if (url.pathname === "/__disconnect" && req.method === "POST") {
      for (const socket of sockets) socket.close(1000, "test reconnect");
      json(res, {});
      return;
    }
    if (url.pathname === "/users/@me") {
      json(res, user);
      return;
    }
    if (url.pathname === "/.well-known/fluxer") {
      json(res, {
        endpoints: {
          api_public: url.origin,
          gateway: url.origin.replace(/^http/, "ws"),
        },
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/channels/10/attachments") {
      const request = JSON.parse(await body(req));
      json(res, {
        attachments: request.attachments.map((file) => {
          const base = {
            ...file,
            upload_filename: `temporary-${file.filename}`,
          };
          if (file.filename === "multipart.bin") {
            return {
              ...base,
              upload_mode: "multipart",
              upload_id: "multipart-id",
              part_size: partSize,
              parts: Array.from(
                { length: Math.ceil(file.file_size / partSize) },
                (_, index) => ({
                  part_number: index + 1,
                  upload_url: `${url.origin}/storage/part/${index + 1}`,
                }),
              ),
            };
          }
          return {
            ...base,
            upload_mode: "singlepart",
            upload_url: `${url.origin}/storage/${file.filename === "cancel.bin" ? "cancel" : "single"}`,
          };
        }),
      });
      return;
    }
    if (req.method === "PUT" && url.pathname.startsWith("/storage/")) {
      leakedCredentials ||= Boolean(
        req.headers.authorization || req.headers.cookie,
      );
      pendingUploads++;
      res.once("close", () => {
        pendingUploads--;
      });
      const bytes = await body(req);
      if (url.pathname === "/storage/cancel") return;
      const part = Number(url.pathname.split("/").at(-1));
      const offset = Number.isInteger(part) ? (part - 1) * partSize : 0;
      const valid =
        url.pathname === "/storage/single"
          ? bytes.toString() === "browser upload"
          : bytes.every((value, index) => value === (offset + index) % 251);
      uploads.push({ path: url.pathname, size: bytes.length, valid });
      res.writeHead(valid ? 200 : 400);
      res.end();
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/channels/10/attachments/complete"
    ) {
      const request = JSON.parse(await body(req));
      if (
        uploads.filter((upload) => upload.path.startsWith("/storage/part/"))
          .length !== 5
      )
        throw new Error("Multipart upload completed before all parts arrived");
      if (request.uploads[0]?.upload_id !== "multipart-id")
        throw new Error("Missing multipart upload ID");
      completionCount++;
      json(res, { uploads: [{ upload_filename: "temporary-multipart.bin" }] });
      return;
    }
    if (url.pathname === "/channels/10/messages" && req.method === "POST") {
      const bytes = await body(req);
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.startsWith("multipart/form-data")) {
        const form = await new Response(bytes, {
          headers: { "Content-Type": contentType },
        }).formData();
        const payload = JSON.parse(form.get("payload_json"));
        const attachment = form.get("files[0]");
        if (
          payload.attachments[0]?.filename !== "direct.txt" ||
          (await attachment.text()) !== "direct upload"
        )
          throw new Error("Invalid multipart message upload");
        message = makeMessage(payload.content);
      } else {
        message = makeMessage(JSON.parse(bytes).content);
      }
      json(res, message);
      dispatch("MESSAGE_CREATE", message);
      return;
    }
    if (url.pathname === "/channels/10/messages/20" && req.method === "PATCH") {
      const patch = JSON.parse(await body(req));
      message = { ...message, ...patch };
      json(res, message);
      dispatch("MESSAGE_UPDATE", { id: "20", channel_id: "10", ...patch });
      return;
    }
    if (
      url.pathname === "/channels/10/messages/20" &&
      req.method === "DELETE"
    ) {
      res.writeHead(204);
      res.end();
      dispatch("MESSAGE_DELETE", { id: "20", channel_id: "10" });
      return;
    }
    json(res, { message: "Not found" }, 404);
  }

  function makeMessage(content) {
    return {
      id: "20",
      channel_id: "10",
      author: user,
      content,
      timestamp: "2026-10-02T00:00:00Z",
      type: 0,
      flags: 0,
      pinned: false,
      mention_everyone: false,
      tts: false,
      mentions: [],
      mention_roles: [],
    };
  }

  ws.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on("message", (bytes) => {
      const frame = JSON.parse(bytes);
      if (frame.op === 2)
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: ++sequence,
            d: { session_id: "browser-test", user },
          }),
        );
      else if (frame.op === 6)
        socket.send(
          JSON.stringify({ op: 0, t: "RESUMED", s: ++sequence, d: {} }),
        );
      else if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    origin: `http://${host}:${address.port}`,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => ws.close(resolve));
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
