import { startBrowserServer } from "../tests/browser/server.mjs";

const server = await startBrowserServer({
  port: Number(process.env.PORT ?? 8707),
});
console.log(`Browser tests: ${server.origin}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
