import app from "./src/app";

const PORT = parseInt(process.env.PORT || "8080");

Bun.serve({
  port: PORT,
  fetch: (request) => app.fetch(request, process.env as any),
});

console.log(`indigest listening on http://localhost:${PORT}`);
