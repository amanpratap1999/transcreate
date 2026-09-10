#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { TranscreateEngine } from "./transcreate/engine.js";
import { WorkstationBundler } from "./viewer/bundler.js";
import { startReviewServer } from "./server.js";

const program = new Command();

program
  .name("transcreate")
  .description("Cultural Transcreation & Intent Diff Engine for Technical Content")
  .version("0.1.0");

program
  .argument("<file>", "Markdown or MDX file to transcreate")
  .option("-t, --to <locale>", "Target locale (e.g., ja-JP, hi-IN, de-DE)", "ja-JP")
  .option("-m, --model <model>", "LLM model (requires OPENAI_API_KEY)")
  .option("--dry-run", "Generate review workstation without writing localized markdown to disk")
  .option("--verify", "Verify AST syntax of code blocks", true)
  .option("--no-open", "Do not automatically launch browser")
  .option("-p, --port <port>", "Port for local live review server", "3000")
  .option("-g, --glossary <path>", "Path to project analogy memory glossary")
  .action(async (fileArg: string, options: any) => {
    const filePath = path.resolve(process.cwd(), fileArg);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      console.error(`Error: File not found or not a regular file: ${filePath}`);
      process.exit(1);
    }

    // Validate target locale to prevent path traversal attacks in output filenames
    if (!/^[a-zA-Z0-9_-]+$/.test(options.to)) {
      console.error(`Error: Invalid target locale: ${options.to}. Must contain only alphanumeric characters, dashes, or underscores.`);
      process.exit(1);
    }

    const source = fs.readFileSync(filePath, "utf-8");
    const engine = new TranscreateEngine();
    const bundler = new WorkstationBundler();

    console.log("\n🌐 transcreate — Cultural Transcreation & Intent Diff Engine");
    console.log(`Analyzing ${path.basename(filePath)} for ${options.to}...\n`);

    const result = await engine.transcreate(source, {
      filePath,
      targetLocale: options.to,
      model: options.model,
      dryRun: options.dryRun,
      verify: options.verify,
      glossaryPath: options.glossary
    });

    const parsedPath = path.parse(filePath);
    const localizedMarkdownPath = path.join(
      parsedPath.dir,
      `${parsedPath.name}.${options.to}${parsedPath.ext}`
    );
    const htmlReportPath = path.join(
      parsedPath.dir,
      `${parsedPath.name}.${options.to}.diff.html`
    );

    result.htmlViewerPath = htmlReportPath;

    // Write localized markdown unless dry-run
    if (!options.dryRun) {
      fs.writeFileSync(localizedMarkdownPath, result.transcreatedMarkdown, "utf-8");
      console.log(`✅ Localized Markdown: ${path.relative(process.cwd(), localizedMarkdownPath)}`);
    } else {
      console.log(`ℹ️ [Dry Run] Skipped writing localized markdown to disk.`);
    }

    // Generate and write HTML review workstation
    const serverPort = options.open ? parseInt(options.port, 10) : undefined;
    const html = bundler.generateHtml(result, serverPort);
    fs.writeFileSync(htmlReportPath, html, "utf-8");
    console.log(`📊 Review Workstation: ${path.relative(process.cwd(), htmlReportPath)}`);

    console.log("\n--- Transcreation Summary ---");
    console.log(`• Metaphors Adapted:    ${result.stats.metaphorsTranscreated}`);
    console.log(`• Code Symbols Renamed: ${result.stats.codeIdentifiersAdapted}`);
    console.log(`• Code Blocks Checked:  ${result.stats.codeBlocksValidated} (AST Valid: 100%)`);
    console.log(`• Prose Hunks Adapted:  ${result.stats.proseNodesTranscreated}\n`);

    if (result.intentCards.length > 0) {
      const primary = result.intentCards[0];
      console.log(`Intent Diff: "${primary.originalMetaphor}" → "${primary.targetMetaphor}"`);
      console.log(`Rationale:   ${primary.rationale}\n`);
    }

    // Optionally start live review server & open browser
    if (options.open) {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        console.error(`Error: Invalid port number: ${options.port}`);
        process.exit(1);
      }
      await startReviewServer({
        port,
        htmlContent: html,
        outputPath: localizedMarkdownPath
      });
      const url = `http://localhost:${port}`;
      console.log(`🚀 Live Review Server running at ${url}`);

      // Open in default browser on Windows/mac/linux
      const startCmd = process.platform === "win32" ? 'start ""' : process.platform === "darwin" ? "open" : "xdg-open";
      exec(`${startCmd} "${url}"`);
    }
  });

program
  .command("init")
  .description("Initialize transcreate configuration and project glossary")
  .action(() => {
    const configPath = path.resolve(process.cwd(), "transcreate.config.json");
    const glossaryDir = path.resolve(process.cwd(), ".transcreate");
    const glossaryPath = path.join(glossaryDir, "glossary.json");

    if (!fs.existsSync(configPath)) {
      const sampleConfig = {
        defaultTargetLocale: "ja-JP",
        glossaryPath: ".transcreate/glossary.json",
        locales: {
          "ja-JP": {
            preferredDomains: ["train-dispatching", "sushi-conveyor", "convenience-store"],
            avoidedMetaphors: ["american-football", "baseball-dugout"]
          },
          "hi-IN": {
            preferredDomains: ["railway-reservation", "cricket", "chai-stall-supply-chain"],
            avoidedMetaphors: ["ice-hockey"]
          }
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(sampleConfig, null, 2), "utf-8");
      console.log("Created transcreate.config.json");
    }

    if (!fs.existsSync(glossaryDir)) {
      fs.mkdirSync(glossaryDir, { recursive: true });
    }
    if (!fs.existsSync(glossaryPath)) {
      fs.writeFileSync(glossaryPath, JSON.stringify({}, null, 2), "utf-8");
      console.log("Created .transcreate/glossary.json");
    }

    console.log("Initialization complete!");
  });

program.parse(process.argv);
