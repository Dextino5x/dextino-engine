import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/webm"
    ];

    cb(
      allowed.includes(file.mimetype)
        ? null
        : new Error("Unsupported video format"),
      allowed.includes(file.mimetype)
    );
  }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    let errorOutput = "";

    process.stderr.on("data", data => {
      errorOutput += data.toString();
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput || "Processing failed"));
    });
  });
}

async function getDuration(file) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffprobe.path, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);

    let output = "";

    process.stdout.on("data", data => {
      output += data.toString();
    });

    process.on("error", reject);

    process.on("close", code => {
      const duration = Number(output.trim());

      if (code === 0 && Number.isFinite(duration)) {
        resolve(duration);
      } else {
        reject(new Error("Could not read video duration"));
      }
    });
  });
}

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    name: "DEXTINO AI",
    version: "1.0.0"
  });
});

app.post("/api/analyze", upload.single("video"), async (req, res) => {
  let folder;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: "AI service is not configured."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please upload a supported video."
      });
    }

    const software = req.body.software || "CapCut";
    const platform = req.body.platform || "Mobile";

    folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "dextino-")
    );

    const videoPath = path.join(folder, "reference.mp4");
    const framePattern = path.join(folder, "frame-%03d.jpg");

    await fs.writeFile(videoPath, req.file.buffer);

    const duration = await getDuration(videoPath);

    if (duration <= 0 || duration > 60) {
      return res.status(400).json({
        error: "Videos must be between 1 and 60 seconds."
      });
    }

    const fps = Math.min(1, 10 / duration);

    await run(ffmpegPath, [
      "-i", videoPath,
      "-vf", `fps=${fps},scale=640:-1`,
      "-frames:v", "10",
      "-q:v", "4",
      framePattern
    ]);

    const frames = (await fs.readdir(folder))
      .filter(file => file.endsWith(".jpg"))
      .sort();

    if (!frames.length) {
      throw new Error("Could not extract video frames.");
    }

    const content = [{
      type: "input_text",
      text: `
You are DEXTINO AI, an expert video editing analyst.

Analyse this reference edit.

Target software: ${software}
Platform: ${platform}
Video duration: ${duration.toFixed(2)} seconds.

Create a detailed recreation tutorial containing:

1. Editing style overview.
2. Timeline breakdown with timestamps.
3. Cuts and transitions.
4. Motion, zooms and shakes.
5. Colour grading.
6. Text and overlays.
7. Step-by-step recreation instructions.
8. Exact software tools where verified.
9. Free versus paid feature warnings.
10. Confidence ratings for observations.

CRITICAL RULES:
- Never invent software features or menu names.
- Never pretend uncertain settings are confirmed.
- Separate visible evidence from recommendations.
- Explain when more frames or audio analysis are needed.
- Make instructions specific to the selected software.
`
    }];

    for (let i = 0; i < frames.length; i++) {
      const image = await fs.readFile(
        path.join(folder, frames[i])
      );

      const timestamp = (
        i * duration / frames.length
      ).toFixed(1);

      content.push({
        type: "input_text",
        text: `Reference frame ${i + 1}, approximately ${timestamp}s.`
      });

      content.push({
        type: "input_image",
        image_url:
          `data:image/jpeg;base64,${image.toString("base64")}`,
        detail: "high"
      });
    }

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [{
        role: "user",
        content
      }]
    });

    res.json({
      success: true,
      software,
      platform,
      duration,
      framesAnalysed: frames.length,
      analysis: response.output_text
    });

  } catch (error) {
    console.error("DEXTINO AI:", error.message);

    res.status(500).json({
      error: "Analysis failed. Please try again."
    });

  } finally {
    if (folder) {
      await fs.rm(folder, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DEXTINO AI running on port ${PORT}`);
});
