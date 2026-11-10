// @vitest-environment node
// Lints fixture snippets with the real eslint.config.js, so the boundary rule is proven to be wired
// in (not only correct in isolation).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: frontend });

async function boundaryErrors(file, code) {
  const [result] = await eslint.lintText(code, { filePath: path.join(frontend, file) });
  return result.messages.filter((m) => m.ruleId === "australis/module-boundaries");
}

describe("eslint.config.js module boundaries", () => {
  it("allows imports between subfolders of one module", async () => {
    const code = 'import { Preview } from "../components/Preview";\nexport const x = Preview;\n';
    expect(await boundaryErrors("src/modules/campus/shaping/ShapingPanel.tsx", code)).toEqual([]);
  });

  it("allows another module through its index", async () => {
    const code = 'import { routes } from "../roster";\nexport const x = routes;\n';
    expect(await boundaryErrors("src/modules/grades/Gradebook.tsx", code)).toEqual([]);
  });

  it("rejects a deep import into a sibling module", async () => {
    const code = 'import { getHealth } from "../health/api";\nexport const x = getHealth;\n';
    const errors = await boundaryErrors("src/modules/grades/Gradebook.tsx", code);
    expect(errors).toHaveLength(1);
  });
});
