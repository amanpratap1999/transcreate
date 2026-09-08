import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ServerOptions {
  port: number;
  htmlContent: string;
  outputPath: string;
}

export function startReviewServer(options: ServerOptions): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Restrict CORS to local origins only (prevents drive-by web browser attacks)
      const origin = req.headers.origin;
      const isAllowedOrigin =
        !origin ||
        origin === "null" ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:");

      if (!isAllowedOrigin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: cross-origin request rejected" }));
        return;
      }

      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(options.htmlContent);
        return;
      }

      if (req.method === "POST" && req.url === "/api/save") {
        let body = "";
        req.on("data", chunk => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.markdown) {
              const saveTarget = options.outputPath;
              fs.writeFileSync(saveTarget, data.markdown, "utf-8");
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, savedPath: saveTarget }));
              return;
            }
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing markdown payload" }));
          } catch (err: unknown) {
            const error = err as Error;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    server.listen(options.port, () => {
      resolve(server);
    });

    server.on("error", reject);
  });
}
